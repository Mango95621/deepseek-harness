/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceAddRootRequest,
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRemoveRootRequest,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create or resolve one project.
   *
   * A request naming several roots creates a multi-repository project in one
   * call. Reuse resolves on any declared root, so asking for a directory a
   * project already covers returns that project rather than a second one.
   *
   * A request naming **no** directory creates a project from its name alone —
   * the shape a client uses when it asks for the project first and attaches its
   * repositories afterwards through {@link addRoot}. Such a project has no
   * primary root, so no session can be attached to it until one root exists;
   * that refusal comes from the registry, not from here.
   * @param request - one directory, the root list (primary first), or neither plus a title.
   * @returns the project and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    const requested = request.roots ?? (request.path === undefined ? [] : [request.path])
    const primary = requested[0]
    const title = request.title?.trim()
    const named = title === undefined || title === '' ? undefined : title
    if (primary === undefined && named === undefined) {
      return Promise.reject(new RemoteError(
        'gateway/bad-request',
        'creating a project requires a directory path, a non-empty roots list, or a title',
        {},
      ))
    }
    return this.enqueue(async () => {
      try {
        const existing = primary === undefined
          ? undefined
          : await this.ctx.workspaceRegistry.resolveByPath(primary)
        if (existing !== undefined) {
          return { workspace: workspaceView(existing), created: false }
        }
        const workspace = await this.ctx.workspaceRegistry.create(requested, named)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          primary === undefined
            ? `cannot create a project named "${named}": ${errorMessage(error)}`
            : `cannot create a project at "${primary}": ${errorMessage(error)}`,
          // The guard at the top of this method rejects the call that would
          // leave both absent, so one of the two always names the request.
          /* v8 ignore next -- guarded above: a path or a title is always present. */
          { path: primary ?? named ?? '' },
          { cause: error },
        )
      }
    })
  }

  /**
   * Append a repository root to an existing project. The added root is never
   * promoted to primary, so a project's working directory cannot change by
   * accident.
   * @param request - project identity and the directory to append.
   * @returns the updated project projection.
   */
  addRoot(request: WorkspaceAddRootRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      try {
        await this.ctx.workspaceRegistry.addRoot(request.workspaceId, request.path)
      } catch (error) {
        throw new RemoteError(
          'workspace/root-invalid',
          `cannot add root "${request.path}" to project "${workspace.title}": ${errorMessage(error)}`,
          { workspaceId: request.workspaceId, path: request.path },
          { cause: error },
        )
      }
      return { workspace: workspaceView(this.requireWorkspace(request.workspaceId)) }
    })
  }

  /**
   * Drop a repository root from a project. Removing the last root is allowed:
   * the project then declares no repository and rejects session attachment
   * until one is added back.
   * @param request - project identity and the directory to drop.
   * @returns the updated project projection.
   */
  removeRoot(request: WorkspaceRemoveRootRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      try {
        await this.ctx.workspaceRegistry.removeRoot(request.workspaceId, request.path)
      } catch (error) {
        throw new RemoteError(
          'workspace/root-invalid',
          `cannot remove root "${request.path}" from project "${workspace.title}": ${errorMessage(error)}`,
          { workspaceId: request.workspaceId, path: request.path },
          { cause: error },
        )
      }
      return { workspace: workspaceView(this.requireWorkspace(request.workspaceId)) }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(brandString<WorkspaceId>(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        brandString<WorkspaceId>(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : brandString<WorkspaceId>(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(brandString<WorkspaceId>(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
