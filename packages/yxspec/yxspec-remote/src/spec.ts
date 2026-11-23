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
 * Durable shape of one declared build server, keyed by `${workspaceId}:${serverId}`.
 *
 * Credentials are absent by construction: the destination is an OpenSSH
 * destination resolved against the host's own `~/.ssh/config`, so the key
 * material never enters this record and cannot leak through an export.
 */
export const remoteServerRecord = z.object({
  /** The project the declaration belongs to. */
  workspaceId: z.string(),
  /** Short id, unique within the project. */
  serverId: z.string(),
  title: z.string(),
  destination: z.string(),
  baseDirectory: z.string(),
  transport: transportSchema,
  /** Recipe id → server-side command template containing a `{cwd}` token. */
  recipes: z.record(z.string(), z.string()),
  /** Absolute local `ssh` client path; absent means the platform default. */
  sshExecutable: z.string().optional(),
  timeoutMs: z.number().int().positive(),
  /** ISO-8601 instant the declaration was written. */
  declaredAt: z.string(),
  /** ISO-8601 instant of the last successful probe; absent until one succeeds. */
  lastProbeAt: z.string().optional(),
  /** Remote platform string observed by the last successful probe. */
  lastPlatform: z.string().optional(),
})

/** One stored declaration, inferred from {@link remoteServerRecord}. */
export type RemoteServerRecord = z.infer<typeof remoteServerRecord>

/**
 * Durable shape of one verification run.
 *
 * `treeDigest` is the hash of the pushed archive, so two runs over the same
 * source are provably the same input — the property an ASPICE verification
 * record needs and a bare exit code does not provide.
 */
export const remoteRunRecord = z.object({
  /** Generated run id. */
  runId: z.string(),
  workspaceId: z.string(),
  serverId: z.string(),
  recipe: z.string(),
  /** Server-side directory the recipe ran in. */
  remoteDirectory: z.string(),
  /** Digest of the pushed archive; absent when the run skipped the push. */
  treeDigest: z.string().optional(),
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
 * Version 1 is the initial shape; there is nothing older to admit.
 */
export const remoteDomainSpec = defineDomain({
  name: 'yxspec_remote',
  version: 1,
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
