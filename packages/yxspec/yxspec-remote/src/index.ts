/**
 * The remote build seam (`ctx.yxspecRemote`): declared build servers and the
 * compile/verify runs executed against them.
 *
 * The model is a **remote compile verification point**. Source never lives on
 * the server: a run archives the project's working tree, streams it into a
 * per-project scratch directory, runs one named recipe there, and returns the
 * log and exit code. The server compiles; it never becomes the system of record.
 * That is what makes a server declaration safe to add to a project — nothing the
 * user edits locally is at risk, and a rebuild is always reproducible from the
 * local tree.
 *
 * Two design consequences worth stating, because they are what make this a
 * program rather than a command wrapper:
 *
 * - **Recipes are declared, not typed.** A run names a recipe id from the
 *   server's own map; the model cannot invent a command line to execute on
 *   someone's build server. The recipe map is the allowlist.
 * - **Every run is recorded.** Exit code, tree digest, log digest, and duration
 *   land in a storage domain, because "the build passed" is ASPICE evidence and
 *   an agent transcript is not an evidence store.
 *
 * The Windows constraint that shaped the transport lives in `./ssh.ts`.
 * @module @deepseek-ai/dsh-yxspec-remote
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash, randomUUID } from 'node:crypto'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-working-directory'
import {
  archiveTree,
  pushArchive,
  resolveSshExecutable,
  resolveTarExecutable,
  runRemote,
} from './ssh.ts'
import type { RemoteCommandResult } from './ssh.ts'
import {
  remoteDomainSpec,
  serverKey,
  type RemoteRunRecord,
  type RemoteServerRecord,
} from './spec.ts'
// Reaching these by internal path keeps the plugin entry to the Loader's four
// exports plus the Service class; a same-package test imports them the same way.
import { projectSlug } from './paths.ts'
import { renderRecipe } from './recipe.ts'
import type {
  YxspecRemoteProbe,
  YxspecRemoteRunRequest,
  YxspecRemoteRunResult,
  YxspecRemoteServer,
} from './types.ts'

export type {
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
   * Exclusions applied when archiving a project tree. Build output is the bulk
   * of an automotive tree and none of it is an input to a clean build, so the
   * defaults are the usual suspects; a deployment extends rather than replaces.
   */
  excludes?: string[]
  /**
   * Whether to push the source tree. Disabling it turns every run into
   * "execute against whatever is already there", which is how a deployment with
   * a pre-synced tree (or a server-side checkout) avoids re-uploading.
   */
  pushSource?: boolean
  /** Absolute local `tar` to use; the platform default is probed when absent. */
  tarExecutable?: string
  /** Output budget for a run's log, in bytes. */
  logMaxBytes?: number
}

/** The archive exclusions that ship as the default. */
const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'build',
  'out',
  'dist',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  '*.pyc',
] as const

/** Schemastery configuration for the remote build seam. */
export const Config: z<Config> = z.object({
  // Defaulted here rather than at the read site: schemastery materializes a bare
  // `z.array(z.string())` as `[]`, which would make a `?? DEFAULT_EXCLUDES`
  // fallback unreachable and silently ship a full copy of `node_modules`.
  excludes: z.array(z.string()).default([...DEFAULT_EXCLUDES]),
  pushSource: z.boolean().default(true),
  tarExecutable: z.string(),
  logMaxBytes: z.natural().default(2 * 1024 * 1024),
})

export const name = 'yxspec-remote'
export const inject = ['subprocess', 'workspaceRegistry', 'storageDomain']

/**
 * The remote build service. Owns declarations, executes recipes, and records
 * every run.
 */
export class YxspecRemoteService extends Service {
  /**
   * Declared on the class because cordis reads the *class's* metadata when it
   * pragmatically mounts one. The class is reachable that way so a host can
   * mount `YxspecRemoteService` directly and get the service without the tools,
   * and the module-level `inject` below is what the loader reads — the same
   * three services, because the model-facing tools live in a sibling plugin
   * (`@deepseek-ai/dsh-yxspec-remote/tools`) that this row no longer needs.
   */
  static inject = ['subprocess', 'workspaceRegistry', 'storageDomain']

  /** Let a direct `ctx.plugin(YxspecRemoteService, config)` validate its config. */
  static Config = Config

  private readonly config: Required<Pick<Config, 'excludes' | 'pushSource' | 'logMaxBytes'>>
    & { readonly tarExecutable: string | undefined }
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
      excludes: config.excludes ?? [...DEFAULT_EXCLUDES],
      pushSource: config.pushSource ?? true,
      logMaxBytes: config.logMaxBytes ?? 2 * 1024 * 1024,
      // Schemastery materializes an unset `z.string()` as `''`; normalizing here
      // keeps "unset" distinguishable from "configured" at every read site.
      tarExecutable: emptyToUndefined(config.tarExecutable),
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
    const record: RemoteServerRecord = {
      workspaceId,
      serverId: server.id,
      title: server.title,
      destination: server.destination,
      baseDirectory: normalizeRemoteDirectory(server.baseDirectory),
      transport: server.transport,
      recipes: { ...server.recipes },
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
   * Probe a declared server: SSH handshake, platform, and base-directory
   * presence (creating it when absent).
   *
   * A probe never throws for an unreachable server — reachability is the value
   * being reported, and a caller rendering a picker needs the negative answer as
   * much as the positive one. It throws only when the project declares no such
   * server, which is a caller mistake rather than a connectivity fact.
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
    let ssh: string
    try {
      ssh = await this.sshExecutable(record)
    } catch (error) {
      return { serverId, reachable: false, error: messageOf(error) }
    }
    // One round trip answers both questions. `mkdir -p` on the miss makes the
    // first probe of a fresh server succeed rather than asking the user to go
    // create a directory by hand.
    const command = [
      'set -e',
      'uname -s',
      `if [ -d '${record.baseDirectory}' ]; then echo BASE_OK;`
      + ` else mkdir -p '${record.baseDirectory}' && echo BASE_CREATED; fi`,
    ].join('; ')
    const ran = await runRemote(this.ctx.subprocess, ssh, record.destination, command, {
      timeoutMs: record.timeoutMs,
      signal,
      maxBytes: 64 * 1024,
    }).catch((error: unknown) => ({ failed: error }) as const)
    if ('failed' in ran) return { serverId, reachable: false, error: messageOf(ran.failed) }
    if (ran.exitCode !== 0) {
      return { serverId, reachable: false, error: describeFailure(ran) }
    }
    const lines = ran.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
    const platform = lines.find(line => line !== 'BASE_OK' && line !== 'BASE_CREATED')
    await this.table().put(serverKey(workspaceId, serverId), {
      ...record,
      lastProbeAt: new Date().toISOString(),
      ...platform === undefined ? {} : { lastPlatform: platform },
    })
    return {
      serverId,
      reachable: true,
      ...platform === undefined ? {} : { platform },
    }
  }

  /**
   * Run one declared recipe against a project tree.
   *
   * A failed build is returned, not thrown: a compile error is the answer the
   * caller asked for, and what a failure *means* belongs to the flow's gate, not
   * to the transport. Only a transport-level impossibility (undeclared server or
   * recipe, no SSH client, no archive tool) throws.
   * @param workspaceId - the owning project.
   * @param request - the server, recipe, and optional source overrides.
   * @param signal - cancellation.
   * @returns the run outcome, also recorded in the ledger.
   * @throws when the declaration is missing or the transport cannot start.
   */
  async run(
    workspaceId: string,
    request: YxspecRemoteRunRequest,
    signal?: AbortSignal,
  ): Promise<YxspecRemoteRunResult> {
    const record = await this.require(workspaceId, request.serverId)
    const template = record.recipes[request.recipe]
    if (template === undefined) {
      // No `(none)` fallback here, unlike `require`: `validateServer` refuses a declaration whose
      // recipe map is empty, so a stored record always names at least one recipe to report.
      const known = Object.keys(record.recipes).join(', ')
      throw new Error(`server '${record.serverId}' declares no recipe '${request.recipe}'; known: ${known}`)
    }
    const source = request.sourceDirectory ?? await this.primaryRoot(workspaceId)
    const remoteDirectory = `${record.baseDirectory}/${projectSlug(workspaceId, await this.titleOf(workspaceId))}`
    const ssh = await this.sshExecutable(record)
    const started = Date.now()

    let digest: string | undefined
    if (request.push ?? this.config.pushSource) {
      const tar = await this.tarExecutable()
      const archive = await archiveTree(this.ctx.subprocess, tar, source, this.config.excludes, { signal })
      try {
        digest = archive.digest
        const pushed = await pushArchive(
          this.ctx.subprocess,
          ssh,
          record.destination,
          remoteDirectory,
          archive.path,
          { timeoutMs: record.timeoutMs, signal },
        )
        // A failed upload is a run outcome, not an exception: the caller needs
        // the client's own message (a wrong key, a full disk) far more than it
        // needs a stack trace, and the ledger should hold the attempt.
        if (pushed.exitCode !== 0) {
          return await this.settle(workspaceId, record, request.recipe, remoteDirectory, digest, pushed, {
            command: `push -> ${remoteDirectory} (upload failed; no recipe ran)`,
            durationMs: Date.now() - started,
          })
        }
      } finally {
        await archive.dispose()
      }
    }

    const command = renderRecipe(template, remoteDirectory, request.extraArgs)
    const ran = await runRemote(this.ctx.subprocess, ssh, record.destination, command, {
      timeoutMs: record.timeoutMs,
      signal,
      maxBytes: this.config.logMaxBytes,
    })
    return await this.settle(workspaceId, record, request.recipe, remoteDirectory, digest, ran, {
      command,
      durationMs: Date.now() - started,
    })
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
   * @param remoteDirectory - the server directory the run worked in.
   * @param digest - digest of the uploaded archive, when one was pushed.
   * @param ran - the transport's exit facts and output.
   * @param facts - the command line recorded for the run and its wall-clock cost.
   * @returns the run outcome, after the ledger write and the change event.
   */
  private async settle(
    workspaceId: string,
    server: RemoteServerRecord,
    recipe: string,
    remoteDirectory: string,
    digest: string | undefined,
    ran: RemoteCommandResult,
    facts: { command: string; durationMs: number },
  ): Promise<YxspecRemoteRunResult> {
    const log = ran.stderr.trim().length === 0
      ? ran.stdout
      : `${ran.stdout}\n--- stderr ---\n${ran.stderr}`
    const entry: RemoteRunRecord = {
      runId: randomUUID(),
      workspaceId,
      serverId: server.serverId,
      recipe,
      remoteDirectory,
      ...digest === undefined ? {} : { treeDigest: digest },
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
      remoteDirectory,
      command: facts.command,
      exitCode: ran.exitCode,
      log,
      truncated: ran.truncated,
      timedOut: ran.timedOut,
      durationMs: entry.durationMs,
      ...digest === undefined ? {} : { treeDigest: digest },
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

  /** The project's primary root, which is the default archive source. */
  private async primaryRoot(workspaceId: string): Promise<string> {
    const project = this.ctx.workspaceRegistry.get(workspaceId as never)
    if (project === undefined) throw new Error(`no project carries id '${workspaceId}'`)
    const root = project.roots[0]
    if (root === undefined) {
      throw new Error(`project '${workspaceId}' declares no repository root, so it has no default archive source`)
    }
    return root
  }

  /** A project's display title, for the readable half of its build slug. */
  private async titleOf(workspaceId: string): Promise<string> {
    return this.ctx.workspaceRegistry.get(workspaceId as never)?.title ?? workspaceId
  }

  /** Resolve (and memoize) the SSH client for one declaration. */
  private async sshExecutable(record: RemoteServerRecord): Promise<string> {
    const key = record.sshExecutable ?? '\u0000default'
    const cached = this.sshCache.get(key)
    if (cached !== undefined) return cached
    const resolved = await resolveSshExecutable(record.sshExecutable, this.ctx.subprocess)
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

/** A one-line reason an ssh invocation failed, preferring the client's own words. */
function describeFailure(ran: RemoteCommandResult): string {
  if (ran.timedOut) return 'connection timed out'
  const detail = (ran.stderr.trim().length > 0 ? ran.stderr : ran.stdout).trim()
  const head = `ssh exited ${String(ran.exitCode)}`
  return detail.length === 0 ? head : `${head}: ${firstLine(detail)}`
}

/** The first non-empty line of a multi-line diagnostic. */
function firstLine(text: string): string {
  /* v8 ignore next -- `describeFailure` only reaches this with an already-trimmed non-empty
   * string, and a non-empty string always has a line whose `trim` survives, so `find` cannot
   * miss. The fallback is this function's own precondition restated, not a live path. */
  return text.split(/\r?\n/).find(line => line.trim().length > 0)?.trim() ?? text.trim()
}

/** Reject a declaration that cannot produce a safe remote invocation. */
function validateServer(server: YxspecRemoteServer): void {
  if (server.id.trim().length === 0) throw new Error('a build server needs a non-empty id')
  if (server.destination.trim().length === 0) throw new Error(`server '${server.id}' needs a destination`)
  if (!server.baseDirectory.startsWith('/')) {
    throw new Error(`server '${server.id}' baseDirectory must be an absolute server path`)
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
  for (const [id, command] of recipes) {
    if (id.trim().length === 0) throw new Error(`server '${server.id}' declares a recipe with a blank id`)
    if (command.trim().length === 0) {
      throw new Error(`server '${server.id}' recipe '${id}' needs a non-empty command`)
    }
  }
}

/** Trailing slashes produce `a//b` in a remote path; normalize them away once. */
function normalizeRemoteDirectory(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.length === 0 ? '/' : trimmed
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
