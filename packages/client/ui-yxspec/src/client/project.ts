/**
 * Which project a blank home is about.
 *
 * The onboarding gate rides `conversation.hero.frame`, whose owner share belongs to the
 * conversation package and carries no project — a HOC layer that demanded one would force
 * every other layer's props to depend on this package's needs. The gate therefore resolves
 * the project itself, from the same two catalogues every other client surface reads.
 *
 * A blank home has no session and so no working directory to go by, which leaves the
 * catalogues:
 *
 * 1. the workspace owning the current main-view session, when there is one;
 * 2. otherwise the single registered project — with exactly one there is nothing to
 *    disambiguate;
 * 3. otherwise nothing.
 *
 * The third case is a real answer rather than a failure. A deployment holding two projects
 * and no selection genuinely does not know which one the operator is looking at, and the
 * wizard says so instead of gating the wrong project's specification. The rule is pure so
 * the gate and its tests agree on it without either owning a Context.
 *
 * There is a fourth input the gate adds on top: the project a walk of the wizard itself
 * created. Step 1 is where a project comes into existence, so for one moment the catalogues
 * cannot name it — and because a project with no roots has no path for `create` to match on,
 * every reload would otherwise create a second one. {@link resolveOnboardingProject} layers
 * that record over the catalogue rule without weakening it.
 * @module @deepseek-ai/dsh-client-ui-yxspec/project
 */

import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Resolve which project the blank home belongs to.
 *
 * Every read is defensive because the catalogues arrive independently: a workspace list
 * still pending, a session row whose summary has not landed, and a project whose sessions
 * have not been accounted yet all have to answer "not known" rather than throw.
 *
 * The answer is the branded identity the host hands out rather than a bare string: the gate
 * threads it into commands that address a project, and re-branding it at each call site would
 * be a cast this rule can simply not need.
 * @param workspaces - the Workspace Controller snapshot.
 * @param sessions - the Session list snapshot.
 * @returns the project id, or undefined while it cannot be determined.
 */
export function resolveProjectId(
  workspaces: WorkspaceSnapshot,
  sessions: SessionListState,
): WorkspaceId | undefined {
  if (workspaces.phase !== 'ready') return undefined
  // `retainedBy.mainView` counts the main-view bindings; more than zero names the session the
  // operator is actually looking at, as opposed to one merely listed in the sidebar.
  const current = sessions.ids.find(id => (sessions.byId[id]?.retainedBy.mainView ?? 0) > 0)
  if (current !== undefined) {
    const owning = workspaces.items.find(workspace => workspace.sessionIds.includes(current))
    if (owning !== undefined) return owning.workspaceId
  }
  return workspaces.items.length === 1 ? workspaces.items[0]?.workspaceId : undefined
}

/**
 * Resolve the project the wizard gates, preferring the one this walk created.
 *
 * The recorded target wins whenever it is still registered, because it is the more specific
 * claim: it is written by step 1 when the wizard creates a project, and it names exactly the
 * project this walk is onboarding. The catalogue rule below it is the discovery fallback for
 * a home the wizard has not created anything in yet — a pre-existing project to adopt, or the
 * single-project case.
 *
 * The two together cover what neither does alone. Before step 1 runs there is no target, and
 * the catalogues answer. Immediately after, the catalogues still describe the world before the
 * create — and a project created over no directory has no path for the host's idempotent
 * create to match on, so the wizard could neither see its own project nor find it again on
 * reload. The target closes both gaps.
 *
 * The target still has to be *in* the catalogue to be returned. A record outliving its project
 * — deleted from another surface, or a stale browser store — must not gate a project that is
 * not there; falling through to the catalogue rule is the recoverable answer.
 * @param workspaces - the Workspace Controller snapshot.
 * @param sessions - the Session list snapshot.
 * @param target - the project a recorded walk of the wizard created, when there is one.
 * @returns the project id, or undefined while it cannot be determined.
 */
export function resolveOnboardingProject(
  workspaces: WorkspaceSnapshot,
  sessions: SessionListState,
  target: WorkspaceId | undefined,
): WorkspaceId | undefined {
  // The same arrival guard the catalogue rule applies, and it has to come first: a half-arrived
  // list cannot confirm the recorded target is still registered any more than it can name one,
  // and a wizard opened over an unconfirmed id would gate the wrong project — or none.
  if (workspaces.phase !== 'ready') return undefined
  if (target !== undefined && workspaces.items.some(item => item.workspaceId === target)) return target
  return resolveProjectId(workspaces, sessions)
}
