/** Test-owned workspaces face: the renderer standard-kit observable plus recorded actions. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceCreateRequest } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { workspaceSnapshot } from './fixtures.ts'
import type { FixtureSnapshot, Stabilizer } from './fixtures.ts'

/** Writable test representation of the immutable Workspace Controller snapshot. */
type WorkspaceFixtureSnapshot = FixtureSnapshot<WorkspaceSnapshot>

/**
 * A complete Workspace projection for the echo defaults below. Every field the
 * production row carries is filled, so a new required field breaks this double
 * at compile time instead of being asserted past.
 * @param workspaceId - project identity.
 * @param fields - the row's variable parts; `createdAt`/`updatedAt` default to a fixed instant.
 * @returns the projection.
 */
function echoView(
  workspaceId: WorkspaceId,
  fields: { title: string; path: string | null; roots: readonly string[]; sessionIds: readonly SessionId[] },
): WorkspaceView {
  return {
    workspaceId,
    ...fields,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/** Callable command names on the production Workspace Controller face. */
type WorkspaceAction = {
  [Key in keyof IWorkspaces]: IWorkspaces[Key] extends (...args: never[]) => unknown ? Key : never
}[keyof IWorkspaces]

/** Test replacement retaining one Controller command's parameters and result. */
type WorkspaceStub<Key extends WorkspaceAction> = (
  ...args: Parameters<IWorkspaces[Key]>
) => ReturnType<IWorkspaces[Key]>

/**
 * Workspaces test double. Implements the same IWorkspaces face features
 * receive as `ctx.workspaces`, so a production face change breaks this
 * double at compile time. Every action records into {@link
 * TestWorkspaces.calls}; defaults are inert echoes — feature tests needing
 * richer behavior replace them via {@link TestWorkspaces.stub}.
 */
export class TestWorkspaces implements IWorkspaces {
  /** The useWorkspaces standard feed. */
  readonly list: SnapshotStore<WorkspaceFixtureSnapshot>

  /** Calls observed on the action face, newest last. */
  readonly calls: { method: string; args: unknown[] }[] = []

  /** Replaceable action seat: feature tests may stub richer behavior. */
  private readonly stubs = new Map<WorkspaceAction, (...args: unknown[]) => unknown>()

  /**
   * @param stabilize - the owning runtime's act wrapper.
   */
  constructor(private readonly stabilize: Stabilizer) {
    this.list = createSnapshotStore<WorkspaceFixtureSnapshot>({ ...workspaceSnapshot() })
  }

  /**
   * Update the workspace list state through an immer draft.
   * @param mutate - draft mutator.
   */
  async update(mutate: (draft: WorkspaceFixtureSnapshot) => void): Promise<void> {
    await this.stabilize(() => { this.list.update(mutate) })
  }

  /**
   * Replace an action's behavior (the recorded call is still appended first).
   * @param method - Controller action name (e.g. 'create').
   * @param impl - replacement behavior.
   */
  stub<Key extends WorkspaceAction>(method: Key, impl: WorkspaceStub<Key>): void {
    this.stubs.set(method, impl as (...args: unknown[]) => unknown)
  }

  /**
   * Create a Workspace (recorded). The default echoes a view derived from
   * the input; stub for failure or list-coupled flows.
   * @param input - the Host create payload: one directory, or the root list.
   * @returns the created Workspace view.
   */
  async create(input: WorkspaceCreateRequest): Promise<WorkspaceView> {
    this.calls.push({ method: 'create', args: [input] })
    const stub = this.stubs.get('create')
    if (stub !== undefined) return await (stub(input) as Promise<WorkspaceView>)
    // A multi-root create reports the whole list; the primary root is the first entry, which
    // is also what the single-directory form carries as `path`.
    const roots = input.roots ?? (input.path === undefined ? [] : [input.path])
    const primary = roots[0]
    return echoView(`ws-${primary ?? ''}` as WorkspaceId, {
      title: primary ?? '',
      path: primary ?? null,
      roots,
      sessionIds: [],
    })
  }

  /**
   * Append a repository root to an existing project (recorded). The default
   * echoes a view carrying the appended root.
   * @param workspaceId - project to extend.
   * @param path - directory to append as a non-primary root.
   * @returns the updated project view.
   */
  async addRoot(workspaceId: WorkspaceId, path: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'addRoot', args: [workspaceId, path] })
    const stub = this.stubs.get('addRoot')
    if (stub !== undefined) return await (stub(workspaceId, path) as Promise<WorkspaceView>)
    const existing = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    const roots = [...existing?.roots ?? [], path]
    return echoView(workspaceId, {
      title: existing?.title ?? path, path: roots[0] ?? null, roots, sessionIds: [],
    })
  }

  /**
   * Drop a repository root from a project (recorded). The default echoes a
   * view without the dropped root.
   * @param workspaceId - project to shrink.
   * @param path - directory to drop.
   * @returns the updated project view.
   */
  async removeRoot(workspaceId: WorkspaceId, path: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'removeRoot', args: [workspaceId, path] })
    const stub = this.stubs.get('removeRoot')
    if (stub !== undefined) return await (stub(workspaceId, path) as Promise<WorkspaceView>)
    const existing = this.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    const roots = (existing?.roots ?? []).filter(root => root !== path)
    return echoView(workspaceId, {
      title: existing?.title ?? path, path: roots[0] ?? null, roots, sessionIds: [],
    })
  }

  /**
   * Initialize the default Workspace through a test stub; defaults to an ineligible first use.
   * @param signal - caller lifetime.
   * @returns the stubbed Workspace, or undefined when initialization is ineligible.
   */
  async initializeDefault(signal?: AbortSignal): Promise<WorkspaceView | undefined> {
    this.calls.push({ method: 'initializeDefault', args: [signal] })
    const stub = this.stubs.get('initializeDefault')
    return await (stub?.(signal) as Promise<WorkspaceView | undefined> | undefined)
  }

  /**
   * Rename a Workspace (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param title - new title.
   * @returns the updated view.
   */
  async rename(workspaceId: WorkspaceId, title: string): Promise<WorkspaceView> {
    this.calls.push({ method: 'rename', args: [workspaceId, title] })
    const stub = this.stubs.get('rename')
    if (stub !== undefined) return await (stub(workspaceId, title) as Promise<WorkspaceView>)
    return echoView(workspaceId, { title, path: `/${title}`, roots: [`/${title}`], sessionIds: [] })
  }

  /**
   * Delete a Workspace (recorded; default no-op).
   * @param workspaceId - target workspace.
   */
  async delete(workspaceId: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'delete', args: [workspaceId] })
    await (this.stubs.get('delete')?.(workspaceId) as Promise<void> | undefined)
  }

  /**
   * Move a Workspace in display order (recorded; default no-op).
   * @param workspaceId - Workspace to move.
   * @param beforeWorkspaceId - Anchor; omitted appends.
   */
  async insertBefore(workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId): Promise<void> {
    this.calls.push({ method: 'insertBefore', args: [workspaceId, beforeWorkspaceId] })
    await (this.stubs.get('insertBefore')?.(workspaceId, beforeWorkspaceId) as Promise<void> | undefined)
  }

  /**
   * Move an accounted session (recorded). The default echoes a minimal view.
   * @param workspaceId - target workspace.
   * @param sessionId - session to move.
   * @param beforeSessionId - anchor; omitted appends.
   * @returns the updated view.
   */
  async insertSessionBefore(workspaceId: WorkspaceId, sessionId: SessionId, beforeSessionId?: SessionId): Promise<WorkspaceView> {
    this.calls.push({ method: 'insertSessionBefore', args: [workspaceId, sessionId, beforeSessionId] })
    const stub = this.stubs.get('insertSessionBefore')
    if (stub !== undefined) return await (stub(workspaceId, sessionId, beforeSessionId) as Promise<WorkspaceView>)
    return echoView(workspaceId, { title: '', path: null, roots: [], sessionIds: [sessionId] })
  }

  /**
   * Archive a session (recorded). The default mirrors the production face's
   * observable effect: the id joins the list state's archive set.
   * @param sessionId - session to archive.
   */
  async archiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'archiveSession', args: [sessionId] })
    const stub = this.stubs.get('archiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = [...draft.archivedSessionIds, sessionId]
    })
  }

  /**
   * Unarchive a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's archive set.
   * @param sessionId - session to unarchive.
   */
  async unarchiveSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unarchiveSession', args: [sessionId] })
    const stub = this.stubs.get('unarchiveSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.archivedSessionIds = draft.archivedSessionIds.filter(id => id !== sessionId)
    })
  }

  /**
   * Pin a session (recorded). The default mirrors the production face's
   * observable effect: the id leads the list state's pin set.
   * @param sessionId - session to pin.
   */
  async pinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'pinSession', args: [sessionId] })
    const stub = this.stubs.get('pinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = [
        sessionId,
        ...draft.pinnedSessionIds.filter(id => id !== sessionId),
      ]
    })
  }

  /**
   * Unpin a session (recorded). The default mirrors the production face's
   * observable effect: the id leaves the list state's pin set.
   * @param sessionId - session to unpin.
   */
  async unpinSession(sessionId: SessionId): Promise<void> {
    this.calls.push({ method: 'unpinSession', args: [sessionId] })
    const stub = this.stubs.get('unpinSession')
    if (stub !== undefined) {
      await (stub(sessionId) as Promise<void>)
      return
    }
    await this.update((draft) => {
      draft.pinnedSessionIds = draft.pinnedSessionIds.filter(id => id !== sessionId)
    })
  }
}
