/**
 * The SSH client plumbing for the remote build seam.
 *
 * Windows cannot host dsh's own SSH runtime (`packages/ssh/ssh` refuses any
 * client that is not Linux or macOS), so this module takes the other road: it
 * invokes the platform's own OpenSSH client once per step and reads the exit
 * facts back through `ctx.subprocess`. That is not a workaround with a shorter
 * lifespan than the real seam — routing through the user's own client is what
 * makes their existing `~/.ssh/config`, keys, agent, and jump hosts apply
 * unchanged, and it keeps every credential out of the harness.
 *
 * Three steps, each independently diagnosable:
 * 1. `tar` archives the local tree to a temporary file (exclusions applied).
 * 2. One `ssh` call pipes that archive into a server-side `tar -x`.
 * 3. One `ssh` call runs the recipe in the extracted tree.
 *
 * The archive travels as a byte stream over the client's stdin, never as a
 * command argument: a tree that does not fit in `ARG_MAX` is the normal case,
 * not an edge one.
 * @module @deepseek-ai/dsh-yxspec-remote/ssh
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/**
 * The subprocess capability that locates an executable on this host.
 *
 * Declared as the verb actually called rather than as the whole service, so a caller — and a
 * spec's recording double — supplies exactly what is used and the production runtime satisfies
 * it unchanged.
 */
export type SubprocessLookup = Pick<SubprocessRuntime, 'resolveExecutable'>

/**
 * The subprocess capability that runs one command to completion.
 *
 * Narrowed to `spawn` for the same reason as {@link SubprocessLookup}: the transports own the
 * termination ladder and the output caps themselves, so the runtime's other verbs are neither
 * called nor worth requiring of a double.
 */
export type SubprocessSpawn = Pick<SubprocessRuntime, 'spawn'>

/** Grace period handed to the subprocess provider's termination ladder. */
const TERMINATE_GRACE_MS = 5_000

/** stderr kept for a diagnostic tail; a build's noise belongs on stdout. */
const STDERR_TAIL_BYTES = 64 * 1024

/** One finished local command. */
export interface LocalCommandResult {
  /** Exit code, or `null` when the process died from a signal. */
  readonly exitCode: number | null
  /** Collected stdout text (possibly tail-truncated). */
  readonly stdout: string
  /** Collected stderr tail. */
  readonly stderr: string
  /** True when stdout lost its head to the byte cap. */
  readonly stdoutTruncated: boolean
}

/** One finished remote command, as the client observed it. */
export interface RemoteCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
}

/** One settled handle's exit facts and collected output. */
interface SettledOutput {
  /** Exit code, or `null` when the process died from a signal. */
  readonly exitCode: number | null
  /** Collected stdout text and whether it lost its head to the byte cap. */
  readonly stdout: { readonly text: string; readonly lossy: boolean }
  /** Collected stderr tail. */
  readonly stderr: string
}

/**
 * Await one spawned command and read back its exit facts and collected output.
 *
 * Every transport here settles the same way, and these two reads are the only
 * place `collected` is touched at all, so one helper is what keeps each caller
 * differing only in the result shape it returns — rather than repeating the
 * settle protocol once per transport and letting the three drift apart.
 * @param handle - the spawned command to await and read.
 * @returns the exit code and both collected streams.
 */
async function settled(handle: SubprocessHandle): Promise<SettledOutput> {
  const outcome = await handle.done
  /* v8 ignore start -- collect-mode stdio always yields both string readers. */
  const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  /* v8 ignore stop */
  return { exitCode: outcome.exitCode, stdout, stderr }
}

/**
 * Resolve the OpenSSH client to drive. A deployment that must pin a client
 * names it in configuration; otherwise the platform location is probed, and a
 * missing client fails loud rather than falling back to something else.
 * @param configured - absolute path or bare name from configuration.
 * @param runtime - the subprocess provider whose executable lookup is used.
 * @returns the canonical executable path.
 */
export async function resolveSshExecutable(
  configured: string | undefined,
  runtime: SubprocessLookup,
): Promise<string> {
  const pinned = usable(configured)
  const candidates = pinned !== undefined
    ? [pinned]
    : process.platform === 'win32'
      ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\OpenSSH\\ssh.exe`, 'ssh']
      : ['ssh']
  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      return await runtime.resolveExecutable(candidate)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    `no OpenSSH client found; set sshExecutable in the server declaration. Tried ${failures.join('; ')}`,
  )
}

/**
 * Resolve the archive tool. Windows ships `bsdtar` and a Git installation ships
 * GNU tar; both accept the flag set used here.
 * @param configured - absolute path or bare name from configuration.
 * @param runtime - the subprocess provider whose executable lookup is used.
 * @returns the canonical executable path.
 */
export async function resolveTarExecutable(
  configured: string | undefined,
  runtime: SubprocessLookup,
): Promise<string> {
  const pinned = usable(configured)
  if (pinned !== undefined) return await runtime.resolveExecutable(pinned)
  const candidates = process.platform === 'win32'
    ? [`${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\tar.exe`, 'tar']
    : ['tar']
  for (const candidate of candidates) {
    try {
      return await runtime.resolveExecutable(candidate)
    } catch (_candidateUnavailable) {
      // Try the next location; the final failure reports them all.
    }
  }
  throw new Error('no tar executable found; set tarExecutable in the plugin configuration')
}

/**
 * A configured value, or `undefined` when it carries no configuration.
 *
 * Schemastery materializes a bare `z.string()` as `''`, so an unset
 * configuration entry arrives as an empty string rather than as absent. Treating
 * `''` as configured would hand `resolveExecutable('')` an unresolvable name and
 * turn "use the platform default" into "no client found".
 * @param value - the raw configuration value.
 * @returns the trimmed value, or `undefined` when unset.
 */
function usable(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

/**
 * Run one local command to completion.
 * @param runtime - the subprocess provider a child is started on.
 * @param argv - program and arguments; never shell-interpreted.
 * @param options - working directory, cancellation, and output budget.
 * @returns exit facts and collected output.
 */
export async function runLocal(
  runtime: SubprocessSpawn,
  argv: readonly string[],
  options: {
    cwd: string
    signal?: AbortSignal | undefined
    maxBytes?: number
    env?: NodeJS.ProcessEnv | undefined
  },
): Promise<LocalCommandResult> {
  const handle: SubprocessHandle = runtime.spawn({
    argv,
    cwd: options.cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxBytes ?? 8 * 1024 * 1024 },
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: TERMINATE_GRACE_MS,
    signal: options.signal,
    ...options.env === undefined ? {} : { env: options.env },
  })
  const outcome = await settled(handle)
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr,
    stdoutTruncated: outcome.stdout.lossy,
  }
}

/**
 * The SSH options every invocation carries.
 *
 * `BatchMode=yes` is the load-bearing one: without it a missing key turns into
 * an interactive password prompt, and the run hangs until the timeout instead
 * of failing with a usable message. `ConnectTimeout` bounds the handshake so the
 * user's own `~/.ssh/config` values still apply as a floor rather than being
 * overridden.
 */
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'] as const

/**
 * Build the full `ssh` argument vector for one remote command.
 * @param destination - OpenSSH destination (a `Host` alias or `user@host`).
 * @param command - the remote command text, passed as a single argument.
 * @returns the argv to hand to the subprocess service.
 */
export function sshArgv(destination: string, command: string): readonly string[] {
  return [...SSH_OPTIONS, '--', destination, command]
}

/**
 * Run one command on the server and collect its output.
 * @param runtime - the subprocess provider a child is started on.
 * @param sshExecutable - resolved OpenSSH client.
 * @param destination - OpenSSH destination.
 * @param command - remote command text.
 * @param options - cancellation, timeout, and output budget.
 * @returns exit facts, bounded output, and whether the deadline fired.
 */
export async function runRemote(
  runtime: SubprocessSpawn,
  sshExecutable: string,
  destination: string,
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; maxBytes?: number },
): Promise<RemoteCommandResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const handle = runtime.spawn({
    argv: [sshExecutable, ...sshArgv(destination, command)],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: options.maxBytes ?? 4 * 1024 * 1024 },
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: TERMINATE_GRACE_MS,
    signal,
  })
  const outcome = await settled(handle)
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr,
    truncated: outcome.stdout.lossy,
    timedOut: timeout.aborted,
  }
}

/** One created archive: its path, byte size, and content digest. */
export interface TreeArchive {
  /** Absolute path to the temporary archive. */
  readonly path: string
  /** Archive size in bytes. */
  readonly bytes: number
  /** SHA-256 of the archive, the run's input identity. */
  readonly digest: string
  /** Remove the archive and its staging directory. */
  readonly dispose: () => Promise<void>
}

/**
 * Archive a local directory into a temporary `.tar.gz`.
 *
 * The archive is a portable `tar.gz` rather than a copied tree because a copy
 * would need per-file remote calls; one streamed archive is one round trip
 * regardless of file count. Exclusions are passed to `tar` itself so a large
 * ignored subtree is never read.
 * @param runtime - the subprocess provider a child is started on.
 * @param tarExecutable - resolved archive tool.
 * @param sourceDirectory - absolute directory to archive.
 * @param excludes - directory/file patterns to omit.
 * @param options - cancellation.
 * @returns the staged archive and its digest.
 * @throws when archiving fails; the staging directory is removed first.
 */
export async function archiveTree(
  runtime: SubprocessSpawn,
  tarExecutable: string,
  sourceDirectory: string,
  excludes: readonly string[],
  options: { signal?: AbortSignal | undefined } = {},
): Promise<TreeArchive> {
  const info = await stat(sourceDirectory)
  if (!info.isDirectory()) throw new Error(`not a directory: ${sourceDirectory}`)

  const staging = await mkdtemp(join(tmpdir(), 'dsh-yxspec-remote-'))
  const archivePath = join(staging, 'tree.tar.gz')
  const exclusionArgs: string[] = []
  for (const pattern of excludes) {
    if (pattern.length === 0) continue
    exclusionArgs.push('--exclude', pattern)
  }
  const result = await runLocal(
    runtime,
    [tarExecutable, '-czf', archivePath, ...exclusionArgs, '-C', sourceDirectory, '.'],
    { cwd: staging, signal: options.signal },
  ).catch(async (error: unknown) => {
    await rm(staging, { recursive: true, force: true })
    throw error
  })
  if (result.exitCode !== 0) {
    await rm(staging, { recursive: true, force: true })
    throw new Error(
      `tar failed (exit ${String(result.exitCode)}): ${(result.stderr || result.stdout).trim()}`,
    )
  }

  const digest = await digestFile(archivePath)
  const archived = await stat(archivePath)
  return {
    path: archivePath,
    bytes: archived.size,
    digest,
    dispose: async () => { await rm(staging, { recursive: true, force: true }) },
  }
}

/** SHA-256 of a file, read as a stream so a large archive never lands in memory. */
async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => { hash.update(chunk) })
      .on('error', reject)
      .on('end', () => { resolve() })
  })
  return hash.digest('hex')
}

/**
 * Extract a staged archive on the server.
 *
 * The archive arrives on the client's stdin, which the subprocess service
 * exposes as a real byte channel, so the payload is never re-encoded as text
 * and never appears in the process argument list.
 * @param runtime - the subprocess provider a child is started on.
 * @param sshExecutable - resolved OpenSSH client.
 * @param destination - OpenSSH destination.
 * @param remoteDirectory - absolute server directory to extract into.
 * @param archivePath - the local archive file.
 * @param options - cancellation and deadline.
 * @returns exit facts; a nonzero exit means nothing usable was extracted.
 */
export async function pushArchive(
  runtime: SubprocessSpawn,
  sshExecutable: string,
  destination: string,
  remoteDirectory: string,
  archivePath: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<RemoteCommandResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  // `set -e` makes the extraction the command's verdict; `rm -rf` first keeps a
  // previous run's leftovers from surviving into this one.
  const command = `set -e; rm -rf -- '${remoteDirectory}'; mkdir -p -- '${remoteDirectory}'; tar -xzf - -C '${remoteDirectory}'`
  const handle = runtime.spawn({
    argv: [sshExecutable, ...sshArgv(destination, command)],
    cwd: process.cwd(),
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: 256 * 1024 },
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: TERMINATE_GRACE_MS,
    signal,
  })
  const stdin = handle.stdin
  /* v8 ignore next 3 -- `stdin: 'pipe'` always yields a writable. */
  if (stdin === undefined) {
    handle.terminate()
    throw new Error('subprocess provider did not expose the pipe requested for the archive stream')
  }
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(archivePath)
    source.on('error', reject)
    stdin.on('error', reject)
    stdin.on('finish', () => { resolve() })
    source.pipe(stdin)
  }).catch((error: unknown) => {
    handle.terminate()
    throw error
  })
  const outcome = await settled(handle)
  return {
    exitCode: outcome.exitCode,
    stdout: outcome.stdout.text,
    stderr: outcome.stderr,
    truncated: outcome.stdout.lossy,
    timedOut: timeout.aborted,
  }
}
