/**
 * The remote-build domain declaration: the servers a project declared and the
 * ledger of runs executed against them.
 *
 * Both tables live here rather than in the project's own JSON for the same
 * reason the workspace registry does: a declared connection is durable state a
 * second process must see, and a verification run is ASPICE evidence that must
 * survive the session which produced it. Writing either to a tracked file would
 * make the record editable by the agent it is supposed to audit.
 *
 * A run record stores metadata plus a digest and a bounded tail, never the full
 * log: the log belongs to the tool result the user already read, while the
 * ledger answers "was this recipe verified, against which tree, and when".
 * @module @deepseek-ai/dsh-yxspec-remote/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** The transport names a declaration may carry at the durable boundary. */
const transportSchema = z.literal('ssh')

/**
 * Durable shape of one declared recipe.
 *
 * The output directory is per recipe rather than per server: a whole build and a
 * module build of one tree write their products to different places, so a single
 * directory per machine could only describe one of them. Absent keeps the
 * resolved default (`<projectDirectory>/out`) out of the row.
 */
export const remoteRecipeRecord = z.object({
  /** Server-side command template, run inside the project directory. */
  command: z.string(),
  /** Absolute directory this recipe's products land in. */
  outputDirectory: z.string().optional(),
})

/**
 * Durable shape of one declared build server, keyed by `${workspaceId}:${serverId}`.
 *
 * Credentials are absent by construction: the destination is an OpenSSH
 * destination resolved against the host's own `~/.ssh/config`, so the key
 * material never enters this record and cannot leak through an export.
 *
 * The record names directories on a machine this process does not own and never
 * writes to them itself: a run reads the tree at `projectDirectory` and writes
 * products where the build system was told to — per recipe, because a whole build
 * and a module build of one tree write to different places. A recipe's
 * `outputDirectory` stays absent when the operator left it to the default, so the
 * default can move later without a stale copy of it pinned in every row.
 */
export const remoteServerRecord = z.object({
  /** The project the declaration belongs to. */
  workspaceId: z.string(),
  /** Short id, unique within the project. */
  serverId: z.string(),
  title: z.string(),
  destination: z.string(),
  /** Absolute server directory holding the checkout a run builds in. */
  projectDirectory: z.string(),
  /** Whether a run records the server-side source revision. */
  captureRevision: z.boolean().optional(),
  transport: transportSchema,
  /** Recipe id → the command it runs and the directory its products land in. */
  recipes: z.record(z.string(), remoteRecipeRecord),
  /** Absolute local `ssh` client path; absent means the platform default. */
  sshExecutable: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  /** ISO-8601 instant the declaration was written. */
  declaredAt: z.string(),
  /** ISO-8601 instant of the last probe, successful or not; absent until one runs. */
  lastProbeAt: z.string().optional(),
  /** Remote platform string observed by the last successful probe. */
  lastPlatform: z.string().optional(),
  /**
   * Why the last probe failed; absent once a probe succeeds.
   *
   * Stored rather than reported once, because the operator reads this from a list rendered after
   * the probe: a failure kept only in the answer that produced it would vanish on the next
   * reload, and the row would look like one that had never been tested.
   */
  lastProbeError: z.string().optional(),
})

/** One stored recipe, inferred from {@link remoteRecipeRecord}. */
export type RemoteRecipeRecord = z.infer<typeof remoteRecipeRecord>

/** One stored declaration, inferred from {@link remoteServerRecord}. */
export type RemoteServerRecord = z.infer<typeof remoteServerRecord>

/**
 * Durable shape of one verification run.
 *
 * `revisionDigest` is the SHA-256 of the server-side source revision the run
 * read, so two runs over the same tree are provably the same input — the
 * property an ASPICE verification record needs and a bare exit code does not
 * provide. It replaces the uploaded-archive digest the seam recorded while it
 * copied trees to the server; a tree that is already there has no archive, and
 * its revision is the same fact for a different mechanism. Absent when the
 * declaration did not ask for a revision, or the read failed (`revisionError`
 * then says why).
 */
export const remoteRunRecord = z.object({
  /** Generated run id. */
  runId: z.string(),
  workspaceId: z.string(),
  serverId: z.string(),
  recipe: z.string(),
  /** Server-side directory the recipe ran in. */
  projectDirectory: z.string(),
  /** Server-side directory the run's products were expected in, and fetched from. */
  outputDirectory: z.string(),
  /** The exact command line executed on the server. */
  command: z.string(),
  /** Source revision read before the run, when one was requested and succeeded. */
  revision: z.string().optional(),
  /** SHA-256 of the complete revision output. */
  revisionDigest: z.string().optional(),
  /** Why a requested revision read produced nothing. */
  revisionError: z.string().optional(),
  /** Exit code, or `null` when the client died from a signal. */
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** SHA-256 of the complete log, so a quoted excerpt can be traced to its run. */
  logSha256: z.string(),
  /** Bounded log tail kept for a compact ledger view. */
  logTail: z.string(),
  /** ISO-8601 instant the run settled. */
  finishedAt: z.string(),
})

/** One stored run, inferred from {@link remoteRunRecord}. */
export type RemoteRunRecord = z.infer<typeof remoteRunRecord>

/** Durable domain state: the declaration counter used to keep ids ordered. */
export const remoteDomainState = z.object({
  initialized: z.boolean(),
})

/** Registered run ids in completion order, so a ledger render is stable. */
export const remoteRunOrder = z.array(z.string()).default([])

/** Reads the run-order global as an array, tolerating a pre-field payload. */
export const remoteRunOrderRecord = z.object({
  initialized: z.boolean(),
  runIds: remoteRunOrder,
})

/**
 * The remote-build domain spec: declarations keyed by project/server, runs
 * keyed by run id, plus the ordered run-id list.
 *
 * Version 2 replaced the upload model: a declaration names the server-side
 * directory it builds in (`projectDirectory`) instead of a scratch root the
 * harness copied a tree into (`baseDirectory`), and a run records the source
 * revision it read instead of the digest of the archive it pushed. The two
 * shapes share no field that means the same thing, so version 1 records are
 * refused rather than read as version 2 — a declaration written for the old
 * model must be re-declared, and an operator told so is better served than one
 * whose server silently starts building in a directory the harness used to
 * fill. `compatibleVersions` therefore lists nothing.
 */
export const remoteDomainSpec = defineDomain({
  name: 'yxspec_remote',
  version: 2,
  global: {
    schema: remoteRunOrderRecord,
    initial: { initialized: false, runIds: [] },
  },
  tables: {
    servers: domainTable<string, RemoteServerRecord>(remoteServerRecord),
    runs: domainTable<string, RemoteRunRecord>(remoteRunRecord),
  },
})

/**
 * Key of one declaration row.
 *
 * A declaration belongs to exactly one project, and two projects may declare a
 * server with the same id, so the key carries both rather than the server id
 * alone.
 * @param workspaceId - the owning project's id.
 * @param serverId - the deployment's chosen server id.
 * @returns the combined row key.
 */
export function serverKey(workspaceId: string, serverId: string): string {
  return `${workspaceId}:${serverId}`
}
