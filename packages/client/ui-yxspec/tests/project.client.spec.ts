/**
 * Resolving which project a blank home belongs to.
 *
 * The gate cannot read the project off its own owner share — that share belongs to the
 * conversation package — so it derives one from the two catalogues the whole client already
 * reads. These specs pin the three-rung rule and, just as importantly, the cases where the
 * honest answer is "not known": a project list still arriving, a session whose owning project
 * has not been accounted, and two projects with nothing to disambiguate them. Gating the
 * wrong project's specification is worse than saying the wizard cannot tell.
 */

import { describe, expect, it } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { resolveOnboardingProject, resolveProjectId } from '../src/client/project.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

/** One project row; only the identity and its accounted sessions matter to the resolver. */
function project(id: string, sessionIds: readonly string[] = []): WorkspaceView {
  return {
    workspaceId: wid(id),
    roots: [`/${id}`],
    path: `/${id}`,
    title: id,
    sessionIds: sessionIds.map(sid),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspaces(
  items: readonly WorkspaceView[],
  phase: WorkspaceSnapshot['phase'] = 'ready',
): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds: [],
    pinnedSessionIds: [],
    state: 'idle',
    phase,
    error: null,
  }
}

/** One session row; `mainView` is the count the resolver reads to find the visible session. */
function sessions(
  rows: readonly { readonly id: string; readonly mainView?: number }[],
): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const row of rows) {
    byId[row.id] = {
      id: sid(row.id),
      displayTitle: row.id,
      running: false,
      blank: true,
      updatedAt: 1,
      retainedBy: { mainView: row.mainView ?? 0 },
    }
  }
  return { ids: rows.map(row => sid(row.id)), byId, phase: 'ready', projectionsBySession: {} }
}

describe('resolveProjectId', () => {
  it('names the project owning the session the main view shows', () => {
    const resolved = resolveProjectId(
      workspaces([project('alpha', ['s1']), project('beta', ['s2'])]),
      sessions([{ id: 's1', mainView: 1 }, { id: 's2' }]),
    )
    expect(resolved).toBe('alpha')
  })

  it('prefers the visible session over a merely listed one', () => {
    // Both sessions are catalog rows; only the second is bound into the main view, and the
    // sidebar listing the first must not decide which project the blank home is about.
    const resolved = resolveProjectId(
      workspaces([project('alpha', ['s1', 's3']), project('beta', ['s2'])]),
      sessions([{ id: 's3' }, { id: 's1' }, { id: 's2', mainView: 2 }]),
    )
    expect(resolved).toBe('beta')
  })

  it('falls back to the only registered project when no session is bound', () => {
    const resolved = resolveProjectId(
      workspaces([project('solo', ['s1'])]),
      sessions([{ id: 's1' }]),
    )
    expect(resolved).toBe('solo')
  })

  it('answers nothing when two projects are registered and no session selects one', () => {
    // A real answer, not a failure: the wizard says it cannot tell rather than gating the
    // wrong project's specification.
    expect(resolveProjectId(
      workspaces([project('alpha'), project('beta')]),
      sessions([]),
    )).toBeUndefined()
  })

  it('keeps looking past a visible session no project has accounted', () => {
    // The session list and the project list arrive independently; a visible session the
    // project list has not caught up with is a miss, and the single-project rung still holds.
    const resolved = resolveProjectId(
      workspaces([project('solo', [])]),
      sessions([{ id: 'unaccounted', mainView: 1 }]),
    )
    expect(resolved).toBe('solo')
  })

  it('answers nothing while the project list is still arriving', () => {
    // Gating on a half-arrived list would open the wizard over a project that is about to
    // be replaced; pending means "not known yet".
    expect(resolveProjectId(
      workspaces([project('solo')], 'pending'),
      sessions([]),
    )).toBeUndefined()
  })

  it('answers nothing with no projects at all', () => {
    expect(resolveProjectId(workspaces([]), sessions([]))).toBeUndefined()
  })

  it('tolerates a session row the catalog lists without a summary', () => {
    // `ids` and `byId` are written together in fact, but a read that trusted that would throw
    // during the window between the two, which is exactly when a blank home is being opened.
    const state = sessions([])
    state.ids.push(sid('ghost'))
    expect(resolveProjectId(workspaces([project('solo')]), state)).toBe('solo')
  })

  it('tolerates a binding count that is present but zero', () => {
    const resolved = resolveProjectId(
      workspaces([project('alpha', ['s1']), project('beta', ['s2'])]),
      sessions([{ id: 's1', mainView: 0 }, { id: 's2', mainView: 1 }]),
    )
    expect(resolved).toBe('beta')
  })
})

describe('resolveOnboardingProject', () => {
  it('name the project step 1 created, which the catalogues cannot yet describe', () => {    // The window this exists for: step 1 has created a project over no directory, the next
    // catalogue frame has not landed, and two rows are registered so the single-project rung
    // does not apply either. Only the recorded target names the project being onboarded.
    expect(resolveOnboardingProject(
      workspaces([project('created'), project('other')]),
      sessions([]),
      wid('created'),
    )).toBe('created')
  })

  it('prefers the recorded target when two projects leave the catalogues undecided', () => {
    // The shape a real first run reaches: the client auto-prepared a default project, the
    // operator walked step 1 and created a second one over no directory, and now two rows are
    // registered with no session to disambiguate. The catalogue rule honestly answers "not
    // known" here; the recorded target is what makes the wizard continue in its own project
    // instead of restarting from step 1.
    expect(resolveOnboardingProject(
      workspaces([project('created'), project('default-workspace')]),
      sessions([]),
      wid('created'),
    )).toBe('created')
  })

  it('falls back to the catalogue rule before step 1 has created anything', () => {
    const resolved = resolveOnboardingProject(
      workspaces([project('alpha', ['s1'])]),
      sessions([{ id: 's1', mainView: 1 }]),
      undefined,
    )
    expect(resolved).toBe('alpha')
  })

  it('ignores a recorded target whose project is gone', () => {
    // A stale browser store, or a project deleted from another surface: gating a project that
    // is not there is worse than reopening the wizard, which is what falling through does.
    expect(resolveOnboardingProject(
      workspaces([project('other')]),
      sessions([]),
      wid('deleted'),
    )).toBe('other')
  })

  it('answers nothing when neither the target nor the catalogues name a project', () => {
    expect(resolveOnboardingProject(workspaces([]), sessions([]), wid('deleted'))).toBeUndefined()
    expect(resolveOnboardingProject(workspaces([]), sessions([]), undefined)).toBeUndefined()
  })

  it('does not trust a target while the project list is still arriving', () => {
    // A half-arrived list cannot confirm the target exists, and `items` is empty until the
    // baseline lands; opening the wizard on an unconfirmed id would gate the wrong project.
    expect(resolveOnboardingProject(
      workspaces([project('created')], 'pending'),
      sessions([]),
      wid('created'),
    )).toBeUndefined()
  })
})
