/**
 * Vocabulary of the remote build seam (`ctx.yxspecRemote`): a declared build
 * server, the compile/verify recipes it may run, and the outcome record one run
 * produces.
 *
 * The model is "remote compile verification point", not "remote workspace".
 * Source code never lives on the server: a run pushes the project's working
 * tree to a scratch directory, executes the recipe there, and returns the log
 * and exit code. The server is a build farm, never the system of record.
 *
 * These are plain host-realm JSON-shaped types. The service that owns them
 * lives in `index.ts`; consumers read them through `ctx.yxspecRemote` and never
 * construct them.
 * @module @deepseek-ai/dsh-yxspec-remote/types
 */

/** How a build server is reached. */
export type YxspecRemoteTransport = 'ssh'

/**
 * One declared build server. Credentials are deliberately absent: the host's
 * own `~/.ssh/config` owns keys, agent forwarding, and jump hosts, so a project
 * file names an alias and nothing secret. A deployment that must pin an
 * identity adds it to that config, not to this record.
 */
export interface YxspecRemoteServer {
  /** Short kebab-case id, unique within a project (e.g. `aosp-builder`). */
  readonly id: string
  /** Human label for the picker. */
  readonly title: string
  /**
   * OpenSSH destination: either a `Host` alias from the host's `~/.ssh/config`
   * or an explicit `user@host`. Never carries a password — the client's own
   * key material is the only credential path.
   */
  readonly destination: string
  /**
   * Absolute directory on the server under which each project gets a scratch
   * build tree. A run never writes outside `<baseDirectory>/<projectSlug>`.
   */
  readonly baseDirectory: string
  /** How the server is reached; only OpenSSH is defined today. */
  readonly transport: YxspecRemoteTransport
  /**
   * Server-side boot command templates, keyed by recipe id. The `{cwd}` token
   * is replaced with the pushed tree's server path. A recipe the map does not
   * name cannot be requested.
   */
  readonly recipes: Readonly<Record<string, string>>
  /**
   * Local `ssh` executable to invoke. Defaults to a platform-resolved OpenSSH
   * client; a deployment with a bundled client pins the absolute path.
   */
  readonly sshExecutable?: string
  /** Per-run wall clock budget in milliseconds. */
  readonly timeoutMs: number
}

/** One request to run a recipe against a project. */
export interface YxspecRemoteRunRequest {
  /** The declared server to run against. */
  readonly serverId: string
  /** The recipe id; must be a key of the server's `recipes` map. */
  readonly recipe: string
  /** Absolute local directory whose tree is pushed. Defaults to the project's primary root. */
  readonly sourceDirectory?: string
  /**
   * Whether to push the source tree before running. A repeat run against an
   * unchanged tree can skip the push when the caller tracked the sync itself.
   */
  readonly push?: boolean
  /** Extra shell text appended to the recipe on the server, for a one-off flag. */
  readonly extraArgs?: string
}

/** Outcome of one remote run. Never throws for a failed build: a nonzero exit is data. */
export interface YxspecRemoteRunResult {
  /** Ledger id of this run, so the stored record can be quoted later. */
  readonly runId: string
  /** The server the run targeted. */
  readonly serverId: string
  /** The recipe that ran. */
  readonly recipe: string
  /** Server-side working directory the recipe ran in. */
  readonly remoteDirectory: string
  /** The exact command line executed on the server. */
  readonly command: string
  /** Exit code reported by the server side; `null` when the client died from a signal. */
  readonly exitCode: number | null
  /** Combined stdout/stderr, tail-truncated to the configured budget. */
  readonly log: string
  /** True when the log lost its head to the output cap. */
  readonly truncated: boolean
  /** Whether the run timed out before the command reported an exit. */
  readonly timedOut: boolean
  /** Wall clock duration in milliseconds. */
  readonly durationMs: number
  /**
   * SHA-256 of the uploaded archive. Two runs carrying the same digest proved
   * the same source, which is the property an ASPICE verification record needs
   * and a bare exit code does not provide. Absent when the run skipped the push.
   */
  readonly treeDigest?: string
  /** SHA-256 of {@link log}, so a quoted excerpt can be traced back to its run. */
  readonly logSha256: string
}

/** Whether a server is reachable and its base directory exists. */
export interface YxspecRemoteProbe {
  /** The server probed. */
  readonly serverId: string
  /** True when the SSH handshake and the base-directory check both succeeded. */
  readonly reachable: boolean
  /** Remote `uname`-style platform string, when the probe got that far. */
  readonly platform?: string
  /** Human-readable failure detail; absent on success. */
  readonly error?: string
}
