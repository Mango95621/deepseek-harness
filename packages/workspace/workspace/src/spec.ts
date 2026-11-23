/**
 * The workspace domain declaration: record schema and the `defineDomain` spec
 * the registry opens. The zod schema validates the shipped format at the
 * durability boundary and is the direct source of a future RPC wire projection.
 * @module @deepseek-ai/dsh-workspace/src/spec
 */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from './types.ts'

/** Workspace id schema at the durable boundary; branding has no runtime representation. */
const workspaceId = z.string().transform(value => value as WorkspaceId)

const sessionId = z.string().transform(value => brandString<SessionId>(value))

/**
 * Durable shape of one workspace record. `roots` are the `fs.realpath` canons
 * stamped at create, in the order the user declared them; the first entry is
 * the primary root and supplies the working directory of every session
 * created against this workspace. `sessionIds` is the ordered ownership
 * account (array order is display order); timestamps are ISO-8601 strings.
 *
 * A workspace carries one code repository per root, which is why a vehicle
 * electronics project can hold several: a delivery unit regularly spans an IVI
 * application, MCU firmware, and a vendored AOSP tree at once.
 *
 * `roots` may be **empty**, which is the state a project is in between being
 * named and having its first repository declared. Naming a project and pointing
 * it at repositories are two separate acts: the project's identity is its
 * title, and a multi-repository project's directories are chosen afterwards
 * rather than guessed at creation. The registry then carries no primary root
 * and {@link Workspace.path} reads as `undefined` until one is added — every
 * consumer that needs a working directory has to say what it does instead,
 * which is the point: there is no directory to silently inherit.
 *
 * Records written before multi-root support stored a single `path`. The
 * preprocess step lifts that field into a one-element `roots` array, so the
 * v2 shape parses without a startup migration write — the same
 * `compatibleVersions` discipline the schedule domain uses.
 */
export const workspaceRecord = z.preprocess(
  (value) => {
    if (typeof value !== 'object' || value === null) return value
    const record = value as Record<string, unknown>
    if (record.roots !== undefined) return record
    if (typeof record.path !== 'string') return record
    const { path, ...rest } = record
    return { ...rest, roots: [path] }
  },
  z.object({
    roots: z.array(z.string()),
    title: z.string(),
    sessionIds: z.array(sessionId),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
)

/** One stored workspace record, inferred from {@link workspaceRecord}. */
export type WorkspaceRecord = z.infer<typeof workspaceRecord>

/**
 * Recoverable two-write mutation marker. The marker is persisted before the
 * record/order pair can diverge, so startup can distinguish an interrupted
 * registry operation from unexplained medium corruption.
 */
const workspacePendingMutation = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), workspaceId }),
  z.object({ operation: z.literal('delete'), workspaceId }),
])

/**
 * Durable registry state. `initialized` distinguishes a valid empty registry
 * from one that still needs the header-only history bootstrap;
 * `workspaceIds` is the authoritative display order. `archivedSessionIds` is
 * the registry-global archive set layered over workspace accounting: an
 * archived session keeps its `sessionIds` slot (unarchiving must restore the
 * position), so the set never participates in the one-owner accounting
 * invariant. `pinnedSessionIds` is the registry-global pin set in pin order
 * (most recently pinned first); pinning and archival are mutually
 * exclusive, so archiving drops the session's pin. Both session sets are
 * defaulted so records written before the fields parse unchanged.
 */
export const workspaceDomainState = z.object({
  initialized: z.boolean(),
  /** First-use Workspace identity, retained after its registration is deleted. */
  defaultWorkspaceId: workspaceId.optional(),
  workspaceIds: z.array(workspaceId),
  archivedSessionIds: z.array(sessionId).default([]),
  pinnedSessionIds: z.array(sessionId).default([]),
  pendingMutation: workspacePendingMutation.optional(),
})

/** Durable registry state inferred from {@link workspaceDomainState}. */
export type WorkspaceDomainState = z.infer<typeof workspaceDomainState>

/**
 * The workspace domain spec: one `workspaces` table keyed by
 * {@link WorkspaceId} plus the bootstrap/order singleton. The registry opens
 * this through `ctx.storage.domain`; the spec object is the single source of
 * the domain's identity, version, and schemas.
 *
 * v3 widens the record from one `path` to many `roots`. v2 is declared
 * compatible, so an existing installation keeps reading its records; the
 * schema's preprocess step lifts each legacy `path` into `roots: [path]` on
 * read rather than rewriting storage at startup.
 */
export const workspaceDomainSpec = defineDomain({
  name: 'workspace',
  version: 3,
  compatibleVersions: [2],
  global: {
    schema: workspaceDomainState,
    initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] },
  },
  tables: { workspaces: domainTable<WorkspaceId, WorkspaceRecord>(workspaceRecord) },
})
