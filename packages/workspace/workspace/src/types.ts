/**
 * Public type vocabulary of the workspace entity: the `WorkspaceId` brand and
 * the `Workspace` consumer interface. Types only — the `WorkspaceId` factory
 * lives in `index.ts` (this file carries no runtime code).
 * @module @deepseek-ai/dsh-workspace/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** One Workspace; the Workspace Controller registers its default `workspaceId` wire field. */
    workspace: TypertResource<WorkspaceId>
  }

  interface RemoteErrorDetailsMap {
    /** No registration carries that Workspace identity. */
    'workspace/not-found': { readonly workspaceId: WorkspaceId }
  }
}

/**
 * Activity families a `workspace/session-activity` listener may report. This
 * package declares none: each provider merges its own key from a module both
 * its Host and Client faces import, so a consumer that renders the families
 * sees exactly the keys its program compiled and falls through to a generic
 * description for any other. The shipped providers merge `turn` (the Agent
 * registry), `job` (the job registry seam), `subagent` (the Subagent
 * runtime), and `schedule` (the Schedule plugin).
 */
export interface SessionActivityKindMap {}

/** One activity family key. */
export type SessionActivityKind = keyof SessionActivityKindMap

/** One active item of a family that has per-item identity. */
export interface SessionActivityItem {
  /** Family-specific identity: a session id, a job id, or a schedule id. */
  readonly id: string
  /** Display label when the family carries one (a job label, a subagent label). */
  readonly label?: string
}

/**
 * One reason a session counts as active for archive admission. Families with
 * per-item identity list their items so a caller can name what must stop.
 */
export interface SessionActivity {
  readonly kind: SessionActivityKind
  /** Active items of the family; absent for a family without per-item identity (`turn`). */
  readonly items?: readonly SessionActivityItem[]
}

/**
 * One project: a stable id over zero or more existing code-repository
 * directories, a display title, and an ordered candidate account of sessions.
 * Membership validates header cwd against the project's roots, but preserves
 * an existing account when its fully qualified cwd is missing. Consumers only
 * see this interface; the implementation stays private.
 */
export interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Every canonical repository root of this project, in the order the user
   * declared them: each is the `fs.realpath` of the path given at create time
   * (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when a directory disappears (see {@link status}).
   *
   * A vehicle electronics project normally spans several repositories — an IVI
   * application, MCU firmware, and a vendored AOSP tree — so this is almost
   * always longer than one. The first entry is the primary root.
   *
   * Empty for a project that has been named but not yet pointed at any
   * repository. That is a normal intermediate state rather than an error: a
   * project's directories are declared after its identity, and a caller that
   * needs a working directory must decide what to do without one instead of
   * silently inheriting the project directory.
   */
  readonly roots: readonly string[]

  /**
   * The primary root: `roots[0]`. This is the working directory every session
   * created against this project gets, and the base for relative paths and
   * file-tree display.
   *
   * `undefined` while {@link roots} is empty. It is its own accessor because
   * the overwhelming majority of consumers want exactly this one path and
   * should not have to index an array; the `undefined` is what forces those
   * consumers to handle the not-yet-configured project rather than assume a
   * directory exists.
   */
  readonly path: string | undefined

  /** Display title. Defaults to the final path segment of the primary root; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: missing headers, invalid cwd values,
   * and canonical cwd mismatches are never returned. A fully qualified cwd
   * whose realpath or directory stat fails with ENOENT preserves an existing
   * candidate, including a dangling symlink; other filesystem failures do not.
   * A subsequent mutation prunes filtered candidates, not missing-directory
   * candidates. This does not admit new sessions or recreate directories.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * List the stored headers of the current members.
   * @returns a new array with one header per entry of {@link sessionIds}, in the same order.
   */
  getSessionHeaders(): readonly SessionHeader[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this project's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to one of
   * {@link roots}; unknown ids, missing or invalid cwd values, and mismatches
   * reject without writing.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable filtered-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. Idempotent: an id not on
   * the account resolves without writing, aside from the durable
   * filtered-candidate prune every accepted mutation performs; decided on
   * the domain write chain like attach. Never touches the session's own stored log.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether every one of {@link roots}
   * currently exists and is a directory. A missing directory never mutates the
   * record — the directory may only be temporarily moved.
   * @returns `'ok'` when every root exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
