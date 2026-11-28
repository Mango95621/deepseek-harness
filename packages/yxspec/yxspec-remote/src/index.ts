/**
 * The remote build seam (`ctx.yxspecRemote`): declared build servers and the
 * compile/verify runs executed against them.
 *
 * The model is a **remote compile verification point**. A run SSHes to a machine
 * that already holds the checkout, executes one named recipe inside the declared
 * project directory, and returns the log and exit code; the products it names
 * come back as an archive. Source is never uploaded: an automotive tree is
 * hundreds of gigabytes, and a seam that copied one per run would be unusable on
 * exactly the projects it exists for. The server-side tree stays the operator's —
 * this seam never creates, replaces, or deletes it, and a declaration that names
 * a directory which is not there fails rather than making one.
 *
 * Three design consequences worth stating, because they are what make this a
 * program rather than a command wrapper:
 *
 * - **Recipes are declared, not typed.** A run names a recipe id from the
 *   server's own map; the model cannot invent a command line to execute on
 *   someone's build server. The recipe map is the allowlist.
 * - **Every run is recorded.** Exit code, source revision, log digest, command,
 *   and duration land in a storage domain, because "the build passed" is ASPICE
 *   evidence and an agent transcript is not an evidence store.
 * - **Products come back through one named directory.** A fetch is relative to the
 *   declared output directory and cannot name a path outside it, so returning
 *   build output never becomes a way to read arbitrary files off the machine.
 *
 * The Windows constraint that shaped the transport lives in `./ssh.ts`.
 * @module @deepseek-ai/dsh-yxspec-remote
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  extractArchive,
  fetchArchive,
  resolveSshExecutable,
  resolveTarExecutable,
  runRemote,
} from './ssh.ts'
import type { RemoteCommandResult } from './ssh.ts'
import {
  remoteDomainSpec,
  serverKey,
  type RemoteRecipeRecord,
  type RemoteRunRecord,
  type RemoteServerRecord,
} from './spec.ts'
// Reaching these by internal path keeps the plugin entry to the Loader's four
// exports plus the Service class; a same-package test imports them the same way.
import { renderRecipe } from './recipe.ts'
import type {
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteFetched,
  YxspecRemoteProbe,
  YxspecRemoteRunRequest,
  YxspecRemoteRunResult,
  YxspecRemoteServer,
} from './types.ts'

export type {
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteFetched,
  YxspecRemoteProbe,
  YxspecRemoteRunRequest,
  YxspecRemoteRunResult,
  YxspecRemoteServer,
  YxspecRemoteTransport,
} from './types.ts'
export type { RemoteRunRecord, RemoteServerRecord } from './spec.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Local `ssh` to invoke when a declaration names none; the platform default is probed when absent.
   *
   * A deployment pins this to name the client every server should use — a bundled OpenSSH, or a
   * wrapper of its own. The wrapper is how a password-only build host is reachable without this
   * seam ever holding a credential: the client it points at receives the same argv the platform
   * client would and supplies the password from wherever the deployment keeps it (an OS keychain,
   * a file only that user can read), while the declaration stays a destination and nothing secret
   * enters durable state that the audited agent can read.
   */
  sshExecutable?: string
  /** Absolute local `tar` to use for expanding fetched products; the platform default is probed when absent. */
  tarExecutable?: string
  /** Output budget for a run's log, in bytes. */
  logMaxBytes?: number
  /**
   * Wall-clock budget for one probe, in milliseconds.
   *
   * A connection test that can outlive a build is not a connection test, so this is its own
   * bound rather than the declaration's per-run budget; a run still uses the larger of the two
   * only if the declaration is genuinely shorter. A deployment behind a slow jump host raises
   * this, or the SSH client's own `ConnectTimeout` in its `~/.ssh/config`.
   */
  probeTimeoutMs?: number
  /**
   * Byte ceiling for one fetch.
   *
   * A build's products are the caller's to name, and naming a whole product tree by accident is
   * one keystroke away, so the cap is enforced while the archive streams rather than after it
   * lands on disk. A deployment that returns release images raises it deliberately.
   */
  fetchMaxBytes?: number
}

/** Schemastery configuration for the remote build seam. */
export const Config: z<Config> = z.object({
  sshExecutable: z.string(),
  tarExecutable: z.string(),
  logMaxBytes: z.natural().default(2 * 1024 * 1024),
  probeTimeoutMs: z.natural().default(60 * 1000),
  fetchMaxBytes: z.natural().default(512 * 1024 * 1024),
})

export const name = 'yxspec-remote'
export const inject = ['subprocess', 'storageDomain']

/**
 * The remote build service. Owns declarations, executes recipes, and records
 * every run.
 */
export class YxspecRemoteService extends Service {
  /**
   * Declared on the class because cordis reads the *class's* metadata when it
   * pragmatically mounts one. The class is reachable that way so a host can
   * mount `YxspecRemoteService` directly and get the service without the tools,
   * and the module-level `inject` below is what the loader reads — the same two
   * services, because the model-facing tools live in a sibling plugin
   * (`@deepseek-ai/dsh-yxspec-remote/tools`) that this row no longer needs.
   */
  static inject = ['subprocess', 'storageDomain']

  /** Let a direct `ctx.plugin(YxspecRemoteService, config)` validate its config. */
  static Config = Config

  private readonly config: Required<Pick<Config, 'logMaxBytes' | 'probeTimeoutMs' | 'fetchMaxBytes'>>
    & { readonly tarExecutable: string | undefined; readonly sshExecutable: string | undefined }
  private servers?: KvTable<string, RemoteServerRecord>
  private runs?: KvTable<string, RemoteRunRecord>
  private readonly sshCache = new Map<string, string>()
  private tarCache?: string
  private readonly opening: Promise<void>

  /**
   * @param ctx - the owning context.
   * @param config - resolved configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'yxspecRemote')
    this.config = {
      logMaxBytes: config.logMaxBytes ?? 2 * 1024 * 1024,
      probeTimeoutMs: config.probeTimeoutMs ?? 60 * 1000,
      fetchMaxBytes: config.fetchMaxBytes ?? 512 * 1024 * 1024,
      // Schemastery materializes an unset `z.string()` as `''`; normalizing here
      // keeps "unset" distinguishable from "configured" at every read site.
      tarExecutable: emptyToUndefined(config.tarExecutable),
      sshExecutable: emptyToUndefined(config.sshExecutable),
    }
    // Opened from the constructor rather than `[Service.init]` so a tool call
    // racing startup awaits one shared promise instead of observing an
    // undefined table; every public method awaits `ready` first.
    this.opening = this.open()
  }

  /** Resolution of the domain open; awaited by every public method. */
  get ready(): Promise<void> {
    return this.opening
  }

  private async open(): Promise<void> {
    const domain: Domain<typeof remoteDomainSpec> = await this.ctx.storageDomain.open(remoteDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'yxspec-remote.domainClose')
    this.servers = domain.table('servers')
    this.runs = domain.table('runs')
  }
  /**
   * Declare (or replace) a build server for one project.
   * @param workspaceId - the owning project.
   * @param server - the declaration; its `id` is the key within the project.
   * @param now - ISO-8601 stamp; defaults to the current instant.
   * @returns the stored record.
   */
  async declare(
    workspaceId: string,
    server: YxspecRemoteServer,
    now: string = new Date().toISOString(),
  ): Promise<RemoteServerRecord> {
    await this.ready
    validateServer(server)
    // Each recipe's directories are normalized but never resolved: an operator who left one to the
    // default gets that default resolved per run, so a deployment that moves the default is not
    // contradicted by every declaration written before the move.
    const recipes = Object.fromEntries(Object.entries(server.recipes).map(([id, recipe]) => [
      id,
      {
        command: recipe.command,
        ...recipe.outputDirectory === undefined
          ? {}
          : { outputDirectory: normalizeRemoteDirectory(recipe.outputDirectory) },
      },
    ]))
    const record: RemoteServerRecord = {
      workspaceId,
      serverId: server.id,
      title: server.title,
      destination: server.destination,
      projectDirectory: normalizeRemoteDirectory(server.projectDirectory),
      ...server.captureRevision === true ? { captureRevision: true } : {},
      transport: server.transport,
      recipes,
      ...server.sshExecutable === undefined ? {} : { sshExecutable: server.sshExecutable },
      timeoutMs: server.timeoutMs,
      declaredAt: now,
    }
    await this.table().put(serverKey(workspaceId, server.id), record)
    return record
  }

  /**
   * Remove a declaration. Recorded runs stay: they are evidence of work that
   * happened, and deleting the server does not un-happen the build.
   * @param workspaceId - the owning project.
   * @param serverId - the declaration to remove.
   * @returns true when a declaration existed.
   */
  async forget(workspaceId: string, serverId: string): Promise<boolean> {
    await this.ready
    return await this.table().delete(serverKey(workspaceId, serverId))
  }

  /**
   * The servers one project declared, in declaration order.
   * @param workspaceId - the project to list.
   * @returns the stored declarations.
   */
  async list(workspaceId: string): Promise<readonly RemoteServerRecord[]> {
    await this.ready
    const out: RemoteServerRecord[] = []
    for (const [, record] of this.table().entries()) {
      if (record.workspaceId === workspaceId) out.push(record)
    }
    return out.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt))
  }

  /**
   * Resolve one declaration.
   * @param workspaceId - the owning project.
   * @param serverId - the server id within that project.
   * @returns the record, or `undefined` when the project declares no such server.
   */
  async server(workspaceId: string, serverId: string): Promise<RemoteServerRecord | undefined> {
    await this.ready
    return this.table().get(serverKey(workspaceId, serverId))
  }

  /**
   * Probe a declared server: SSH handshake, platform, and whether the declared
   * directories are there.
   *
   * A probe never throws for an unreachable server — reachability is the value
   * being reported, and a caller rendering a picker needs the negative answer as
   * much as the positive one. It throws only when the project declares no such
   * server, which is a caller mistake rather than a connectivity fact.
   *
   * The project directory is read, never created: a declaration naming a tree
   * that is not there is a misconfiguration to report, and a probe that made an
   * empty directory would turn it into a run that compiles nothing. The output
   * directory is only reported — a build creates it — so its absence is a fact
   * about the machine, not a failure of the probe.
   * @param workspaceId - the owning project.
   * @param serverId - the server to probe.
   * @param signal - cancellation.
   * @returns the probe outcome.
   * @throws when the project declares no such server.
   */
  async probe(
    workspaceId: string,
    serverId: string,
    signal?: AbortSignal,
  ): Promise<YxspecRemoteProbe> {
    const record = await this.require(workspaceId, serverId)
    // No recipe ran: the probe reports the directory a recipe that names none would use.
    const directories = this.directoriesOf(record, undefined)
    let ssh: string
    try {
      ssh = await this.sshExecutable(record)
    } catch (error) {
      return await this.settleProbe(workspaceId, record, { reachable: false, error: messageOf(error) })
    }
    // One round trip answers every question the probe reports. `set -e` plus an explicit exit keeps
    // a missing project directory from reading as a successful probe of a machine that has nothing
    // to build.
    const command = [
      'set -e',
      'uname -s',
      // A declared server path is written by a person, and the machine it names is usually reachable
      // under another name too — the share the operator browses it through. When the declared
      // directory is missing, the same path under the login directory is tried, because that is the
      // one substitution that turns "no such directory" into the path to declare instead.
      `if [ -d '${directories.cwd}' ]; then echo PROJECT_OK;`
      + ' else echo PROJECT_MISSING; echo "HOME=$HOME";'
      + ' [ -d "$HOME' + directories.cwd + '" ] && echo "ALT=$HOME' + directories.cwd + '" || true; fi',
      `[ -d '${directories.out}' ] && echo OUT_OK || echo OUT_MISSING`,
    ].join('; ')
    const ran = await runRemote(this.ctx.subprocess, ssh, record.destination, command, {
      // A probe is a diagnostic, so it takes the probe budget rather than the build's: a wrong
      // destination should answer in seconds, and a fifteen-minute wait is not an answer. A
      // declaration that asked for less than that still gets what it asked for.
      timeoutMs: Math.min(record.timeoutMs, this.config.probeTimeoutMs),
      signal,
      maxBytes: 64 * 1024,
    }).catch((error: unknown) => ({ failed: error }) as const)
    if ('failed' in ran) {
      return await this.settleProbe(workspaceId, record, { reachable: false, error: messageOf(ran.failed) })
    }
    // The transport's own deadline flag decides before the exit code does: a client the timeout cut
    // off may still report a status of its own, and "the machine answered" cannot rest on that.
    if (ran.timedOut) {
      return await this.settleProbe(workspaceId, record, { reachable: false, error: describeFailure(ran, ssh) })
    }
    if (ran.stdout.includes('PROJECT_MISSING')) {
      return await this.settleProbe(workspaceId, record, {
        reachable: false,
        error: missingDirectoryMessage(directories.cwd, record.destination, ran.stdout),
      })
    }
    if (ran.exitCode !== 0) {
      return await this.settleProbe(workspaceId, record, { reachable: false, error: describeFailure(ran, ssh) })
    }
    const lines = ran.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
    const platform = lines.find(line => line !== 'OUT_OK' && line !== 'OUT_MISSING')
    const outputPresent = ran.stdout.includes('OUT_OK')
    // `lastPlatform` is kept rather than rewritten from this answer alone: a machine that
    // answered yesterday and is unreachable today is still the same platform.
    return await this.settleProbe(workspaceId, {
      ...record,
      ...platform === undefined ? {} : { lastPlatform: platform },
    }, {
      reachable: true,
      outputPresent,
      ...platform === undefined ? {} : { platform },
    })
  }

  /**
   * Record one probe outcome on the declaration and return it.
   *
   * Every exit from a probe goes through here, so the row a list renders always describes the
   * last attempt: `lastProbeAt` moves on success and failure alike, `lastProbeError` is written
   * when one failed and dropped when one succeeded, and `lastPlatform` keeps whatever a probe
   * has observed so far — a machine that answered yesterday and is unreachable today is still a
   * Linux box, and clearing it would only lose information.
   * @param workspaceId - the owning project.
   * @param record - the declaration as the probe left it, platform included.
   * @param outcome - what the probe concluded, without the server id.
   * @returns the probe outcome as the caller receives it.
   */
  private async settleProbe(
    workspaceId: string,
    record: RemoteServerRecord,
    outcome: Omit<YxspecRemoteProbe, 'serverId'>,
  ): Promise<YxspecRemoteProbe> {
    const { error, ...rest } = outcome
    // The previous failure is dropped rather than overwritten: one write, and a row can never
    // carry an old attempt's error beside the current attempt's success.
    const { lastProbeError: _previous, ...carried } = record
    await this.table().put(serverKey(workspaceId, record.serverId), {
      ...carried,
      lastProbeAt: new Date().toISOString(),
      ...error === undefined ? {} : { lastProbeError: error },
    })
    return { serverId: record.serverId, ...rest, ...error === undefined ? {} : { error } }
  }

  /**
   * List the directories under one path on a server, for the wizard's directory picker.
   *
   * One round trip: `cd` into the requested directory (or the login directory when none was named),
   * print where that landed, and list the directories under it. The shell's own answer is the truth
   * here — home is whatever the login shell says it is, and a path that only resolves inside a
   * profile is still the one the operator means.
   *
   * An empty listing is an answer, not an exception: a directory with no children, a path that is
   * not there, and a client that refused to start are three states a picker renders differently, so
   * each comes back as `error` beside whatever the listing did produce. Nothing is stored and
   * nothing outside the named directory is read.
   * @param request - the destination, the directory to list, and optional client and budget.
   * @param signal - cancellation.
   * @returns the listing, with `error` set when it could not be produced.
   * @throws when the request names a directory that is not absolute, which is a caller mistake.
   */
  async browse(request: YxspecRemoteBrowseRequest, signal?: AbortSignal): Promise<YxspecRemoteBrowse> {
    const wanted = request.directory
    if (wanted !== undefined && !isAbsoluteRemotePath(wanted)) {
      throw new Error(`browse directory must be an absolute server path, got '${wanted}'`)
    }
    const depth = Math.min(Math.max(request.depth ?? BROWSE_DEPTH_DEFAULT, 1), BROWSE_DEPTH_MAX)
    const empty = (error: string): YxspecRemoteBrowse => ({
      directory: wanted ?? '',
      entries: [],
      depth,
      truncated: false,
      error,
    })
    let ssh: string
    try {
      ssh = await this.clientFor(request.sshExecutable)
    } catch (error) {
      return empty(messageOf(error))
    }
    // `cd` with no argument goes to the login directory, and it is the only way to reach it: a `~`
    // inside the quotes below would be a literal tilde rather than the shell expanding it.
    // `-p` marks a directory with a trailing slash and `-A` keeps dotfiles, so a tree the operator
    // knows by its hidden directories stays navigable. One entry past the ceiling is requested, so
    // the answer can say whether it stopped early.
    // One walk answers for every level this call covers: a picker that asked per level would pay a
    // connection for each click. `head` stops the walk at the entry ceiling, and the extra entry
    // requested is what lets the answer say it stopped early.
    const listing = `find . -mindepth 1 -maxdepth ${String(depth)} -type d -print | head -n ${String(BROWSE_MAX_ENTRIES + 1)} || true`
    const command = [
      'set -e',
      wanted === undefined ? 'cd' : `cd ${quoteRemote(wanted)} || { echo NO_SUCH_DIR; exit 3; }`,
      'pwd',
      'echo "PARENT=$(dirname "$PWD")"',
      listing,
    ].join('; ')
    const ran = await runRemote(this.ctx.subprocess, ssh, request.destination, command, {
      timeoutMs: Math.min(request.timeoutMs ?? this.config.probeTimeoutMs, this.config.probeTimeoutMs),
      signal,
      maxBytes: BROWSE_MAX_BYTES,
    }).catch((error: unknown) => ({ failed: error }) as const)
    if ('failed' in ran) return empty(messageOf(ran.failed))
    if (ran.timedOut) return empty(describeFailure(ran, ssh))
    // Guarded by the named case rather than reporting whichever path was asked for: the marker is
    // emitted only by the `cd` that takes an argument, so the unnamed case cannot reach it and the
    // message never has to name a directory nobody named.
    if (wanted !== undefined && ran.stdout.includes('NO_SUCH_DIR')) {
      return empty(`no directory '${wanted}' on ${request.destination}`)
    }
    if (ran.exitCode !== 0) return empty(describeFailure(ran, ssh))
    const lines = ran.stdout.split(/\r?\n/).map(line => line.trim())
    const directory = firstLine(ran.stdout)
    if (directory.length === 0) return empty('the server reported no directory')
    const parent = lineValue(ran.stdout, 'PARENT=')
    // `find` prints `./a/b`, and the picker wants each path relative to the directory it asked
    // about: the caller already knows that prefix, and repeating it in every row would be noise.
    const entries = lines.slice(2)
      .filter(line => line.startsWith('./'))
      .map(line => line.slice(2))
      .filter(entry => entry.length > 0)
    return {
      directory,
      // The root's parent is itself; offering it as a way up would be a control that does nothing.
      ...parent === undefined || parent === directory ? {} : { parent },
      entries: entries.slice(0, BROWSE_MAX_ENTRIES),
      depth,
      truncated: entries.length > BROWSE_MAX_ENTRIES,
    }
  }

  /**
   * Run one declared recipe in the declared project directory.
   *
   * A failed build is returned, not thrown: a compile error is the answer the
   * caller asked for, and what a failure *means* belongs to the flow's gate, not
   * to the transport. Only a transport-level impossibility (undeclared server or
   * recipe, no SSH client, a product path that could leave the output directory)
   * throws.
   * @param workspaceId - the owning project.
   * @param request - the server, recipe, and optional products to fetch back.
   * @param signal - cancellation.
   * @returns the run outcome, also recorded in the ledger.
   * @throws when the declaration is missing, the recipe is undeclared, or a fetch path is refused.
   */
  async run(
    workspaceId: string,
    request: YxspecRemoteRunRequest,
    signal?: AbortSignal,
  ): Promise<YxspecRemoteRunResult> {
    const record = await this.require(workspaceId, request.serverId)
    const recipe = record.recipes[request.recipe]
    if (recipe === undefined) {
      // No `(none)` fallback here, unlike `require`: `validateServer` refuses a declaration whose
      // recipe map is empty, so a stored record always names at least one recipe to report.
      const known = Object.keys(record.recipes).join(', ')
      throw new Error(`server '${record.serverId}' declares no recipe '${request.recipe}'; known: ${known}`)
    }
    const directories = this.directoriesOf(record, recipe)
    const fetch = request.fetch ?? []
    // Refused before anything runs: a path that could name something outside the output directory
    // would make this a file-copy tool wearing a build tool's name.
    const refused = fetch.find(path => !isFetchablePath(path))
    if (refused !== undefined) {
      throw new Error(
        `fetch path '${refused}' must be relative to the output directory and contain no '..'`,
      )
    }
    if (fetch.length > 0 && request.fetchInto === undefined) {
      throw new Error('fetching products needs fetchInto: an absolute local directory to expand them into')
    }
    const ssh = await this.sshExecutable(record)
    const started = Date.now()

    const revision = record.captureRevision === true
      ? await this.readRevision(ssh, record, signal)
      : undefined

    const command = renderRecipe(recipe.command, directories, request.extraArgs)
    const ran = await runRemote(this.ctx.subprocess, ssh, record.destination, command, {
      timeoutMs: record.timeoutMs,
      signal,
      maxBytes: this.config.logMaxBytes,
    })
    const fetched = fetch.length === 0
      ? undefined
      : await this.fetchProducts(ssh, record, directories, fetch, request.fetchInto as string, signal)
    return await this.settle(workspaceId, record, request.recipe, directories, revision, ran, {
      command,
      durationMs: Date.now() - started,
      ...fetched === undefined ? {} : { fetched },
    })
  }

  /**
   * Read the server-side source revision, best effort.
   *
   * A `repo` manifest walks every project of an automotive tree, which is why the declaration opts
   * in; a tree without one answers with its git revision. A failure here never fails the build —
   * the revision is evidence about the run, and a run that compiled is worth more than an
   * unreadable label — so the reason travels back in `revisionError` instead.
   * @param ssh - resolved OpenSSH client.
   * @param record - the declaration that ran.
   * @param signal - cancellation.
   * @returns the captured revision fields, or the reason they are absent.
   */
  private async readRevision(
    ssh: string,
    record: RemoteServerRecord,
    signal?: AbortSignal,
  ): Promise<RevisionCapture> {
    // Only the project directory matters here; the revision is a fact about the tree the recipe
    // builds, not about where that recipe's products go.
    const directories = this.directoriesOf(record, undefined)
    const command = [
      'set -e',
      `cd '${directories.cwd}'`,
      'if [ -d .repo ]; then repo manifest -r; else git rev-parse HEAD; fi',
    ].join('; ')
    const ran = await runRemote(this.ctx.subprocess, ssh, record.destination, command, {
      timeoutMs: record.timeoutMs,
      signal,
      maxBytes: REVISION_MAX_BYTES,
    }).catch((error: unknown) => ({ failed: error }) as const)
    if ('failed' in ran) return { error: messageOf(ran.failed) }
    if (ran.exitCode !== 0) return { error: describeFailure(ran, ssh) }
    const output = ran.stdout.trim()
    if (output.length === 0) return { error: 'the revision command printed nothing' }
    // A git revision is one short line and is the identity itself; a manifest is a document, so it
    // is identified by its digest and its first line is kept only as a readable hint.
    const [first = ''] = output.split(/\r?\n/)
    return {
      digest: createHash('sha256').update(output).digest('hex'),
      ...first.length > 0 && first.length <= REVISION_LABEL_MAX_CHARS && !output.includes('\n')
        ? { revision: first }
        : {},
    }
  }

  /**
   * Bring the named products back and expand them under a per-run local directory.
   *
   * A transfer that fails is not a failed build: the products are an extra, the build already
   * happened, and the caller needs both facts separately. The failure is reported per requested
   * path in the result, never as an exception that would hide an exit code.
   * @param ssh - resolved OpenSSH client.
   * @param record - the declaration that ran.
   * @param directories - the resolved server directories.
   * @param paths - product paths relative to the output directory.
   * @param into - absolute local directory the products land in.
   * @param signal - cancellation.
   * @returns one entry per requested path, with its local location or its failure.
   */
  private async fetchProducts(
    ssh: string,
    record: RemoteServerRecord,
    directories: RemoteDirectories,
    paths: readonly string[],
    into: string,
    signal?: AbortSignal,
  ): Promise<readonly YxspecRemoteFetched[]> {
    const runDirectory = join(into, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    const tar = await this.tarExecutable()
    await mkdir(runDirectory, { recursive: true })
    const staging = await mkdtemp(join(tmpdir(), 'dsh-yxspec-fetch-'))
    const archivePath = join(staging, 'products.tar.gz')
    try {
      const archive = await fetchArchive(
        this.ctx.subprocess,
        ssh,
        record.destination,
        directories.out,
        paths,
        { archivePath, maxBytes: this.config.fetchMaxBytes },
        { timeoutMs: record.timeoutMs, signal },
      )
      if (archive.error !== undefined) {
        return paths.map(path => ({ path, localPath: '', bytes: 0, error: archive.error as string }))
      }
      await extractArchive(this.ctx.subprocess, tar, archivePath, runDirectory, { signal })
      const out: YxspecRemoteFetched[] = []
      for (const path of paths) {
        const localPath = join(runDirectory, ...path.split('/'))
        const size = await sizeOf(localPath)
        out.push({ path, localPath, bytes: size ?? 0 })
      }
      return out
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  /**
   * The recorded runs for one project, newest first.
   * @param workspaceId - the project to read.
   * @param limit - maximum entries to return.
   * @returns the stored run records.
   */
  async runsFor(workspaceId: string, limit: number = 20): Promise<readonly RemoteRunRecord[]> {
    await this.ready
    const out: RemoteRunRecord[] = []
    for (const [, record] of this.runsTable().entries()) {
      if (record.workspaceId === workspaceId) out.push(record)
    }
    return out.sort((a, b) => b.finishedAt.localeCompare(a.finishedAt)).slice(0, limit)
  }

  /**
   * The most recent run of one recipe that exited zero. The question a gate asks
   * before letting a later stage start.
   * @param workspaceId - the project to read.
   * @param serverId - the server the run targeted.
   * @param recipe - the recipe id.
   * @returns that run, or `undefined` when the recipe has never passed.
   */
  async lastSuccess(
    workspaceId: string,
    serverId: string,
    recipe: string,
  ): Promise<RemoteRunRecord | undefined> {
    const records = await this.runsFor(workspaceId, Number.MAX_SAFE_INTEGER)
    return records.find(r => r.serverId === serverId && r.recipe === recipe && r.exitCode === 0)
  }

  /**
   * Record one settled run and return the project-facing result.
   *
   * The ledger write happens before the result leaves the service, so a caller
   * that reads `runsFor` immediately after a run sees it. A storage failure is
   * deliberately not swallowed: an unrecorded verification run is exactly the
   * audit gap this service exists to close.
   * @param workspaceId - the project the run belongs to.
   * @param server - the declaration that ran.
   * @param recipe - the recipe requested.
   * @param directories - the resolved server directories the run used.
   * @param revision - the source revision read before the run, when one was requested.
   * @param ran - the transport's exit facts and output.
   * @param facts - the command line recorded for the run, its wall-clock cost, and any products
   *   brought back.
   * @returns the run outcome, after the ledger write and the change event.
   */
  private async settle(
    workspaceId: string,
    server: RemoteServerRecord,
    recipe: string,
    directories: RemoteDirectories,
    revision: RevisionCapture | undefined,
    ran: RemoteCommandResult,
    facts: {
      command: string
      durationMs: number
      fetched?: readonly YxspecRemoteFetched[]
    },
  ): Promise<YxspecRemoteRunResult> {
    const log = ran.stderr.trim().length === 0
      ? ran.stdout
      : `${ran.stdout}\n--- stderr ---\n${ran.stderr}`
    const entry: RemoteRunRecord = {
      runId: randomUUID(),
      workspaceId,
      serverId: server.serverId,
      recipe,
      projectDirectory: directories.cwd,
      outputDirectory: directories.out,
      command: facts.command,
      ...revision?.revision === undefined ? {} : { revision: revision.revision },
      ...revision?.digest === undefined ? {} : { revisionDigest: revision.digest },
      ...revision?.error === undefined ? {} : { revisionError: revision.error },
      exitCode: ran.exitCode,
      timedOut: ran.timedOut,
      durationMs: Math.max(0, Math.round(facts.durationMs)),
      logSha256: createHash('sha256').update(log).digest('hex'),
      logTail: log.length > 4096 ? log.slice(-4096) : log,
      finishedAt: new Date().toISOString(),
    }
    await this.runsTable().put(entry.runId, entry)
    const result: YxspecRemoteRunResult = {
      runId: entry.runId,
      serverId: server.serverId,
      recipe,
      projectDirectory: directories.cwd,
      outputDirectory: directories.out,
      command: facts.command,
      exitCode: ran.exitCode,
      log,
      truncated: ran.truncated,
      timedOut: ran.timedOut,
      durationMs: entry.durationMs,
      ...entry.revision === undefined ? {} : { revision: entry.revision },
      ...entry.revisionDigest === undefined ? {} : { revisionDigest: entry.revisionDigest },
      ...entry.revisionError === undefined ? {} : { revisionError: entry.revisionError },
      ...facts.fetched === undefined ? {} : { fetched: facts.fetched },
      logSha256: entry.logSha256,
    }
    this.ctx.emit('yxspec/remote-run', result, workspaceId)
    return result
  }

  /** Resolve a declaration or fail with the known ids, which is what a caller needs. */
  private async require(workspaceId: string, serverId: string): Promise<RemoteServerRecord> {
    const record = await this.server(workspaceId, serverId)
    if (record === undefined) {
      const known = (await this.list(workspaceId)).map(s => s.serverId)
      throw new Error(
        `project '${workspaceId}' declares no build server '${serverId}'; known: ${known.join(', ') || '(none)'}`,
      )
    }
    return record
  }

  /**
   * The directories one run resolves to.
   *
   * The output directory comes from the recipe because that is what decides where products land —
   * a whole build and a module build of one tree write to different places. The default lives here
   * rather than in the stored row, so a deployment that moves the convention moves it for every
   * recipe that did not name its own: an implicit default inside `run()` would be the same code
   * with no place to read it from, and one inside `declare` would be a copy frozen into every row.
   * @param record - the stored declaration.
   * @param recipe - the recipe about to run, or undefined when none has (a probe).
   * @returns the absolute project and output directories a run uses.
   */
  private directoriesOf(
    record: RemoteServerRecord,
    recipe: RemoteRecipeRecord | undefined,
  ): RemoteDirectories {
    return {
      cwd: record.projectDirectory,
      out: recipe?.outputDirectory ?? `${record.projectDirectory}/out`,
    }
  }

  /**
   * Resolve (and memoize) the SSH client for one declaration.
   *
   * The declaration wins over the deployment default, so one server can pin its own client while
   * the rest inherit the configured one.
   * @param record - the declaration the client will be used for.
   * @returns the resolved executable path.
   */
  private async sshExecutable(record: RemoteServerRecord): Promise<string> {
    return await this.clientFor(record.sshExecutable)
  }

  /**
   * Resolve (and memoize) the SSH client for a configured value.
   *
   * One door for both callers: a declaration resolves through {@link sshExecutable}, and a browse —
   * which runs before any declaration exists — passes whatever the form typed. Memoization keys on
   * the effective value rather than on the row, because two declarations that both inherit resolve
   * to the same client and so does a browse that names nothing.
   * @param configured - the client the caller named, or undefined to inherit the deployment default.
   * @returns the resolved executable path.
   */
  private async clientFor(configured: string | undefined): Promise<string> {
    const effective = configured ?? this.config.sshExecutable
    const key = effective ?? '\u0000default'
    const cached = this.sshCache.get(key)
    if (cached !== undefined) return cached
    const resolved = await resolveSshExecutable(effective, this.ctx.subprocess)
    this.sshCache.set(key, resolved)
    return resolved
  }

  /** Resolve (and memoize) the archive tool. */
  private async tarExecutable(): Promise<string> {
    if (this.tarCache !== undefined) return this.tarCache
    this.tarCache = await resolveTarExecutable(this.config.tarExecutable, this.ctx.subprocess)
    return this.tarCache
  }

  private table(): KvTable<string, RemoteServerRecord> {
    /* v8 ignore next -- `open()` assigns the table before the constructor returns, and every
     * caller awaits `ready` first, so this guard only protects a direct construction. */
    if (this.servers === undefined) throw new Error('yxspec-remote: domain is not open yet')
    return this.servers
  }

  private runsTable(): KvTable<string, RemoteRunRecord> {
    /* v8 ignore next -- as `table()`: `runs` is assigned by the same `open()`. */
    if (this.runs === undefined) throw new Error('yxspec-remote: domain is not open yet')
    return this.runs
  }
}

/** The server directories one resolved declaration names, under the names a recipe sees. */
interface RemoteDirectories {
  /** Absolute directory a run executes in; the  token. */
  readonly cwd: string
  /** Absolute directory products land in, and the one a fetch reads from; the  token. */
  readonly out: string
}

/** What a revision read produced: the identity, or why there is none. */
interface RevisionCapture {
  /** The revision itself, when the command printed one short line. */
  readonly revision?: string
  /** SHA-256 of the complete command output. */
  readonly digest?: string
  /** Why nothing was captured. */
  readonly error?: string
}

/**
 * Directory entries one browse returns.
 *
 * A picker is a navigation aid, not a filesystem dump: a directory holding thousands of children is
 * one the operator should reach by typing the path they already know, and the response says when the
 * listing stopped early rather than presenting a prefix as the whole.
 */
const BROWSE_MAX_ENTRIES = 200

/** Lines of a client diagnostic one failure message carries. */
const FAILURE_LINES = 3

/**
 * Levels one browse answers for when the caller names none.
 *
 * Two, so the click after a connect is already answered: one level would make every descent a
 * fresh connection, and more would walk trees nobody asked to see.
 */
const BROWSE_DEPTH_DEFAULT = 2

/** Deepest walk one browse may perform, whatever a caller asks for. */
const BROWSE_DEPTH_MAX = 4

/** Output budget for one browse; a listing of names is small, and a runaway one is not useful. */
const BROWSE_MAX_BYTES = 256 * 1024

/** Output budget for the revision read; a manifest is a document, not a product. */
const REVISION_MAX_BYTES = 8 * 1024 * 1024


/** Longest single-line output still recorded verbatim as the revision. */
const REVISION_LABEL_MAX_CHARS = 200

/**
 * Why a probe could not find the declared project directory, and where to look instead.
 *
 * The operator typed a path, and the machine they meant is usually reachable under another name —
 * the SMB or NFS share they browse it through. Reporting only the miss leaves them comparing two
 * spellings by hand, so the probe ships back the login directory and, when the same path exists
 * under it, that absolute path as the answer: a share named after the user maps to their home
 * directory, which is the mistake this exists to end.
 * @param directory - the declared project directory.
 * @param destination - the OpenSSH destination the probe ran against.
 * @param stdout - the probe command's output, which carries HOME and a possible ALT line.
 * @returns the message the operator reads.
 */
function missingDirectoryMessage(directory: string, destination: string, stdout: string): string {
  const miss = `no directory '${directory}' on ${destination}`
  const alternative = lineValue(stdout, 'ALT=')
  if (alternative !== undefined) return `${miss}; it exists at '${alternative}' — declare that path`
  const home = lineValue(stdout, 'HOME=')
  return home === undefined ? miss : `${miss}; the login directory is '${home}'`
}

/**
 * One `KEY=value` line of a command's output.
 * @param stdout - the command's complete standard output.
 * @param prefix - the key to look for, including its `=`.
 * @returns the value, or undefined when the command printed no such line.
 */
function lineValue(stdout: string, prefix: string): string | undefined {
  const line = stdout.split(/\r?\n/).map(entry => entry.trim()).find(entry => entry.startsWith(prefix))
  if (line === undefined) return undefined
  const value = line.slice(prefix.length)
  return value.length === 0 ? undefined : value
}

/** A file's size, or `undefined` when it is not a readable file. */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    // A product the remote tar did not carry: the archive reports what it held, and a path the
    // server listed but did not pack reads as absent here rather than as a failure of the fetch.
    return undefined
  }
}

/** A one-line reason an ssh invocation failed, preferring the client's own words. */
/**
 * One line explaining why an ssh invocation failed, preferring the client's own words.
 *
 * The client that ran is named in the report, because that is what tells two failures apart: two
 * OpenSSH installations on one machine read different key stores, and "Permission denied" from the
 * wrong one is a diagnosis the operator cannot reach from the message alone.
 * @param ran - the settled command's exit facts and output.
 * @param client - the resolved ssh executable that produced them.
 * @returns a one-sentence reason, with the client named.
 */
function describeFailure(ran: RemoteCommandResult, client: string): string {
  if (ran.timedOut) return `connection timed out (client ${client})`
  const detail = (ran.stderr.trim().length > 0 ? ran.stderr : ran.stdout).trim()
  const head = `ssh exited ${String(ran.exitCode)} (client ${client})`
  return detail.length === 0 ? head : `${head}: ${failureLines(detail)}`
}

/**
 * Every non-empty line of a diagnostic, bounded.
 *
 * The whole client report rather than its first line: an authentication failure puts the cause in
 * the lines around it — a key the client could not read, an identity it never offered — and the
 * first line alone ("Permission denied") says only that something was refused.
 * @param text - the client's standard error, or its standard output when that was empty.
 * @returns up to {@link FAILURE_LINES} non-empty lines, joined for one sentence.
 */
function failureLines(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  return lines.slice(-FAILURE_LINES).join(' | ')
}

/** Reject a declaration that cannot produce a safe remote invocation. */
function validateServer(server: YxspecRemoteServer): void {
  if (server.id.trim().length === 0) throw new Error('a build server needs a non-empty id')
  if (server.destination.trim().length === 0) throw new Error(`server '${server.id}' needs a destination`)
  if (!isAbsoluteRemotePath(server.projectDirectory)) {
    throw new Error(`server '${server.id}' projectDirectory must be an absolute server path`)
  }
  if (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0) {
    throw new Error(`server '${server.id}' needs a positive timeoutMs`)
  }
  const recipes = Object.entries(server.recipes)
  if (recipes.length === 0) {
    throw new Error(`server '${server.id}' declares no recipes; a run could never be requested`)
  }
  // The tool layer refuses a blank id or command before it ever reaches this seam, but a host
  // may mount the service directly. Repeating the check keeps both layers agreeing, and it is
  // what keeps the run-time "known: ..." listing honest: a nameless recipe would otherwise
  // make a server that does have a recipe look like one that has none.
  for (const [id, recipe] of recipes) {
    if (id.trim().length === 0) throw new Error(`server '${server.id}' declares a recipe with a blank id`)
    if (recipe.command.trim().length === 0) {
      throw new Error(`server '${server.id}' recipe '${id}' needs a non-empty command`)
    }
    if (recipe.outputDirectory !== undefined && !isAbsoluteRemotePath(recipe.outputDirectory)) {
      throw new Error(`server '${server.id}' recipe '${id}' outputDirectory must be an absolute server path`)
    }
  }
}

/**
 * Whether a declared server path is absolute.
 *
 * A path the seam interpolates into a shell command is read once and typed by a person, so the
 * check is the leading separator: a relative directory would resolve against ssh's login
 * directory, which is not a place any of these declarations means.
 * @param value - the declared directory or product path.
 * @returns whether it starts at the server's root.
 */
function isAbsoluteRemotePath(value: string): boolean {
  return value.trim().startsWith('/')
}

/**
 * Whether a requested product path may be fetched.
 *
 * Relative and `..`-free: the fetch runs `tar` from inside the declared output directory, so a path
 * that climbed out of it, or one that named somewhere else entirely, would turn the build tool into
 * a way to read any file the ssh login can see.
 * @param path - the requested product path.
 * @returns whether the path stays inside the output directory.
 */
function isFetchablePath(path: string): boolean {
  if (path.length === 0 || path.trim() !== path) return false
  if (path.startsWith('/') || path.startsWith('~')) return false
  return !path.split('/').includes('..')
}

/** Trailing slashes produce `a//b` in a remote path; normalize them away once. */
function normalizeRemoteDirectory(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.length === 0 ? '/' : trimmed
}

/**
 * One value quoted as a single shell word.
 *
 * The seam interpolates operator-supplied text into remote commands, so the quoting is centralized:
 * a single-quoted word cannot hold a quote, and closing it, carrying an escaped quote, and reopening
 * it is the standard way to pass one through without letting the text end the quoting.
 * @param value - the text to quote.
 * @returns the value as one single-quoted shell word.
 */
function quoteRemote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/**
 * The first line of a command's output, trimmed.
 *
 * Sliced rather than split: the caller reads a value that is known to be on the first line, and a
 * split would turn that knowledge into a `undefined` the type then has to be talked out of.
 * @param text - the complete standard output.
 * @returns the first line, or the whole text when it carries no newline.
 */
function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return (end < 0 ? text : text.slice(0, end)).trim()
}

/** An error's message, for a value that may be anything. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A configured string, or `undefined` when it carries no configuration. */
function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    yxspecRemote: YxspecRemoteService
  }

  interface Events {
    /**
     * A remote build run settled. Emitted after the ledger write, so a listener
     * reading `runsFor` sees the run it was told about.
     * @param result - the settled run.
     * @param workspaceId - the project the run belongs to.
     * @mode emit
     */
    'yxspec/remote-run'(result: YxspecRemoteRunResult, workspaceId: string): void
  }
}

/**
 * Register the remote build service.
 *
 * The model-facing tools live in `@deepseek-ai/dsh-yxspec-remote/tools`, a
 * separate plugin, so the composition decides which agents receive them: the
 * shipped Web composition mounts that row in `standard`, `ptc`, and `cordis`
 * and omits it from `minimal`. Mounting this row alone gives a deployment the
 * service — which the client half reads to list declared servers — without
 * granting any agent a build-server tool.
 * @param ctx - the registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new YxspecRemoteService(ctx, config)
}
