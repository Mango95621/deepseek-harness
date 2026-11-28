/**
 * Vocabulary of the remote build seam (`ctx.yxspecRemote`): a declared build
 * server, the compile/verify recipes it may run, and the outcome record one run
 * produces.
 *
 * The model is "remote compile verification point": a run SSHes to a machine
 * that already holds the checkout, runs one declared recipe inside the declared
 * project directory, and returns the log and exit code. Nothing is uploaded —
 * an automotive tree is hundreds of gigabytes, and a seam that copied it per
 * run would be unusable on exactly the projects it exists for. The server-side
 * tree is the operator's, not the harness's: the harness never creates,
 * replaces, or deletes it.
 *
 * These are plain host-realm JSON-shaped types. The service that owns them
 * lives in `index.ts`; consumers read them through `ctx.yxspecRemote` and never
 * construct them.
 * @module @deepseek-ai/dsh-yxspec-remote/types
 */

/** How a build server is reached. */
export type YxspecRemoteTransport = 'ssh'

/**
 * One declared build recipe: the command a run executes and where its products land.
 *
 * The output directory belongs to the recipe rather than to the server because a
 * whole build and a module build of the same tree do not put their products in
 * the same place — an Android tree writes a full build to its `out/` root while a
 * single-module build writes into that module's own output — so one directory per
 * machine could only ever describe one of them.
 */
export interface YxspecRemoteRecipe {
  /** Server-side command template, run inside the project directory. */
  readonly command: string
  /**
   * Absolute directory this recipe's products land in. Absent means
   * `<projectDirectory>/out`, which is where a Gradle, Soong, or Make tree puts
   * them by default.
   *
   * The recipe receives it as the `{out}` token, because redirecting products is
   * the build system's decision and this seam only has to name the place. A fetch
   * resolves its paths against the directory of the recipe that ran.
   */
  readonly outputDirectory?: string
}

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
   * Absolute directory on the server holding the checkout the build runs in.
   *
   * A run `cd`s here and executes the recipe; it neither creates nor clears the
   * directory, so a machine whose tree was synced once is usable as it stands.
   * A missing directory is a failed run with the path named, never a directory
   * the harness makes.
   */
  readonly projectDirectory: string
  /**
   * Whether a run captures the server-side source revision into its record.
   *
   * Off by default: reading a `repo` manifest walks every project of an
   * automotive tree, and a flow whose own scripts already record traceability
   * would pay for a second answer to the same question.
   */
  readonly captureRevision?: boolean
  /** How the server is reached; only OpenSSH is defined today. */
  readonly transport: YxspecRemoteTransport
  /**
   * The recipes this server may run, keyed by recipe id. The `{cwd}` token is
   * replaced with the project directory and `{out}` with the recipe's own output
   * directory. A recipe the map does not name cannot be requested.
   */
  readonly recipes: Readonly<Record<string, YxspecRemoteRecipe>>
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
  /** Extra shell text appended to the recipe on the server, for a one-off flag. */
  readonly extraArgs?: string
  /**
   * Products to bring back, as paths relative to the server's output directory.
   *
   * Relative rather than absolute on purpose: what a run returns is a build's
   * products, and a path that could name anything on the machine would turn a
   * build tool into a file-copy tool. An absolute path or one containing `..`
   * is refused.
   */
  readonly fetch?: readonly string[]
  /** Absolute LOCAL directory the fetched products land in, under a per-run subdirectory. */
  readonly fetchInto?: string
}

/**
 * One request to list the directories under a path on a server.
 *
 * It names a destination rather than a declaration because it runs before one exists: the onboarding
 * wizard connects, browses, and then declares what the operator picked, so the connection is the
 * first thing established and the directory is a consequence of it. Nothing here is stored.
 */
export interface YxspecRemoteBrowseRequest {
  /** OpenSSH destination: a `~/.ssh/config` Host alias or `user@host`. */
  readonly destination: string
  /**
   * Absolute directory to list. Omitted lists the login directory, which is where a session starts
   * and the only place a path with no leading separator could have meant.
   */
  readonly directory?: string
  /** Local `ssh` executable to invoke; omitted means the deployment default. */
  readonly sshExecutable?: string
  /** Wall-clock budget for the listing; omitted means the deployment's interactive budget. */
  readonly timeoutMs?: number
  /**
   * How many levels below the directory to include; omitted means the service's own default.
   *
   * More than one level because a picker that asked per level would pay a connection for every
   * click: descending inside what one listing already returned costs nothing. Bounded regardless,
   * because a whole filesystem is not a listing.
   */
  readonly depth?: number
}

/**
 * One directory listing, as a picker renders it.
 *
 * Entries are *relative paths* rather than child names, because one call answers for several
 * levels: a picker navigates what it already holds and asks again only below that, so a click is
 * answered immediately instead of costing a connection.
 */
export interface YxspecRemoteBrowse {
  /** Absolute directory the listing is of; echoed on failure, so a picker can say where it was. */
  readonly directory: string
  /** Absolute parent directory; absent at the filesystem root, where there is nowhere to go up. */
  readonly parent?: string
  /** Directory paths below {@link directory}, relative to it and POSIX-separated, in walk order. */
  readonly entries: readonly string[]
  /** How many levels below the directory the listing reached. */
  readonly depth: number
  /** Whether the listing stopped at the entry ceiling rather than showing everything. */
  readonly truncated: boolean
  /** Why the listing is empty, when it is; absent on success. */
  readonly error?: string
}

/** One product a run brought back, or why it could not. */
export interface YxspecRemoteFetched {
  /** The path requested, as given. */
  readonly path: string
  /** Absolute local path of the same name inside the run's fetch directory; empty on failure. */
  readonly localPath: string
  /** Size in bytes on disk after the transfer; `0` on failure. */
  readonly bytes: number
  /**
   * Why this product did not come back.
   *
   * Per path rather than for the whole fetch, because a transfer failure is not a build failure:
   * the exit code in the same result is the build's verdict, and a product that did not arrive is
   * a separate fact the caller reports alongside it.
   */
  readonly error?: string
}

/** Outcome of one remote run. Never throws for a failed build: a nonzero exit is data. */
export interface YxspecRemoteRunResult {
  /** Ledger id of this run, so the stored record can be quoted later. */
  readonly runId: string
  /** The server the run targeted. */
  readonly serverId: string
  /** The recipe that ran. */
  readonly recipe: string
  /** Server-side directory the recipe ran in. */
  readonly projectDirectory: string
  /** Server-side directory the recipe wrote products to, resolved from the recipe that ran. */
  readonly outputDirectory: string
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
   * The server-side source revision this run compiled, when the declaration
   * asked for one and the read succeeded.
   *
   * The tree is not uploaded, so there is no archive digest to identify the
   * input; a git revision is the same fact for the trees this seam compiles.
   */
  readonly revision?: string
  /** SHA-256 of the complete revision output, so a long manifest is still comparable. */
  readonly revisionDigest?: string
  /** Why the revision read produced nothing, when one was requested and failed. */
  readonly revisionError?: string
  /** The products this run brought back, in request order. */
  readonly fetched?: readonly YxspecRemoteFetched[]
  /** SHA-256 of {@link log}, so a quoted excerpt can be traced back to its run. */
  readonly logSha256: string
}

/** Whether a server is reachable and the directories its declaration names exist. */
export interface YxspecRemoteProbe {
  /** The server probed. */
  readonly serverId: string
  /** True when the SSH handshake and the project-directory check both succeeded. */
  readonly reachable: boolean
  /** Remote `uname`-style platform string, when the probe got that far. */
  readonly platform?: string
  /** Whether the declared output directory exists yet; a build creates it. */
  readonly outputPresent?: boolean
  /** Human-readable failure detail; absent on success. */
  readonly error?: string
}
