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
 * 1. One `ssh` call reads the server-side source revision (when the declaration asks).
 * 2. One `ssh` call runs the recipe in the declared project directory.
 * 3. One `ssh` call streams the named products back as a `tar.gz`, expanded locally.
 *
 * The seam moves bytes in one direction only — products come back, source never
 * goes out. A tree that already lives on the build machine is not something this
 * module could usefully copy: an automotive checkout is hundreds of gigabytes,
 * and copying it per run would cost more than the build.
 * @module @deepseek-ai/dsh-yxspec-remote/ssh
 */

import { createWriteStream } from 'node:fs'
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

/** Where a fetched archive is written before it is extracted. */
export interface FetchTarget {
  /** Absolute local directory the archive is written to. */
  readonly archivePath: string
  /** Byte ceiling for this transfer; the transfer is aborted past it. */
  readonly maxBytes: number
}

/** What one fetch produced, as the caller reports it. */
export interface FetchedArchive {
  /** Bytes written to {@link FetchTarget.archivePath}. */
  readonly bytes: number
  /** What the client or the remote tool reported, when the transfer failed; absent on success. */
  readonly error?: string
}

/**
 * Stream the named server paths back as one `.tar.gz`.
 *
 * The archive travels as a byte stream on the client's stdout rather than as a
 * copied tree, for the same reason the upload path once used stdin: one streamed
 * archive is one round trip regardless of file count.
 *
 * `--` before the paths and `-C` before the directory keep a product name from
 * being read as an option, and the caller has already refused names that could
 * escape the output directory. The byte ceiling is enforced while writing, so an
 * accidental `out/` of a whole tree stops the transfer instead of filling the
 * disk.
 * @param runtime - the subprocess provider a child is started on.
 * @param sshExecutable - resolved OpenSSH client.
 * @param destination - OpenSSH destination.
 * @param outputDirectory - absolute server directory the paths are relative to.
 * @param paths - product paths relative to that directory.
 * @param target - local archive path and byte ceiling.
 * @param options - cancellation and deadline.
 * @returns the bytes written and any failure the client reported.
 */
export async function fetchArchive(
  runtime: SubprocessSpawn,
  sshExecutable: string,
  destination: string,
  outputDirectory: string,
  paths: readonly string[],
  target: FetchTarget,
  options: { timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<FetchedArchive> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  const command = [
    'set -e',
    `cd '${outputDirectory}'`,
    `tar -czf - -- ${paths.map(path => `'${path}'`).join(' ')}`,
  ].join('; ')
  const handle = runtime.spawn({
    argv: [sshExecutable, ...sshArgv(destination, command)],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: { maxBytes: STDERR_TAIL_BYTES },
    },
    graceMs: TERMINATE_GRACE_MS,
    signal,
  })
  const output = handle.stdout
  /* v8 ignore next 3 -- `stdout: 'pipe'` always yields a readable. */
  if (output === undefined) {
    handle.terminate()
    throw new Error('subprocess provider did not expose the pipe requested for the archive stream')
  }
  const sink = createWriteStream(target.archivePath)
  let bytes = 0
  let overflow = false
  try {
    await new Promise<void>((resolve, reject) => {
      output.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > target.maxBytes) {
          overflow = true
          // Destroying the stream rather than the handle: the transfer stops, and the
          // settle below still reads the client's own exit facts and stderr tail.
          output.destroy()
          handle.terminate()
          return
        }
        sink.write(chunk)
      })
      output.on('error', reject)
      sink.on('error', reject)
      output.on('end', () => { resolve() })
    })
  } finally {
    await new Promise<void>((resolve) => { sink.end(resolve) })
  }
  const outcome = await settled(handle)
  if (overflow) {
    return {
      bytes,
      error: `the products exceed the ${String(target.maxBytes)}-byte fetch ceiling; `
        + 'name fewer or smaller paths',
    }
  }
  if (outcome.exitCode !== 0) {
    return { bytes, error: outcome.stderr.trim() || `remote tar exited ${String(outcome.exitCode)}` }
  }
  return { bytes }
}

/**
 * Extract a fetched archive into a local directory.
 * @param runtime - the subprocess provider a child is started on.
 * @param tarExecutable - resolved archive tool.
 * @param archivePath - the local archive to expand.
 * @param into - absolute local directory to expand into; it must exist.
 * @param options - cancellation.
 * @throws when the local extraction fails.
 */
export async function extractArchive(
  runtime: SubprocessSpawn,
  tarExecutable: string,
  archivePath: string,
  into: string,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<void> {
  const result = await runLocal(runtime, [tarExecutable, '-xzf', archivePath, '-C', into], {
    cwd: into,
    signal: options.signal,
  })
  if (result.exitCode !== 0) {
    throw new Error(`tar failed (exit ${String(result.exitCode)}): ${(result.stderr || result.stdout).trim()}`)
  }
}
