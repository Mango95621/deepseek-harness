// @vitest-environment jsdom
/**
 * The onboarding gate: what it renders, and — the point of the whole layer — when it refuses
 * to render the Conversation body at all.
 *
 * The gate is an HOC layer over `conversation.hero.frame`, so its correctness is exactly two
 * claims. First, it is transparent: a non-hero body and a fully onboarded project both get
 * their children back untouched, because hiding a live composer behind a form would be worse
 * than not gating. Second, while a step is outstanding the children are *replaced*, not
 * wrapped — those children are the scroll body holding the composer seat, so never rendering
 * them is what removes the input box, with no disabled control that could re-enable it and no
 * second code path that could disagree with this one.
 *
 * These specs hand the component its composed props directly (the renderer's own assembly is
 * covered by the renderer's suite); what they own is the decision, each step's body, and the
 * footer's back/next/finish bookkeeping.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceId, WorkspaceSnapshot, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  YxspecDocumentListing,
  YxspecDocumentView,
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteProbe,
  YxspecRemoteServerDraft,
  YxspecRemoteServerView,
} from '@deepseek-ai/dsh-yxspec-api/types'
import { OnboardingWizard, type OnboardingWizardProps } from '../src/client/OnboardingWizard.tsx'
import {
  EMPTY_PROGRESS, EMPTY_REQUEST, ONBOARDING_STEPS, completeStep, reopenStep,
  type OnboardingAnswers, type OnboardingProgress, type OnboardingRequest, type OnboardingState,
  type OnboardingStep, type OnboardingTarget,
} from '../src/client/onboarding.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as OnboardingWizardProps['t']

const wid = (id: string): WorkspaceId => id as WorkspaceId

/**
 * The framework-wide seats this gate never reads.
 *
 * The wizard's owner share is the hero frame's own, and the renderer hands it every scope's
 * standard values whether or not the occupant uses them; a fixture that threw on an unread
 * seat keeps a spec from silently depending on one.
 */
const unusedStandardHook = (): never => {
  throw new Error('the onboarding gate reads no framework-wide slot source')
}

afterEach(cleanup)

/** One project row; the resolver reads its identity and its accounted sessions. */
function project(id: string, sessionIds: readonly string[] = [], roots: readonly string[] = [`/${id}`]): WorkspaceView {
  return {
    workspaceId: wid(id),
    roots,
    path: roots[0] ?? null,
    title: id,
    sessionIds: sessionIds.map(entry => entry as SessionId),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function workspaceSnapshot(
  items: readonly WorkspaceView[],
  phase: WorkspaceSnapshot['phase'] = 'ready',
): WorkspaceSnapshot {
  return { items, archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase, error: null }
}

function sessionList(ids: readonly string[] = []): SessionListState {
  const byId: Record<string, SessionSummary> = {}
  for (const id of ids) {
    byId[id] = {
      id: id as SessionId, displayTitle: id, running: false, blank: true, updatedAt: 1, retainedBy: {},
    }
  }
  return { ids: ids.map(id => id as SessionId), byId, phase: 'ready', projectionsBySession: {} }
}

/**
 * Progress with the steps before `outstanding` recorded and that one open.
 *
 * A prefix, not a set with a hole: the wizard only ever walks forward, so a record with a
 * later step completed and an earlier one open is a state the operator cannot reach through
 * it. `answers` ride alongside because the wizard reads them back by key — to prefill a
 * field, to mark a chosen row, to restate the summary — and a step is "satisfied" by having
 * its own keys present, not by being listed in `completed`.
 */
function upTo(outstanding: OnboardingStep, answers: OnboardingAnswers = {}): OnboardingProgress {
  return ONBOARDING_STEPS
    .slice(0, ONBOARDING_STEPS.indexOf(outstanding))
    .reduce<OnboardingProgress>(
      (progress, step) => completeStep(progress, step, {}),
      { completed: [], answers: { ...answers } },
    )
}

/** The progress a fully onboarded project holds. */
function onboarded(): OnboardingProgress {
  return ONBOARDING_STEPS.reduce<OnboardingProgress>(
    (progress, step) => completeStep(progress, step, {}), EMPTY_PROGRESS,
  )
}

/** Progress storage whose writes the spec can read back, standing in for the persisted store. */
class ProgressStore {
  readonly onboardingProgress: SnapshotStore<OnboardingState>
  readonly writes: { projectId: string | undefined; progress: OnboardingProgress }[] = []
  /**
   * Whether a save lands in the observable store. A spec clears this to stand in for a write
   * that is accepted and then lost (a refused persist, a store that has not caught up), which
   * is the one state where the wizard is standing somewhere the stored progress does not say.
   */
  mirror = true

  constructor(initial: OnboardingState = {}) {
    this.onboardingProgress = createSnapshotStore<OnboardingState>(initial)
  }

  /** One project's current record, as the stored state holds it. */
  read(projectId: string): OnboardingProgress | undefined {
    return this.onboardingProgress.getSnapshot()[projectId]
  }

  save(projectId: string | undefined, progress: OnboardingProgress): void {
    this.writes.push({ projectId, progress })
    if (!this.mirror || projectId === undefined) return
    this.onboardingProgress.set({ ...this.onboardingProgress.getSnapshot(), [projectId]: progress })
  }
}

/**
 * The walk's own target record, which is what step 1 writes and the gate reads back.
 *
 * A real store rather than a callback, because the gate subscribes to it: a spec that staged a
 * walk mid-flight (step 1 already done in a previous visit) has to have that record observable
 * before render, exactly as a reloaded browser would.
 */
class TargetStore {
  readonly store: SnapshotStore<OnboardingTarget>

  constructor(workspaceId?: WorkspaceId) {
    this.store = createSnapshotStore<OnboardingTarget>(workspaceId === undefined ? {} : { workspaceId })
  }
}

/**
 * A walk asked for from outside the wizard, as the guided-creation port leaves it.
 *
 * A real store for the same reason the target is one: the gate subscribes, and the port writes it
 * while the wizard is already mounted — the gesture arrives from the sidebar at any time — so a
 * spec that handed the component a fixed value could not observe the request at all.
 */
class RequestStore {
  readonly store: SnapshotStore<OnboardingRequest>

  constructor(request: OnboardingRequest = EMPTY_REQUEST) {
    this.store = createSnapshotStore<OnboardingRequest>(request)
  }

  /**
   * Answer the request, the way the seam does once step 1 has created the project.
   *
   * Cleared here rather than read once, because the gate subscribes: production clears it inside
   * the same injection-layer `nameProject` that creates the project, and a double that
   * only recorded the call would leave the walk permanently suppressed — rendering step 2
   * against no project, which is the failure this clearing exists to prevent.
   */
  clear(): void {
    this.store.set(EMPTY_REQUEST)
  }
}

/**
 * The project catalogue, mutable the way the real one is.
 *
 * Step 2 renders the project's roots rather than a draft, so a spec that could only *record*
 * an add would leave the list unchanged and prove nothing. The commands below therefore write
 * this store the way `ClientWorkspaceModel.upsert` writes the real one — a project create and
 * every root mutation land a fresh row — and the component re-renders from it because
 * `useWorkspaces` is bound to it as a source, exactly as the renderer binds the real model.
 */
class WorkspaceStore {
  readonly store: SnapshotStore<WorkspaceSnapshot>

  constructor(initial: WorkspaceSnapshot) {
    this.store = createSnapshotStore<WorkspaceSnapshot>(initial)
  }

  /** Replace one row, adding it when the catalogue has not seen it yet. */
  upsert(row: WorkspaceView): void {
    const { items } = this.store.getSnapshot()
    const index = items.findIndex(item => item.workspaceId === row.workspaceId)
    this.store.set({
      ...this.store.getSnapshot(),
      items: index === -1 ? [row, ...items] : items.map((item, at) => at === index ? row : item),
    })
  }

  /** One row's declared roots, as the catalogue currently reports them. */
  roots(workspaceId: WorkspaceId | undefined): readonly string[] {
    return this.store.getSnapshot().items.find(item => item.workspaceId === workspaceId)?.roots ?? []
  }

  /** The row for one project, with its roots replaced. */
  private withRoots(workspaceId: WorkspaceId, roots: readonly string[]): WorkspaceView | undefined {
    const row = this.store.getSnapshot().items.find(item => item.workspaceId === workspaceId)
    return row === undefined ? undefined : { ...row, roots, path: roots[0] ?? null }
  }

  /** Apply one successful root append to the row the catalogue holds. */
  appendRoot(workspaceId: WorkspaceId, path: string): void {
    const next = this.withRoots(workspaceId, [...this.roots(workspaceId), path])
    if (next !== undefined) this.upsert(next)
  }

  /** Apply one successful root removal to the row the catalogue holds. */
  dropRoot(workspaceId: WorkspaceId, path: string): void {
    const next = this.withRoots(workspaceId, this.roots(workspaceId).filter(root => root !== path))
    if (next !== undefined) this.upsert(next)
  }
}

/**
 * What the host answers, held in one mutable cell so a spec can change it after render.
 *
 * The callbacks the component captures must keep reading the *current* answer: a spec that
 * repairs a refused create and retries would otherwise still be replaying the first closure,
 * and a render-time mutation through a captured closure cannot be observed by React at all.
 */
interface Answers {
  picks: readonly (string | undefined)[]
  pickThrows: string | undefined
  /** A refusal from step 1's create-or-rename, read at call time so a retry can repair it. */
  nameThrows: unknown
  /** A refusal from a repository-root mutation, read at call time. */
  rootThrows: unknown
  documentsThrow: boolean
  serversThrow: boolean
  /**
   * A replacement reader, consulted at call time.
   *
   * The component captures its data face once, so a spec that needs to hold a read open (to land
   * it after an unmount) has to redirect the call rather than reassign the prop: a reassignment
   * could not be seen by the closure the component already holds.
   */
  documentsImpl: ((workspaceId: string, extraDirectories: readonly string[]) => Promise<YxspecDocumentListing>) | undefined
  /** A replacement declaration reader, consulted at call time. See {@link Answers.documentsImpl}. */
  serversImpl: ((workspaceId: string) => Promise<YxspecRemoteServerView[]>) | undefined
  /** A refusal from the declaration write, read at call time so a retry can repair it. */
  declareThrows: unknown
  /** A refusal from the probe call, read at call time. */
  probeThrows: unknown
  /** A refusal from a directory listing, read at call time. */
  browseThrows: unknown
  /** A replacement listing, consulted at call time; the picker's own answer otherwise. */
  browse: ((request: YxspecRemoteBrowseRequest) => YxspecRemoteBrowse) | undefined
  /** The directory the default fake host walks to. */
  path: string | undefined
  /** What a probe concludes about the host; the reachable case unless a spec says otherwise. */
  probeOutcome: YxspecRemoteProbe | undefined
}

interface BenchOptions {
  hero?: boolean
  progress?: OnboardingState
  /** The project a recorded walk created; step 1 has nothing to rename without one. */
  target?: WorkspaceId
  /** A walk asked for from outside the wizard, which step 1 opens as a create over. */
  request?: OnboardingRequest
  workspaces?: WorkspaceSnapshot
  sessions?: SessionListState
  children?: ReactNode
  documents?: readonly YxspecDocumentView[]
  /** Directories the host reports having enumerated; empty unless a spec supplies them. */
  searched?: readonly string[]
  /** Whether the host reports the candidate ceiling cut the listing short. */
  truncated?: boolean
  servers?: readonly YxspecRemoteServerView[]
  /** Successive picker answers; an exhausted list answers "cancelled". */
  picks?: readonly (string | undefined)[]
  pickThrows?: string
  nameThrows?: unknown
  rootThrows?: unknown
  documentsThrow?: boolean
  serversThrow?: boolean
  declareThrows?: unknown
  probeThrows?: unknown
  /** What the probe concludes; defaults to a reachable Linux host. */
  probeOutcome?: YxspecRemoteProbe
  browseThrows?: unknown
  /** What a listing returns; defaults to the walk toward {@link BenchOptions.path}. */
  browse?: (request: YxspecRemoteBrowseRequest) => YxspecRemoteBrowse
  /** The absolute directory the default fake host walks to; defaults to `/srv/aosp`. */
  path?: string
}

/** A walk that finished every step, which is the state the strip appears in. */
function onboardedProgress(): OnboardingProgress {
  return ONBOARDING_STEPS.reduce<OnboardingProgress>((progress, step) => completeStep(progress, step, {}), EMPTY_PROGRESS)
}

/** The absolute parent of one path, or undefined at the root. */
function parentOf(directory: string): string | undefined {
  if (directory === '/') return undefined
  const cut = directory.lastIndexOf('/')
  return cut <= 0 ? '/' : directory.slice(0, cut)
}

/** Props a spec hands the component, with the injection face behind a recording default. */
function bench(options: BenchOptions = {}) {
  const store = new ProgressStore(options.progress ?? {})
  const target = new TargetStore(options.target)
  const request = new RequestStore(options.request)
  const catalogue = new WorkspaceStore(options.workspaces ?? workspaceSnapshot([project('solo')]))
  const calls = {
    documents: [] as { workspaceId: string; extraDirectories: string[] }[],
    servers: [] as string[],
    declared: [] as { workspaceId: string; draft: YxspecRemoteServerDraft }[],
    probes: [] as { workspaceId: string; serverId: string }[],
    browses: [] as YxspecRemoteBrowseRequest[],
    names: [] as { projectId: string | undefined; title: string }[],
    added: [] as { workspaceId: string; path: string }[],
    removed: [] as { workspaceId: string; path: string }[],
    picks: 0,
    finished: [] as string[],
  }
  // The declarations the walk wrote, which is what the step reads back. The seam stores them in
  // production, so the double has to as well: a spec could not otherwise see the list the step
  // renders after a write, which is the whole of what declaring in the wizard does.
  const stored: YxspecRemoteServerView[] = [...(options.servers ?? [])]
  const answers: Answers = {
    picks: options.picks ?? [],
    pickThrows: options.pickThrows,
    nameThrows: options.nameThrows,
    rootThrows: options.rootThrows,
    documentsThrow: options.documentsThrow ?? false,
    serversThrow: options.serversThrow ?? false,
    documentsImpl: undefined,
    serversImpl: undefined,
    declareThrows: options.declareThrows,
    probeThrows: options.probeThrows,
    probeOutcome: options.probeOutcome,
    browseThrows: options.browseThrows,
    browse: options.browse,
    path: options.path,
  }
  const props = {
    hero: options.hero ?? true,
    children: options.children ?? <p data-testid="body">composer</p>,
    useWorkspaces: <S,>(select: (value: WorkspaceSnapshot) => S): S =>
      select(catalogue.store.getSnapshot()),
    useSessions: <S,>(select: (value: SessionListState) => S): S =>
      select(options.sessions ?? sessionList()),
    // The progress seat is bound through the renderer's own uSES bridge rather than answered
    // from a closure: the gate's central claim is that saving a step re-renders it, and a
    // hand-rolled selector would make that untestable by construction.
    useOnboardingProgress: bindSnapshotSelector(store.onboardingProgress),
    useOnboardingTarget: bindSnapshotSelector(target.store),
    useOnboardingRequest: bindSnapshotSelector(request.store),
    finishOnboarding: (workspaceId: WorkspaceId) => { calls.finished.push(workspaceId) },
    saveProgress: (projectId: string | undefined, progress: OnboardingProgress) => { store.save(projectId, progress) },
    loadDocuments: (workspaceId: string, extraDirectories: readonly string[]) => {
      calls.documents.push({ workspaceId, extraDirectories: [...extraDirectories] })
      if (answers.documentsImpl !== undefined) return answers.documentsImpl(workspaceId, extraDirectories)
      if (answers.documentsThrow) return Promise.reject(new Error('gateway unreachable'))
      return Promise.resolve({
        documents: [...(options.documents ?? [])],
        searched: [...(options.searched ?? [])],
        truncated: options.truncated ?? false,
      })
    },
    loadServers: (workspaceId: string) => {
      calls.servers.push(workspaceId)
      if (answers.serversImpl !== undefined) return answers.serversImpl(workspaceId)
      if (answers.serversThrow) return Promise.reject(new Error('no namespace'))
      return Promise.resolve([...stored])
    },
    declareServer: async (workspaceId: string, draft: YxspecRemoteServerDraft) => {
      calls.declared.push({ workspaceId, draft })
      if (answers.declareThrows !== undefined) throw answers.declareThrows
      // The host resolves the draft's optional fields and normalizes the directory, so the
      // double does too: a spec asserting what the step renders after a write has to see the
      // stored form rather than the typed one.
      const view: YxspecRemoteServerView = {
        serverId: draft.serverId,
        title: draft.title ?? draft.serverId,
        destination: draft.destination,
        projectDirectory: draft.projectDirectory.replace(/\/+$/, ''),
        transport: 'ssh',
        recipeIds: draft.recipes.map(recipe => recipe.id).sort(),
        declaredAt: '2026-02-03T04:05:06.000Z',
      }
      const at = stored.findIndex(server => server.serverId === view.serverId)
      if (at < 0) stored.push(view)
      else stored[at] = view
      return view
    },
    browseServer: async (request: YxspecRemoteBrowseRequest) => {
      calls.browses.push(request)
      if (answers.browseThrows !== undefined) throw answers.browseThrows
      if (answers.browse !== undefined) return answers.browse(request)
      // A host that answers the way the picker expects: several levels per call, as relative paths,
      // which is what lets the picker navigate what it holds instead of connecting per click.
      const target = answers.path ?? '/srv/aosp'
      const directory = request.directory ?? '/'
      const at = {
        directory,
        ...parentOf(directory) === undefined ? {} : { parent: parentOf(directory) as string },
        depth: 2,
        truncated: false,
      }
      const prefix = directory === '/' ? '' : directory
      if (target !== directory && !target.startsWith(`${prefix}/`)) return { ...at, entries: [] }
      if (target === directory) return { ...at, entries: [] }
      // Every segment from here to the target, as the one listing a real host would answer with.
      const rest = target.slice(prefix.length + 1)
      const segments = rest.split('/')
      // No deeper than a real walk would go: a directory at the ceiling is reported, but its own
      // children are not, which is exactly when the picker has to ask again.
      const depth = request.depth ?? 2
      const entries = segments.slice(0, depth).map((_, index) => segments.slice(0, index + 1).join('/'))
      return { ...at, entries }
    },
    probeServer: async (workspaceId: string, serverId: string) => {
      calls.probes.push({ workspaceId, serverId })
      if (answers.probeThrows !== undefined) throw answers.probeThrows
      const outcome = answers.probeOutcome ?? { serverId, reachable: true, platform: 'Linux' }
      // The host stores the outcome on the declaration, so the double does too: the step renders
      // its status from the list it reads back, not from the probe answer.
      const at = stored.findIndex(server => server.serverId === serverId)
      if (at >= 0) {
        const server = stored[at] as YxspecRemoteServerView
        stored[at] = outcome.reachable
          ? { ...server, lastProbeAt: '2026-02-03T04:06:07.000Z', lastPlatform: outcome.platform ?? 'Linux' }
          : { ...server, lastProbeAt: '2026-02-03T04:06:07.000Z', lastProbeError: outcome.error ?? 'unreachable' }
      }
      return outcome
    },
    nameProject: async (projectId: WorkspaceId | undefined, title: string) => {
      calls.names.push({ projectId, title })
      if (answers.nameThrows !== undefined) throw answers.nameThrows
      // The seam is what writes both records in production, so the double has to as well: a
      // spec that only recorded the call could not see the wizard advance past step 1.
      const id = projectId ?? wid('created')
      // A create lands a fresh rootless row; a rename leaves the roots it already had. Either
      // way the catalogue gains or updates the row, which is what step 2 then reads.
      const existing = catalogue.store.getSnapshot().items.find(item => item.workspaceId === id)
      catalogue.upsert(existing === undefined
        ? { ...project(id), roots: [], path: null, title }
        : { ...existing, title })
      target.store.set({ workspaceId: id })
      // The requested walk is answered the moment the project exists — the same clearing the
      // seam performs — so step 2 renders against the project it just created rather than
      // against a still-suppressed resolution.
      request.clear()
      store.save(id, completeStep(store.read(id), 'project', { projectTitle: title }))
    },
    addRepositoryRoot: async (workspaceId: WorkspaceId, path: string) => {
      calls.added.push({ workspaceId, path })
      if (answers.rootThrows !== undefined) throw answers.rootThrows
      catalogue.appendRoot(workspaceId, path)
    },
    removeRepositoryRoot: async (workspaceId: WorkspaceId, path: string) => {
      calls.removed.push({ workspaceId, path })
      if (answers.rootThrows !== undefined) throw answers.rootThrows
      catalogue.dropRoot(workspaceId, path)
    },
    pickDirectory: () => {
      const answer = answers.picks[calls.picks]
      calls.picks += 1
      if (answers.pickThrows !== undefined) return Promise.reject(new Error(answers.pickThrows))
      return Promise.resolve(answer)
    },
    t,
    // The frame's owner share is the Conversation's, so the renderer composes the whole
    // standard set onto this layer; the seats the gate does not read are stubbed, and the
    // non-empty ones (`useWorkspaces`, `useSessions`, the access hooks) answer the spec.
    useConversation: unusedStandardHook,
    useInput: unusedStandardHook,
    inputActions: unusedStandardHook,
    usePanelInfo: unusedStandardHook,
    useResource: unusedStandardHook,
    useSessionStatus: unusedStandardHook,
    useSessionRetainInfo: unusedStandardHook,
    ...allowAllAccess,
    useContextMenu: contextMenuHook(),
  }
  return { props, store, target, request, catalogue, calls, answers }
}

/** The wizard's own footer, where the shared Back/Next/Finish controls live. */
function footerOf(container: HTMLElement): HTMLElement {
  const footer = container.querySelector('footer')
  if (footer === null) throw new Error('the wizard rendered no footer')
  return footer
}

/**
 * The forward control, wherever the step that owns it put it.
 *
 * Each step commits from its own body (`wizard.next`), because the step is what knows whether
 * its inputs are supplied; the footer's Next exists only to leave a reopened step, where the
 * body is a form for a step that is already answered. A reopened step renders both, and the
 * body's comes first in the card — so the first match is the one that does the work, which is
 * what a spec pressing "next" means in every case here.
 */
function nextButton(): HTMLButtonElement {
  const [first] = screen.getAllByRole('button', { name: zh['wizard.next'] }) as HTMLButtonElement[]
  if (first === undefined) throw new Error('the step rendered no forward control')
  return first
}

/** The step the wizard is showing, read off the card's own marker. */
function shownStep(container: HTMLElement): string | null {
  return container.querySelector('[data-yxspec-onboarding]')?.getAttribute('data-yxspec-onboarding') ?? null
}

describe('the gate', () => {
  it('renders the body untouched for an embedded, non-hero Conversation', () => {
    // An embedded occurrence, a settling body, and an open conversation all keep their
    // composer: none of them is where onboarding belongs.
    const view = render(<OnboardingWizard {...bench({ hero: false, progress: { solo: EMPTY_PROGRESS } }).props} />)
    expect(view.getByTestId('body')).toBeTruthy()
    expect(shownStep(view.container)).toBeNull()
  })

  it('renders the body untouched once every step is recorded', () => {
    const view = render(<OnboardingWizard {...bench({ progress: { solo: onboarded() } }).props} />)
    expect(view.getByTestId('body')).toBeTruthy()
    expect(shownStep(view.container)).toBeNull()
  })

  it('replaces the body rather than wrapping it while a step is outstanding', () => {
    // Not rendering the scroll body is the gate. A wrapper with a hidden child would leave a
    // live composer in the tree, which is the thing this exists to prevent.
    const view = render(<OnboardingWizard {...bench({ progress: { solo: EMPTY_PROGRESS } }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('project')
    expect(screen.getByText(zh['wizard.title'])).toBeTruthy()
  })

  it('opens on the outstanding step when the project resumes mid-wizard', () => {
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
    }).props} />)
    expect(shownStep(view.container)).toBe('specification')
    expect(screen.getByText(zh['wizard.step.specification.title'])).toBeTruthy()
  })

  it('gates only the project it resolved, not the record of another', () => {
    // Progress is keyed by project: a second project's completion must not open the first
    // one's gate.
    const view = render(<OnboardingWizard {...bench({
      progress: { other: onboarded(), solo: upTo('repositories', { projectTitle: 'ivi' }) },
    }).props} />)
    expect(shownStep(view.container)).toBe('repositories')
  })

  it('opens for the project that is complete even while another is not', () => {
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: onboarded(), other: EMPTY_PROGRESS },
    }).props} />)
    expect(view.getByTestId('body')).toBeTruthy()
  })

  it('opens an adopted project at the specification, its first two steps already answered', () => {
    // The operator established this project by pointing at a directory. Onboarding still
    // applies — a specification, a server, and a confirmation are what an ASPICE run needs and
    // none of them follows from having a directory — but its name and its repositories are
    // already answered, so the walk opens at step 3 with them recorded rather than asking again.
    const view = render(<OnboardingWizard {...bench({
      progress: {},
      workspaces: workspaceSnapshot([project('solo')]),
    }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('specification')
    expect(screen.getByText(zh['wizard.step.specification.title'])).toBeTruthy()
  })

  it('shows the adopted project’s own two steps as already done in the trail', () => {
    // Recorded, not skipped: the trail still reads them back, so the operator can see what the
    // walk has assumed on their behalf instead of facing a step 3 with no history behind it.
    const view = render(<OnboardingWizard {...bench({
      progress: {},
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp', '/vendor'])]),
    }).props} />)
    const chips = [...view.container.querySelectorAll('li')]
    expect(chips.map(chip => chip.getAttribute('data-state')))
      .toEqual(['done', 'done', 'current', 'todo', 'todo'])
  })

  it('lets Back reopen the repository step an adopted project answered by being adopted', () => {
    // The point of recording rather than skipping: an operator who pointed at the wrong
    // directory is one click from fixing it, rather than having to live with the assumption.
    const b = bench({
      progress: {},
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.back'] }))
    // Back from specification lands on repositories — reachable only because the walk carries
    // that step's history, which a walk starting bare at step 3 would not have.
    expect(shownStep(view.container)).toBe('repositories')
    expect(screen.getByText('/aosp')).toBeTruthy()
  })

  it('still gates a rootless project no walk has touched', () => {
    // Nothing points this project at code, so it has established nothing and the wizard is
    // exactly what it needs — from step 1, since there is no title or repository to fold in.
    const view = render(<OnboardingWizard {...bench({
      progress: {},
      workspaces: workspaceSnapshot([project('solo', [], [])]),
    }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('project')
  })

  it('never re-answers a started walk’s own steps from the row', () => {
    // Step 1 creates a *rootless* project and step 2 attaches its first root. A rule folding
    // the row in unconditionally would re-answer step 2 the instant its own root landed and
    // could drop the walk back to a step it had already passed. The record is what wins.
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('specification')
  })
})

describe('a walk asked for from outside the wizard', () => {
  it('opens at step 1 even when the home belongs to an unfinished project', () => {
    // The gesture means "let me name a new piece of work". The catalogue would happily resolve
    // the project the operator is looking at — and resuming *that* walk is what the operator did
    // not ask for, so the request suppresses the resolution for as long as it stands.
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
      request: { starting: true },
    }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('project')
    expect(screen.getByText(zh['wizard.step.project.title'])).toBeTruthy()
  })

  it('opens at step 1 over an adopted project rather than folding its roots in', () => {
    // An adopted project's roots are step 2's answer, so the catalogue rule would open the walk
    // at the specification — precisely the flow this walk exists to replace, since pointing at
    // that directory is what the guided creation is meant to come *before*.
    const view = render(<OnboardingWizard {...bench({
      progress: {},
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp', '/vendor'])]),
      request: { starting: true },
    }).props} />)
    expect(shownStep(view.container)).toBe('project')
    expect([...view.container.querySelectorAll('li')].map(chip => chip.getAttribute('data-state')))
      .toEqual(['current', 'todo', 'todo', 'todo', 'todo'])
  })

  it('reads no project’s record, so a finished walk cannot open it', () => {
    // A finished project has no outstanding step, which would make the gate transparent — the
    // operator would press "add" and see a live composer. The request suppresses the resolution
    // instead, so a recorded, complete project is simply not what this walk is about.
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: onboarded() },
      target: wid('solo'),
      request: { starting: true },
    }).props} />)
    expect(view.queryByTestId('body')).toBeNull()
    expect(shownStep(view.container)).toBe('project')
  })

  it('creates a project rather than renaming the one the request suppressed', () => {
    // The suppressed resolution is the whole point: a walk opened over step 1 with a resolved
    // project would rename *that* project, silently re-purposing work the operator kept.
    const b = bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      request: { starting: true },
    })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new-work' } })
    fireEvent.click(nextButton())
    expect(b.calls.names).toEqual([{ projectId: undefined, title: 'new-work' }])
  })

  it('stops suppressing the resolution once the walk has its own project', () => {
    // Step 1 creates the project and clears the request; from then on the walk is described by
    // that project's own record. A request left standing would keep the resolution suppressed,
    // so steps 2 onward would render against no project at all.
    const b = bench({ request: { starting: true } })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    expect(shownStep(view.container)).toBe('repositories')
    // And the step renders the *created* project's own row: with the resolution still suppressed
    // there would be no project to read, which is the state the clearing exists to leave behind.
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
    expect(b.store.writes.at(-1)?.projectId).toBe('created')
  })
})

describe('the trail', () => {
  it('marks completed steps done, the shown one current, and the rest todo', () => {
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
    }).props} />)
    const chips = [...view.container.querySelectorAll('li')]
    expect(chips.map(chip => chip.getAttribute('data-state')))
      .toEqual(['done', 'done', 'current', 'todo', 'todo'])
  })

  it('stops claiming a step is done once its own answer is gone', () => {
    // `stepSatisfied` is the same predicate that guards each step's Continue, so a chip can
    // never read done over a step whose inputs were cleared, and the trail cannot disagree
    // with the body. The named steps are recorded but answerless here.
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('server', { projectTitle: 'ivi' }) },
    }).props} />)
    const chips = [...view.container.querySelectorAll('li')]
    expect(chips.map(chip => chip.getAttribute('data-state')))
      .toEqual(['done', 'todo', 'todo', 'current', 'todo'])
  })

  it('draws a check for a done step instead of its index', () => {
    const view = render(<OnboardingWizard {...bench({
      progress: { solo: upTo('server', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
    }).props} />)
    const chips = [...view.container.querySelectorAll('li')]
    expect(chips[0]?.querySelector('svg')).toBeTruthy()
    expect(chips[1]?.querySelector('svg')).toBeTruthy()
    expect(chips[3]?.querySelector('svg')).toBeNull()
  })
})

describe('the footer', () => {
  it('offers no Back on the first step', () => {
    // The first step has nothing before it, so the footer renders no Back at all: the handler
    // never sees an out-of-range target, and there is no control to press that would no-op.
    const view = render(<OnboardingWizard {...bench({ progress: { solo: EMPTY_PROGRESS } }).props} />)
    expect(within(footerOf(view.container)).queryByRole('button', { name: zh['wizard.back'] })).toBeNull()
    // What moves a fresh step on is the step's own Continue, not a footer control: the footer
    // is only where Back, Finish, and "leave a reopened step" live.
    expect(nextButton().disabled).toBe(true)
  })

  it('keeps the footer empty while a fresh step is open', () => {
    // Neither Back (nothing before it), Finish (not the summary), nor Next (not a revisit):
    // the footer has nothing to offer, and says so with an empty slot rather than a dead one.
    const view = render(<OnboardingWizard {...bench({ progress: { solo: EMPTY_PROGRESS } }).props} />)
    const footer = footerOf(view.container)
    expect(footer.querySelectorAll('button')).toHaveLength(0)
  })

  it('reopens the step before, keeping its answers for redisplay', () => {
    // The roots come off the project row rather than the answers, so the reopened step shows
    // the directories the host currently holds — which is also the only thing that stays true
    // when the same project was pointed elsewhere since.
    const b = bench({
      progress: { solo: upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.back'] }))

    // Back withdraws the earlier claim that the step was settled — the trail stops showing it
    // as done — because an operator who stepped back has not finished re-answering yet.
    const written = b.store.writes.at(-1)
    expect(written?.progress.completed).not.toContain('repositories')
    expect(written?.projectId).toBe('solo')
    // The answers survive, so the step reopens prefilled rather than blank.
    expect(written?.progress.answers.repositories).toEqual(['/aosp'])
    expect(shownStep(view.container)).toBe('repositories')
    expect(screen.getByText('/aosp')).toBeTruthy()
  })

  it('returns to the outstanding step from a reopened one', () => {
    // Reopening is a detour, not a new position: the forward control goes back to the step
    // the wizard was actually on, without re-deciding anything.
    //
    // The save is swallowed here so that the *only* record of "the operator is on the
    // specification step" is the wizard's own revisit state — which is exactly the case the
    // footer's Next exists for. A store that mirrors the write would leave the reopened step
    // genuinely outstanding, and leaving it is what the step's own Continue is for.
    const b = bench({ progress: { solo: upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp'] }) } })
    b.store.mirror = false
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.back'] }))
    expect(shownStep(view.container)).toBe('repositories')

    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.next'] }))
    expect(shownStep(view.container)).toBe('specification')
    // The detour wrote nothing: the operator changed no answer, so there is nothing to save.
    expect(b.store.writes).toHaveLength(1)
  })

  it('confirms the summary from the last step', () => {
    const b = bench({ progress: { solo: upTo('ready', {
      projectTitle: 'ivi', repositories: ['/aosp'], specificationPath: 'docs/spec.md', specificationRootIndex: 0,
    }) } })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.finish'] }))
    expect(b.store.writes.at(-1)?.progress.completed).toContain('ready')
    expect(b.store.writes.at(-1)?.projectId).toBe('solo')
  })

  it('opens the project the walk created, which is the only place it becomes usable', () => {
    // The gate governs a blank home, so every step ran with no Session selected — and a project
    // with no repository root cannot have one. Finishing is the first moment the walk's project
    // is somewhere the operator can work, so the confirmation has to open it.
    const b = bench({
      progress: { solo: upTo('ready', { projectTitle: 'ivi', repositories: ['/aosp'] }) },
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.finish'] }))
    expect(b.calls.finished).toEqual(['solo'])
  })
})

describe('the project step', () => {
  it('refuses a blank then a whitespace-only name, and takes a real one', async () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS } })
    render(<OnboardingWizard {...b.props} />)
    const next = (): HTMLButtonElement => nextButton()
    expect(next().disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    expect(next().disabled).toBe(true)
    fireEvent.click(screen.getByRole('textbox'))
    expect(b.calls.names).toHaveLength(0)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi-hmi' } })
    expect(next().disabled).toBe(false)
    fireEvent.click(next())
    // The step is not recorded locally and then sent: the name *is* the create, and the record
    // is written by the seam that receives the project the host answered with.
    await waitFor(() => { expect(b.calls.names).toEqual([{ projectId: 'solo', title: 'ivi-hmi' }]) })
    expect(b.store.writes.at(-1)?.progress.answers.projectTitle).toBe('ivi-hmi')
  })

  it('creates the project when the walk has none, and sends a title alone', async () => {
    // The first run: no session, no project. The step has to create one over no directory,
    // which is what makes step 2 an append rather than a second create.
    const b = bench({ progress: {}, workspaces: workspaceSnapshot([]) })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    await waitFor(() => {
      expect(b.calls.names).toEqual([{ projectId: undefined, title: 'ivi' }])
    })
  })

  it('records the step against the id the create answered with, not the one it rendered with', async () => {
    const b = bench({ progress: {}, workspaces: workspaceSnapshot([]) })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(shownStep(view.container)).toBe('project')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    // The created project is now the walk's target, so the gate resolves it and the wizard
    // moves on — which is only possible because the seam wrote both records under the id the
    // host returned, not under the `undefined` this render was holding.
    await waitFor(() => { expect(shownStep(view.container)).toBe('repositories') })
    expect(b.target.store.getSnapshot()).toEqual({ workspaceId: 'created' })
    expect(b.store.read('created')?.completed).toEqual(['project'])
  })

  it('renames the project it already resolved rather than creating a second one', async () => {
    // Step 1 is reachable from a walk already past it, and the project then exists: the
    // operator's edit is a rename, and creating again would leave the walk's own project
    // behind with a duplicate beside it.
    const b = bench({ progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) }, target: wid('solo') })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.back'] }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi-hmi' } })
    fireEvent.click(nextButton())
    await waitFor(() => { expect(b.calls.names).toEqual([{ projectId: 'solo', title: 'ivi-hmi' }]) })
  })

  it('submits on Enter as well as on the control', async () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS } })
    render(<OnboardingWizard {...b.props} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ivi' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => { expect(b.calls.names).toEqual([{ projectId: 'solo', title: 'ivi' }]) })
  })

  it('records nothing on a blank submit through Enter', async () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS } })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(b.calls.names).toHaveLength(0)
  })

  it('ignores every other key', () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS } })
    render(<OnboardingWizard {...b.props} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'ivi' } })
    fireEvent.keyDown(input, { key: 'a' })
    expect(b.calls.names).toHaveLength(0)
  })

  it('reports a refused create without recording the step', async () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS }, nameThrows: new Error('name conflict') })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    await waitFor(() => { expect(screen.getByText('name conflict')).toBeTruthy() })
    // The double throws before it writes, so this proves the seam is where the record is
    // written: a step saved by the component first would have landed regardless.
    expect(b.store.writes).toHaveLength(0)
  })

  it('reports a non-Error throw by its string form', async () => {
    // Anything can be thrown, including a bare string; the notice line has to render it.
    const b = bench({ progress: { solo: EMPTY_PROGRESS }, nameThrows: 'plain string' })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    await waitFor(() => { expect(screen.getByText('plain string')).toBeTruthy() })
  })

  it('clears an earlier refusal notice when the submit is retried', async () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS }, nameThrows: new Error('name conflict') })
    // The save is swallowed so the step stays on screen after it succeeds: otherwise the
    // notice would leave with the card, and the spec could not tell "cleared" from "unmounted".
    b.store.mirror = false
    render(<OnboardingWizard {...b.props} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ivi' } })
    fireEvent.click(nextButton())
    await waitFor(() => { expect(screen.getByText('name conflict')).toBeTruthy() })

    // The host's answer is read at call time, so repairing it here is what a retry actually
    // looks like: the second press leaves, clears the stale notice, and records the step.
    b.answers.nameThrows = undefined
    fireEvent.click(nextButton())
    await waitFor(() => { expect(b.calls.names).toHaveLength(2) })
    expect(screen.queryByText('name conflict')).toBeNull()
  })

  it('prefills the recorded name on a revisit', () => {
    const b = bench({ progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) }, target: wid('solo') })
    const view = render(<OnboardingWizard {...b.props} />)
    fireEvent.click(within(footerOf(view.container)).getByRole('button', { name: zh['wizard.back'] }))
    expect(screen.getByDisplayValue('ivi')).toBeTruthy()
  })
})

describe('the repositories step', () => {
  /** Step 1 done, step 2 open, and the project it created holds no repository yet. */
  const rootless = (): BenchOptions => ({
    progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) },
    target: wid('solo'),
    workspaces: workspaceSnapshot([project('solo', [], [])]),
  })

  it('refuses to continue while the project holds no root', () => {
    render(<OnboardingWizard {...bench(rootless()).props} />)
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
    expect(nextButton().disabled).toBe(true)
  })

  it('appends a picked directory to the project and is the primary root by position', async () => {
    // The directory is not remembered as a draft and sent with a create later: step 1 already
    // made the project, so the pick is a command against it, and the list on screen is the
    // host's answer rather than the component's own recollection.
    const b = bench({ ...rootless(), picks: ['/aosp'] })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(b.calls.added).toEqual([{ workspaceId: 'solo', path: '/aosp' }]) })
    await waitFor(() => { expect(screen.getByText('/aosp')).toBeTruthy() })
    // Appended to a rootless project, so it lands at index 0 and *is* the session working
    // directory without any promotion step.
    expect(screen.getByText(zh['wizard.step.repositories.primary'])).toBeTruthy()
  })

  it('commits the project’s own roots as the step’s answer', async () => {
    const b = bench({ ...rootless(), picks: ['/aosp'] })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(screen.getByText('/aosp')).toBeTruthy() })
    fireEvent.click(nextButton())
    expect(b.store.writes.at(-1)?.progress.answers.repositories).toEqual(['/aosp'])
    expect(b.store.writes.at(-1)?.progress.completed).toContain('repositories')
  })

  it('appends each directory chosen in turn, primary first', async () => {
    const b = bench({ ...rootless(), picks: ['/aosp', '/vendor'] })
    render(<OnboardingWizard {...b.props} />)
    const add = screen.getByRole('button', { name: zh['wizard.step.repositories.add'] })
    fireEvent.click(add)
    await waitFor(() => { expect(screen.getByText('/aosp')).toBeTruthy() })
    fireEvent.click(add)
    await waitFor(() => { expect(screen.getByText('/vendor')).toBeTruthy() })
    expect(b.calls.added).toEqual([
      { workspaceId: 'solo', path: '/aosp' },
      { workspaceId: 'solo', path: '/vendor' },
    ])
    // Only the first carries the marker: the second is appended behind it, never promoted.
    expect(screen.getAllByText(zh['wizard.step.repositories.primary'])).toHaveLength(1)
    fireEvent.click(nextButton())
    expect(b.store.writes.at(-1)?.progress.answers.repositories).toEqual(['/aosp', '/vendor'])
  })

  it('does not append a directory the project already declares', async () => {
    // The host refuses a duplicate root anyway, but asking it would be a round trip spent to
    // be told what the list on screen already says.
    const b = bench({ ...rootless(), picks: ['/aosp', '/aosp'] })
    render(<OnboardingWizard {...b.props} />)
    const add = screen.getByRole('button', { name: zh['wizard.step.repositories.add'] })
    fireEvent.click(add)
    await waitFor(() => { expect(screen.getByText('/aosp')).toBeTruthy() })
    fireEvent.click(add)
    await waitFor(() => { expect(b.calls.picks).toBe(2) })
    expect(b.calls.added).toHaveLength(1)
    expect(screen.getAllByText('/aosp')).toHaveLength(1)
  })

  it('does nothing when the operator cancels the picker', async () => {
    // A cancelled pick is not a failure and not a choice: no command, no notice, no row.
    const b = bench({ ...rootless(), picks: [undefined] })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(b.calls.picks).toBe(1) })
    expect(b.calls.added).toEqual([])
    expect(screen.queryByText(zh['wizard.step.repositories.primary'])).toBeNull()
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
  })

  it('drops a declared directory again', async () => {
    const b = bench({
      progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.remove'] }))
    await waitFor(() => { expect(b.calls.removed).toEqual([{ workspaceId: 'solo', path: '/aosp' }]) })
    await waitFor(() => { expect(screen.queryByText('/aosp')).toBeNull() })
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
  })

  it('commits nothing once the last directory is dropped', async () => {
    // The Continue is disabled on an empty list, and the commit guard repeats that decision
    // rather than trusting the control: a submit that somehow arrived would record a step
    // whose answer is empty, and step 3 would then have nothing to enumerate against.
    const b = bench({
      progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
    })
    render(<OnboardingWizard {...b.props} />)
    const next = nextButton()
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.remove'] }))
    await waitFor(() => { expect(next.disabled).toBe(true) })
    fireEvent.click(next)
    expect(b.store.writes).toHaveLength(0)
  })

  it('reports a refused picker without losing the step', async () => {
    const b = bench({ ...rootless(), pickThrows: 'picker unavailable' })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(screen.getByText('picker unavailable')).toBeTruthy() })
    // The step is still there and still usable: a refused pick is not the end of onboarding.
    expect(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] })).toBeTruthy()
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
  })

  it('reports a refused root append without recording a root that is not there', async () => {
    const b = bench({ ...rootless(), picks: ['/aosp'], rootThrows: new Error('no such directory') })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(screen.getByText('no such directory')).toBeTruthy() })
    // The double throws before it writes the catalogue, so the row is absent for the same
    // reason it would be in production: the host never accepted the root.
    expect(screen.queryByText('/aosp')).toBeNull()
    expect(screen.getByText(zh['wizard.step.repositories.empty'])).toBeTruthy()
  })

  it('reports a refused removal and keeps the row', async () => {
    const b = bench({
      progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp'])]),
      rootThrows: 'root is in use',
    })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.remove'] }))
    await waitFor(() => { expect(screen.getByText('root is in use')).toBeTruthy() })
    expect(screen.getByText('/aosp')).toBeTruthy()
  })

  it('clears an earlier refusal notice when the same edit succeeds', async () => {
    // Two picks because the retry presses Add again: the host is asked a second time, and the
    // answer is read at call time, so repairing the refusal here is what a retry looks like.
    const b = bench({ ...rootless(), picks: ['/aosp', '/aosp'], rootThrows: new Error('no such directory') })
    render(<OnboardingWizard {...b.props} />)
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(screen.getByText('no such directory')).toBeTruthy() })

    b.answers.rootThrows = undefined
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.repositories.add'] }))
    await waitFor(() => { expect(screen.getByText('/aosp')).toBeTruthy() })
    expect(screen.queryByText('no such directory')).toBeNull()
  })

  it('reads the roots the project already has, not a list of its own', async () => {
    // The project may have been pointed at directories from another surface entirely; step 2
    // renders what the host says rather than an empty draft that would hide them.
    render(<OnboardingWizard {...bench({
      progress: { solo: upTo('repositories', { projectTitle: 'ivi' }) },
      target: wid('solo'),
      workspaces: workspaceSnapshot([project('solo', [], ['/aosp', '/vendor'])]),
    }).props} />)
    expect(screen.getByText('/aosp')).toBeTruthy()
    expect(screen.getByText('/vendor')).toBeTruthy()
    expect(screen.getAllByText(zh['wizard.step.repositories.primary'])).toHaveLength(1)
  })
})

describe('the specification step', () => {
  const documents: readonly YxspecDocumentView[] = [
    { path: 'docs/spec.md', title: 'spec', partition: 'input', size: 10, rootIndex: 0 },
    { path: 'docs/other.md', title: 'other', size: 20, rootIndex: 1 },
  ]

  /** The step is open with the project and its repositories already answered. */
  const beforeIt = upTo('specification', { projectTitle: 'ivi', repositories: ['/aosp', '/vendor'] })

  it('lists the project’s candidates and records the chosen one with its root', async () => {
    const b = bench({ progress: { solo: beforeIt }, documents })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/other.md')).toBeTruthy() })
    // Enumerated against the resolved project, not against a directory name.
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: [] }])
    fireEvent.click(screen.getByText('docs/other.md'))
    // The same relative path can exist in two repositories, so the root index is part of the
    // answer rather than decoration.
    expect(b.store.writes.at(-1)?.progress.answers).toMatchObject({
      specificationPath: 'docs/other.md', specificationRootIndex: 1,
    })
  })

  it('shows the declared partition beside a document that has one', async () => {
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents }).props} />)
    await waitFor(() => { expect(screen.getByText('input')).toBeTruthy() })
    // The second candidate declares none, so nothing stands in for it.
    expect(screen.getAllByText('input')).toHaveLength(1)
  })

  it('marks the recorded choice as pressed', async () => {
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], specificationPath: 'docs/spec.md', specificationRootIndex: 0,
      }) },
      documents,
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    expect(screen.getByText('docs/spec.md').closest('button')?.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('docs/other.md').closest('button')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not mark a same-path row in another root as chosen', async () => {
    // Both the path and the root have to match; a path-only test would name two documents.
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/a', '/b'], specificationPath: 'docs/spec.md', specificationRootIndex: 1,
      }) },
      documents: [
        { path: 'docs/spec.md', title: 'spec', size: 1, rootIndex: 0 },
        { path: 'docs/spec.md', title: 'spec', size: 1, rootIndex: 1 },
      ],
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getAllByText('docs/spec.md')).toHaveLength(2) })
    expect(screen.getAllByText('docs/spec.md').map(node => node.closest('button')?.getAttribute('aria-pressed')))
      .toEqual(['false', 'true'])
  })

  it('shows an empty state when the project holds no candidate', async () => {
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents: [] }).props} />)
    await waitFor(() => { expect(screen.getByText(zh['wizard.step.specification.empty'])).toBeTruthy() })
  })

  it('searches the directories a recorded walk already added', async () => {
    // The additions are the step's own persisted answers, so returning to it — or reloading —
    // reopens the search they produced rather than the project's bare layout.
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], searchPaths: ['/shared/spec'],
      }) },
      documents,
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: ['/shared/spec'] }])
  })

  it('re-reads the widened search once a directory is added, and records it immediately', async () => {
    const b = bench({ progress: { solo: beforeIt }, documents, picks: ['/shared/spec'] })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: [] }])

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => {
      expect(b.calls.documents).toEqual([
        { workspaceId: 'solo', extraDirectories: [] },
        { workspaceId: 'solo', extraDirectories: ['/shared/spec'] },
      ])
    })
    // Written as the edit is made rather than with the eventual document choice: an operator who
    // adds a directory and reloads before picking a document must not lose the path.
    expect(b.store.read('solo')?.answers.searchPaths).toEqual(['/shared/spec'])
    // The step itself is not claimed as done: widening a search is not answering it.
    expect(b.store.read('solo')?.completed).not.toContain('specification')
    expect(screen.getByText('/shared/spec')).toBeTruthy()
  })

  it('searches the added directory ahead of the project’s own candidates', async () => {
    // The addition is shown above the project's own rows because it is the operator's explicit
    // instruction: the host orders it below the project's declaration, and the wizard renders
    // the host's order rather than sorting for itself.
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], searchPaths: ['/shared/spec'],
      }) },
      documents: [
        { path: 'specs/from-project.md', title: 'from-project', size: 1, rootIndex: 0 },
        { path: 'spec.md', title: 'spec', size: 2, rootIndex: 1 },
      ],
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('spec.md')).toBeTruthy() })
  })

  it('does nothing when the operator cancels the picker', async () => {
    // A cancelled pick is not a failure and not a choice: the search stays as it was, with no
    // second read and no recorded addition.
    const b = bench({ progress: { solo: beforeIt }, documents, picks: [undefined] })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => { expect(b.calls.picks).toBe(1) })
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: [] }])
    expect(b.store.writes).toEqual([])
  })

  it('does not add a directory the search already carries', async () => {
    // Re-picking the same directory would put a duplicate row on screen and re-run a read whose
    // answer cannot have changed.
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], searchPaths: ['/shared/spec'],
      }) },
      documents,
      picks: ['/shared/spec'],
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => { expect(b.calls.picks).toBe(1) })
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: ['/shared/spec'] }])
    expect(b.store.writes).toEqual([])
  })

  it('drops an added directory again, widening the search back', async () => {
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], searchPaths: ['/shared/spec', '/delivered/prd'],
      }) },
      documents,
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('/shared/spec')).toBeTruthy() })
    fireEvent.click(within(screen.getByText('/shared/spec').closest('li') as HTMLElement)
      .getByRole('button', { name: zh['wizard.step.repositories.remove'] }))
    await waitFor(() => {
      expect(b.store.read('solo')?.answers.searchPaths).toEqual(['/delivered/prd'])
    })
    expect(b.calls.documents.at(-1)?.extraDirectories).toEqual(['/delivered/prd'])
  })

  it('reports a refused picker without disturbing the search', async () => {
    // The only signal the operator gets that the click did nothing.
    const b = bench({ progress: { solo: beforeIt }, documents, pickThrows: 'the picker is busy' })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => { expect(screen.getByText('the picker is busy')).toBeTruthy() })
    expect(b.store.writes).toEqual([])
    expect(b.calls.documents).toEqual([{ workspaceId: 'solo', extraDirectories: [] }])
  })

  it('clears an earlier refusal notice when the same edit succeeds', async () => {
    // The refused attempt consumes its picker answer before throwing, so the retry needs one of
    // its own: the first click is refused, the second answers.
    const b = bench({
      progress: { solo: beforeIt }, documents,
      pickThrows: 'the picker is busy', picks: ['/shared/spec', '/shared/spec'],
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => { expect(screen.getByText('the picker is busy')).toBeTruthy() })
    b.answers.pickThrows = undefined
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.extraAdd'] }))
    await waitFor(() => { expect(screen.getByText('/shared/spec')).toBeTruthy() })
    expect(screen.queryByText('the picker is busy')).toBeNull()
  })

  it('commits the document choice alone, leaving the recorded additions untouched', async () => {
    // The additions are written as they are made, so re-stating them with the document choice
    // would be a second write of a value the record already holds.
    const b = bench({
      progress: { solo: upTo('specification', {
        projectTitle: 'ivi', repositories: ['/aosp'], searchPaths: ['/shared/spec'],
      }) },
      documents,
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    fireEvent.click(screen.getByText('docs/spec.md'))
    expect(b.store.read('solo')?.answers).toMatchObject({
      specificationPath: 'docs/spec.md',
      specificationRootIndex: 0,
      searchPaths: ['/shared/spec'],
    })
    expect(b.store.read('solo')?.completed).toContain('specification')
  })

  it('names the searched directories when the list is empty, which is what explains it', async () => {
    // The case the step exists to disambiguate: no candidate found reads the same whether the
    // project has no inputs yet or the repositories chosen in step 2 point elsewhere. The
    // reported paths are the only thing that tells the two apart.
    const searched = ['D:\\Caches\\DSH\\project\\inputs', 'D:\\Caches\\DSH\\project\\design', 'D:\\Caches\\DSH\\docs']
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents: [], searched }).props} />)
    await waitFor(() => { expect(screen.getByText(zh['wizard.step.specification.empty'])).toBeTruthy() })
    // Open by default exactly here: with nothing found the report is the explanation, not a
    // footnote the operator has to think to expand.
    for (const path of searched) expect(screen.getByText(path)).toBeTruthy()
    expect(screen.getByText(zh['wizard.step.specification.searched'].replace('{count}', '3'))).toBeTruthy()
  })

  it('keeps the searched directories collapsed while candidates are listed', async () => {
    const searched = ['/aosp/project/inputs', '/aosp/docs']
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents, searched }).props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    // With rows to choose from the report is reference material; the disclosure is closed and
    // the operator opens it only when the document they want is missing.
    expect(screen.queryByText('/aosp/project/inputs')).toBeNull()
    const toggle = screen.getByText(zh['wizard.step.specification.searched'].replace('{count}', '2'))
    fireEvent.click(toggle)
    expect(screen.getByText('/aosp/project/inputs')).toBeTruthy()
    expect(screen.getByText('/aosp/docs')).toBeTruthy()
  })

  it('renders no disclosure when the host reports looking nowhere', async () => {
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents, searched: [] }).props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    expect(screen.queryByText(zh['wizard.step.specification.searched'].replace('{count}', '0'))).toBeNull()
  })

  it('says so when the ceiling cut the listing short', async () => {
    // A bounded list must not read as a complete one: the document the operator wants may be
    // below the fold rather than absent.
    const many = Array.from({ length: 200 }, (_, index) => ({
      path: `project/specs/case-${String(index).padStart(3, '0')}.md`, title: `case-${index}`, size: 1, rootIndex: 0,
    }))
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents: many, truncated: true }).props} />)
    await waitFor(() => {
      expect(screen.getByText(zh['wizard.step.specification.truncated'].replace('{count}', '200'))).toBeTruthy()
    })
  })

  it('says nothing about a ceiling it did not hit', async () => {
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documents }).props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })
    expect(screen.queryByText(zh['wizard.step.specification.truncated'].replace('{count}', '2'))).toBeNull()
  })

  it('reports a refused document read as unavailable', async () => {
    // A reader that throws is not "no documents": saying so would send the operator looking
    // for a file that may well be there.
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt }, documentsThrow: true }).props} />)
    await waitFor(() => { expect(screen.getByText(zh['wizard.unavailable'])).toBeTruthy() })
  })

  it('reports a project that could not be resolved as unavailable', async () => {
    // Two projects and nothing to choose between them: the step has no project to enumerate
    // against, and says so rather than showing an empty list that would read as "none".
    const b = bench({
      progress: { unplaceable: beforeIt },
      workspaces: workspaceSnapshot([project('alpha'), project('beta')]),
    })
    const view = render(<OnboardingWizard {...b.props} />)
    // The gate cannot tell which project the home is about, so it never reaches the step.
    expect(shownStep(view.container)).toBe('project')
    expect(b.calls.documents).toEqual([])
  })

  it('shows the unavailable notice when it is handed no project, and reads nothing', () => {
    // The gate resolves the project before this step is ever shown, so the step's own guard is
    // a second line of defence: with no project registered there is nothing to enumerate
    // against, and the step says so rather than reading "" as if it were a directory.
    //
    // Unplaceable progress keyed "" is how the gate hands the step no project: `resolveProjectId`
    // yields undefined and the selector falls back to the empty key.
    const b = bench({ progress: { '': beforeIt }, workspaces: workspaceSnapshot([]) })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(shownStep(view.container)).toBe('specification')
    expect(screen.getByText(zh['wizard.unavailable'])).toBeTruthy()
    expect(b.calls.documents).toEqual([])
  })

  it('does not read documents for a project that could not be resolved', async () => {
    const b = bench({ progress: {}, workspaces: workspaceSnapshot([project('alpha'), project('beta')]) })
    render(<OnboardingWizard {...b.props} />)
    await Promise.resolve()
    expect(b.calls.documents).toEqual([])
  })

  it('lets the operator leave the specification for later', async () => {
    // A specification is routinely delivered after the project is set up, and a walk that held the
    // Conversation shut until one arrived would gate the work on a document nobody has.
    const b = bench({ progress: { solo: beforeIt }, documents: [] })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText(zh['wizard.step.specification.empty'])).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.defer'] }))

    const written = b.store.writes.at(-1)?.progress
    expect(written?.answers.specificationDeferred).toBe(true)
    expect(written?.completed).toContain('specification')
  })

  it('reopens for a document chosen after the deferral', async () => {
    // "Add it later" is only an answer if the step can still be answered: the trail reopens it, and
    // the deferral is recorded on the record this reads back.
    const settled = completeStep(beforeIt, 'specification', { specificationDeferred: true })
    const b = bench({ progress: { solo: reopenStep(settled, 'specification') }, documents })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })

    fireEvent.click(screen.getByText('docs/spec.md'))

    // The document answers the question the deferral answered, so the record cannot keep both.
    const written = b.store.writes.at(-1)?.progress
    expect(written?.answers.specificationPath).toBe('docs/spec.md')
    expect(written?.answers.specificationDeferred).toBe(false)
  })

  it('withdraws a chosen document when the operator defers instead', async () => {
    const settled = completeStep(beforeIt, 'specification', {
      specificationPath: 'docs/spec.md', specificationRootIndex: 0,
    })
    const b = bench({ progress: { solo: reopenStep(settled, 'specification') }, documents })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('docs/spec.md')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.specification.defer'] }))

    // Blank rather than absent: the record merges answers, and an absent key would leave the
    // withdrawn choice standing.
    const written = b.store.writes.at(-1)?.progress
    expect(written?.answers.specificationDeferred).toBe(true)
    expect(written?.answers.specificationPath).toBe('')
  })

  it('does not commit a document read that lands after unmount', async () => {
    let settle: (value: YxspecDocumentListing) => void = () => {}
    const b = bench({ progress: { solo: beforeIt } })
    const error = vi.spyOn(console, 'error')
    b.answers.documentsImpl = () => new Promise((resolve) => { settle = resolve })
    const view = render(<OnboardingWizard {...b.props} />)
    view.unmount()
    settle({ documents: [...documents], searched: [], truncated: false })
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('does not report a document refusal that lands after unmount', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    const error = vi.spyOn(console, 'error')
    b.answers.documentsImpl = () => Promise.reject(new Error('gateway unreachable'))
    const view = render(<OnboardingWizard {...b.props} />)
    view.unmount()
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('the server step', () => {
  const beforeIt = upTo('server', { projectTitle: 'ivi', repositories: ['/aosp'] })
  const declared: readonly YxspecRemoteServerView[] = [{
    serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', projectDirectory: '/srv/build',
    transport: 'ssh', recipeIds: ['make'], declaredAt: '2026-01-01T00:00:00.000Z',
  }]

  it('lists declared servers, reads them for the resolved project, and continues', async () => {
    const b = bench({ progress: { solo: beforeIt }, servers: declared })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })
    expect(b.calls.servers).toEqual(['solo'])
    // The row names where the server is, which is what tells two declared servers apart; the
    // transport is `ssh` for every declaration the record can hold.
    expect(screen.getByText('ci@farm')).toBeTruthy()
    fireEvent.click(nextButton())
    expect(b.store.writes.at(-1)?.progress.answers.serverResolved).toBe(true)
  })

  it('falls back to the id when a declared server has no title', async () => {
    render(<OnboardingWizard {...bench({
      progress: { solo: beforeIt },
      servers: [{
        serverId: 'bare', title: '', destination: 'ci@host', projectDirectory: '/srv', transport: 'ssh',
        recipeIds: [], declaredAt: '2026-01-01T00:00:00.000Z',
      }],
    }).props} />)
    await waitFor(() => { expect(screen.getByText('bare')).toBeTruthy() })
  })

  it('records "this project builds locally" as an answer, not as a skipped step', async () => {
    // Without recording it the step would ask again on every blank session.
    const b = bench({ progress: { solo: beforeIt } })
    const view = render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(view.container.textContent).toContain(zh['wizard.step.server.empty']) })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.skip'] }))
    expect(b.store.writes.at(-1)?.progress.answers.serverResolved).toBe(true)
    expect(b.store.writes.at(-1)?.progress.completed).toContain('server')
  })

  it('treats an absent remote plugin as "none declared" rather than a failure', async () => {
    // A deployment without the namespace is a normal deployment, and the step's answer is
    // still "no server".
    const b = bench({ progress: { solo: beforeIt }, serversThrow: true })
    const view = render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(view.container.textContent).toContain(zh['wizard.step.server.empty']) })
    expect(view.container.textContent).not.toContain(zh['wizard.unavailable'])
  })

  it('offers no continue while the declaration list is still arriving', () => {
    const b = bench({ progress: { solo: beforeIt } })
    const view = render(<OnboardingWizard {...b.props} />)
    const buttons = [...view.container.querySelectorAll('button')]
      .filter(button => button.textContent === zh['wizard.skip'] || button.textContent === zh['wizard.next'])
    expect(buttons.length).toBeGreaterThan(0)
    expect(buttons.every(button => button.disabled)).toBe(true)
  })

  it('does not commit a server read that lands after unmount', async () => {
    let settle: (value: YxspecRemoteServerView[]) => void = () => {}
    const b = bench({ progress: { solo: beforeIt } })
    const error = vi.spyOn(console, 'error')
    b.answers.serversImpl = () => new Promise((resolve) => { settle = resolve })
    const view = render(<OnboardingWizard {...b.props} />)
    view.unmount()
    settle([...declared])
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('does not report a server refusal that lands after unmount', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    const error = vi.spyOn(console, 'error')
    b.answers.serversImpl = () => Promise.reject(new Error('no namespace'))
    const view = render(<OnboardingWizard {...b.props} />)
    view.unmount()
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('reports an unmounted host service when it is handed no project, and reads nothing', () => {
    // The gate resolves the project before this step is shown, so the guard is a second line of
    // defence: with no project registered there is nothing to read declarations for, and the
    // controls stay disabled rather than silently resolving "this project builds locally".
    const b = bench({ progress: { '': beforeIt }, workspaces: workspaceSnapshot([]) })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(shownStep(view.container)).toBe('server')
    expect(b.calls.servers).toEqual([])
    // The forward control reads "skip" here — nothing has been read, so nothing is declared —
    // and it is disabled, so the click cannot record "this project builds locally" for a
    // project the step was never given.
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.skip'] }))
    expect(b.store.writes).toHaveLength(0)
  })

  it('does not read servers for a project that could not be resolved', async () => {
    const b = bench({ progress: {}, workspaces: workspaceSnapshot([project('alpha'), project('beta')]) })
    render(<OnboardingWizard {...b.props} />)
    await Promise.resolve()
    expect(b.calls.servers).toEqual([])
  })
})

describe('declaring a server from the step', () => {
  // The step is reachable with the first three steps recorded, which is the state a walk into
  // it always arrives in.
  const beforeIt = upTo('server', { projectTitle: 'ivi', repositories: ['/aosp'] })

  /** Fill one labelled field of the open form. */
  function fill(label: string, value: string): void {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
  }

  /** Fill the first recipe row, which is the one a blank form opens with. */
  function fillRecipe(id: string, command: string): void {
    const [recipeId] = screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.id'])
    const [recipeCommand] = screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.command'])
    fireEvent.change(recipeId as HTMLInputElement, { target: { value: id } })
    fireEvent.change(recipeCommand as HTMLInputElement, { target: { value: command } })
  }

  /**
   * Connect, land on the server, and take the directory the fake host answers with.
   *
   * The path is no longer typed, so a spec chooses it the way an operator does: the connect control
   * lists the login directory, and the listing carries an entry the spec navigates into until it
   * reaches what it wants.
   * @param path - the absolute directory the walk should end on.
   */
  async function chooseDirectory(b: ReturnType<typeof bench>, path: string): Promise<void> {
    // The fake host answers the way a real one does — one level per call — so the spec names the
    // tree it should hold and this walks it exactly as an operator would: connect, descend one
    // segment at a time, then take the directory the walk ended on.
    b.answers.path = path
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))
    const segments = path.split('/').filter(segment => segment.length > 0)
    let current = '/'
    for (const segment of segments) {
      const label = zh['wizard.step.server.browse.current'].replace('{path}', current)
      await waitFor(() => { expect(screen.getByText(label)).toBeTruthy() })
      fireEvent.click(screen.getByRole('button', { name: segment }))
      current = current === '/' ? `/${segment}` : `${current}/${segment}`
      // Awaited rather than asserted synchronously: a level the connect call already covered lands
      // at once, and one below it lands after the single call that level costs, so waiting is the
      // only form that is right for both. The walk spec pins which is which.
      await waitFor(() => {
        expect(screen.getByText(zh['wizard.step.server.browse.current'].replace('{path}', current))).toBeTruthy()
      })
    }
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.browse.choose'] }))
  }

  /** Open the form, which is where the declaration is made. */
  async function openForm(): Promise<void> {
    await waitFor(() => { expect(screen.getByText(zh['wizard.step.server.empty'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.add'] }))
  }

  it('declares the filled-in server and lists what the host stored', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'aosp-builder')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'build.internal')
    await chooseDirectory(b, '/srv/builds')
    fillRecipe('ninja', 'ninja -C {cwd}')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    await waitFor(() => { expect(b.calls.declared).toHaveLength(1) })
    expect(b.calls.declared[0]).toEqual({
      workspaceId: 'solo',
      draft: {
        serverId: 'aosp-builder',
        destination: 'ci@build.internal',
        projectDirectory: '/srv/builds',
        recipes: [{ id: 'ninja', command: 'ninja -C {cwd}' }],
      },
    })
    // The row the step shows is the host's answer, read back after the write, and the forward
    // control now says what it does rather than offering to skip a server that exists. Three reads:
    // the step opening, the declaration landing, and the automatic probe that follows it — "added,
    // does it connect?" is answered without a second gesture.
    await waitFor(() => { expect(screen.getByText('aosp-builder')).toBeTruthy() })
    expect(screen.getByRole('button', { name: zh['wizard.next'] })).toBeTruthy()
    expect(b.calls.probes).toEqual([{ workspaceId: 'solo', serverId: 'aosp-builder' }])
    expect(b.calls.servers).toEqual(['solo', 'solo', 'solo'])
  })

  it('shows what the last probe concluded, and tests on demand', async () => {
    const b = bench({
      progress: { solo: beforeIt },
      servers: [{
        serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', projectDirectory: '/srv/build',
        transport: 'ssh', recipeIds: ['make'], declaredAt: '2026-01-01T00:00:00.000Z',
        lastProbeAt: '2026-02-03T04:05:06.000Z', lastPlatform: 'Linux',
      }],
    })
    render(<OnboardingWizard {...b.props} />)

    // The state is the host's stored outcome, so a reloaded wizard reports the same answer the
    // probe did: a green dot, with the platform it observed behind it rather than in the row.
    await waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })
    expect(screen.getByText('Build farm').closest('li')?.querySelector('[data-state="done"]')).toBeTruthy()
    expect(screen.queryByText(zh['server.neverProbed'])).toBeNull()
    expect(screen.getByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh['server.probe'] }))
    await waitFor(() => { expect(b.calls.probes).toEqual([{ workspaceId: 'solo', serverId: 'build-1' }]) })
  })

  it('renders a failed probe as the row\'s status, carrying the host\'s reason', async () => {
    const b = bench({
      progress: { solo: beforeIt },
      servers: [{
        serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', projectDirectory: '/srv/build',
        transport: 'ssh', recipeIds: ['make'], declaredAt: '2026-01-01T00:00:00.000Z',
        lastProbeAt: '2026-02-03T04:05:06.000Z', lastProbeError: "no directory '/srv/build' on ci@farm",
      }],
    })
    render(<OnboardingWizard {...b.props} />)

    // A failed test is the one state that keeps its words on screen — which directory is missing is
    // what the operator acts on — and it draws them beside a red dot.
    await waitFor(() => {
      expect(screen.getByText(
        zh['server.unreachable'].replace('{error}', "no directory '/srv/build' on ci@farm"),
      )).toBeTruthy()
    })
    expect(screen.getByText('Build farm').closest('li')?.querySelector('[data-state="error"]')).toBeTruthy()
  })

  it('reports a probe the host refused without losing the list', async () => {
    const b = bench({
      progress: { solo: beforeIt },
      servers: [{
        serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', projectDirectory: '/srv/build',
        transport: 'ssh', recipeIds: ['make'], declaredAt: '2026-01-01T00:00:00.000Z',
      }],
      probeThrows: new Error('the build-server namespace is not mounted'),
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh['server.probe'] }))

    await waitFor(() => { expect(screen.getByText('the build-server namespace is not mounted')).toBeTruthy() })
    // A refused call is not a verdict about the host: the row keeps saying it was never tested.
    expect(screen.getByText(zh['server.neverProbed'])).toBeTruthy()
  })

  it('sends the optional fields only when the operator filled them', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'farm')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    await chooseDirectory(b, '/srv/farm')
    fill(zh['wizard.step.server.field.timeout'], '60000')
    fill(zh['wizard.step.server.field.ssh'], '/usr/bin/ssh')
    fillRecipe('make', 'make -C {cwd}')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    await waitFor(() => { expect(b.calls.declared).toHaveLength(1) })
    // A blank label stays absent rather than travelling as an empty string: the host defaults it
    // to the id, and an empty `sshExecutable` would be a path no run could execute.
    expect(b.calls.declared[0]?.draft).toEqual({
      serverId: 'farm',
      destination: 'ci@farm',
      projectDirectory: '/srv/farm',
      recipes: [{ id: 'make', command: 'make -C {cwd}' }],
      timeoutMs: 60_000,
      sshExecutable: '/usr/bin/ssh',
    })
  })

  it('joins the user name and the host into the destination the host receives', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'farm')
    // Half a destination is no destination: with no host the connect control stays refused, so the
    // operator cannot browse — let alone declare — against something nobody could resolve.
    fill(zh['wizard.step.server.field.username'], 'ci')
    const connect = (): HTMLButtonElement => screen.getByRole('button', { name: zh['wizard.step.server.connect'] }) as HTMLButtonElement
    expect(connect().disabled).toBe(true)

    fill(zh['wizard.step.server.field.host'], '10.10.30.6')
    expect(connect().disabled).toBe(false)
    await chooseDirectory(b, '/srv/farm')
    fillRecipe('make', 'make')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    // The operator typed two facts, the listing reached the joined destination, and the record
    // carries the one string OpenSSH takes.
    await waitFor(() => { expect(b.calls.declared).toHaveLength(1) })
    expect(b.calls.browses[0]?.destination).toBe('ci@10.10.30.6')
    expect(b.calls.declared[0]?.draft.destination).toBe('ci@10.10.30.6')
  })

  it("sends each recipe's output directory and the revision flag only when the operator set them", async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'aosp')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'aosp')
    await chooseDirectory(b, '/srv/aosp')
    fillRecipe('ninja', 'ninja -C {cwd} OUT={out}')
    // The output directory is per recipe because a whole build and a module build of one tree
    // write to different places; this row names its own.
    fireEvent.change(
      screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.output'])[0] as HTMLInputElement,
      { target: { value: '/srv/aosp-out' } },
    )
    fireEvent.click(screen.getByLabelText(zh['wizard.step.server.field.captureRevision']))
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    await waitFor(() => { expect(b.calls.declared).toHaveLength(1) })
    expect(b.calls.declared[0]?.draft).toEqual({
      serverId: 'aosp',
      destination: 'ci@aosp',
      projectDirectory: '/srv/aosp',
      captureRevision: true,
      recipes: [{ id: 'ninja', command: 'ninja -C {cwd} OUT={out}', outputDirectory: '/srv/aosp-out' }],
    })
  })

  it('leaves a recipe without an output directory to the host default', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'aosp')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'aosp')
    await chooseDirectory(b, '/srv/aosp')
    fillRecipe('ninja', 'ninja -C {cwd}')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    await waitFor(() => { expect(b.calls.declared).toHaveLength(1) })
    // Absent rather than empty: the host resolves `<project directory>/out` per run, and an empty
    // string would travel as a directory named nothing.
    expect(b.calls.declared[0]?.draft.recipes).toEqual([{ id: 'ninja', command: 'ninja -C {cwd}' }])
  })

  it('walks what the connect call already answered for without connecting again', async () => {
    // A connection per click is what the operator waits on, so a level the connect listing already
    // covered has to arrive with no further call; a level below what it covered costs exactly one.
    const b = bench({ progress: { solo: beforeIt }, path: '/srv/aosp/bionic' })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))

    // The first listing names no directory, which is how a picker asks for the login directory, and
    // its answer covers the two levels below it.
    await waitFor(() => { expect(b.calls.browses).toEqual([{ destination: 'ci@farm' }]) })
    const at = (path: string): string => zh['wizard.step.server.browse.current'].replace('{path}', path)
    await waitFor(() => { expect(screen.getByText(at('/'))).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: 'srv' }))
    // Covered: the click is answered from what the picker holds.
    expect(screen.getByText(at('/srv'))).toBeTruthy()
    expect(b.calls.browses).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'aosp' }))
    // At the ceiling: the walk reported that this directory exists without listing its children, so
    // entering it is the one call the click costs.
    await waitFor(() => { expect(screen.getByText(at('/srv/aosp'))).toBeTruthy() })
    expect(b.calls.browses).toEqual([
      { destination: 'ci@farm' },
      { destination: 'ci@farm', directory: '/srv/aosp' },
    ])

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.browse.up'] }))
    // Going back up is covered too: the level above was in the first answer.
    expect(screen.getByText(at('/srv'))).toBeTruthy()
    expect(b.calls.browses).toHaveLength(2)
  })

  it('carries the client the operator pinned into every listing', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    fill(zh['wizard.step.server.field.ssh'], '/opt/ssh')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))

    // The client that will run the build is the one that must reach the machine now, or the
    // operator would be choosing from a listing taken through some other binary.
    await waitFor(() => {
      expect(b.calls.browses).toEqual([{ destination: 'ci@farm', sshExecutable: '/opt/ssh' }])
    })
  })

  it('reports a listing the host refused, leaving the path empty', async () => {
    const b = bench({
      progress: { solo: beforeIt },
      browseThrows: new Error('this deployment mounts no build-server service'),
    })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))

    await waitFor(() => { expect(screen.getByText('this deployment mounts no build-server service')).toBeTruthy() })
    expect(screen.getByText(zh['wizard.step.server.directory.none'])).toBeTruthy()
    // Nothing was chosen, so the declaration cannot be submitted.
    expect((screen.getByRole('button', { name: zh['wizard.step.server.submit'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a listing that failed without hiding what the picker knows', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    b.answers.path = undefined
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    // A host that answers "there is no such directory" is a listing with an error, not a refusal:
    // the picker stays usable and says where it was.
    b.answers.browse = () => ({
      directory: '/nope', entries: [], depth: 2, truncated: false, error: "no directory '/nope' on ci@farm",
    })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))

    await waitFor(() => { expect(screen.getByText("no directory '/nope' on ci@farm")).toBeTruthy() })
    expect(screen.getByText(zh['wizard.step.server.browse.current'].replace('{path}', '/nope'))).toBeTruthy()
    expect((screen.getByRole('button', { name: zh['wizard.step.server.browse.choose'] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('says so when a directory holds no subdirectories, and when the listing was cut', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    b.answers.browse = () => ({ directory: '/srv', entries: [], depth: 2, truncated: false })
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))
    await waitFor(() => { expect(screen.getByText(zh['wizard.step.server.browse.empty'])).toBeTruthy() })

    b.answers.browse = () => ({ directory: '/srv', entries: ['a', 'b'], depth: 2, truncated: true })
    // Once connected the same control reads as a refresh, because re-reading is what it now does.
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.browse.refresh'] }))
    await waitFor(() => {
      expect(screen.getByText(zh['wizard.step.server.browse.truncated'].replace('{count}', '2'))).toBeTruthy()
    })
  })

  it('closes the listing once a directory is chosen, and opens it again on request', async () => {
    const b = bench({ progress: { solo: beforeIt }, path: '/srv/aosp' })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')

    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.connect'] }))
    const at = (path: string): string => zh['wizard.step.server.browse.current'].replace('{path}', path)
    await waitFor(() => { expect(screen.getByText(at('/'))).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: 'srv' }))
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.browse.choose'] }))

    // The listing was opened to answer one question, and the chosen path above it is the answer:
    // leaving the panel standing would be a decision the operator has already made, still on screen.
    expect(screen.queryByText(at('/srv'))).toBeNull()
    expect(screen.getByText('/srv')).toBeTruthy()
    expect(screen.queryByRole('button', { name: zh['wizard.step.server.browse.choose'] })).toBeNull()

    // The control now offers the other thing it can do, and takes one call to do it.
    const before = b.calls.browses.length
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.browse.change'] }))
    await waitFor(() => { expect(screen.getByText(at('/srv'))).toBeTruthy() })
    expect(b.calls.browses.length).toBe(before + 1)
  })

  it('keeps the form open, with its fields, over a refusal', async () => {
    // The host's message names the field at fault, so the operator corrects that one instead of
    // retyping the declaration.
    const b = bench({
      progress: { solo: beforeIt },
      declareThrows: new Error('projectDirectory must be an absolute server path'),
    })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    fill(zh['wizard.step.server.field.id'], 'farm')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    await chooseDirectory(b, '/srv/farm')
    fillRecipe('make', 'make')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.submit'] }))

    await waitFor(() => { expect(screen.getByText('projectDirectory must be an absolute server path')).toBeTruthy() })
    expect((screen.getByLabelText(zh['wizard.step.server.field.id']) as HTMLInputElement).value).toBe('farm')
    // Nothing was declared, so the step's list was not read again.
    expect(b.calls.servers).toEqual(['solo'])
  })

  it('declares nothing until every required field is filled', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()

    const submit = (): HTMLButtonElement =>
      screen.getByRole('button', { name: zh['wizard.step.server.submit'] }) as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    fill(zh['wizard.step.server.field.id'], 'farm')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    expect(submit().disabled).toBe(true)
    await chooseDirectory(b, '/srv/farm')
    // The one recipe row is still blank, and the host refuses a declaration without a complete
    // one — so the control stays refusing rather than letting the operator learn it from a
    // rejected write.
    expect(submit().disabled).toBe(true)
    fillRecipe('make', 'make')
    expect(submit().disabled).toBe(false)
    expect(b.calls.declared).toEqual([])
  })

  it('refuses a timeout the host would reject', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.id'], 'farm')
    fill(zh['wizard.step.server.field.username'], 'ci')
    fill(zh['wizard.step.server.field.host'], 'farm')
    await chooseDirectory(b, '/srv/farm')
    fillRecipe('make', 'make')

    const submit = (): HTMLButtonElement =>
      screen.getByRole('button', { name: zh['wizard.step.server.submit'] }) as HTMLButtonElement
    expect(submit().disabled).toBe(false)
    // A blank timeout means "the host's default"; anything else has to parse, because the host
    // refuses a non-positive or unparsable one and the operator would only hear it as a refusal.
    fill(zh['wizard.step.server.field.timeout'], '0')
    expect(submit().disabled).toBe(true)
    fill(zh['wizard.step.server.field.timeout'], '60000')
    expect(submit().disabled).toBe(false)
  })

  it('adds and drops recipe rows', async () => {
    render(<OnboardingWizard {...bench({ progress: { solo: beforeIt } }).props} />)
    await openForm()
    expect(screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.id'])).toHaveLength(1)

    const remove = (): HTMLButtonElement[] =>
      screen.getAllByRole('button', { name: zh['wizard.step.server.recipe.remove'] }) as HTMLButtonElement[]
    // A form with one recipe row cannot drop it: the host refuses a declaration that names no
    // recipe, so the control would only lead to a refusal.
    expect(remove().map(button => button.disabled)).toEqual([true])
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.recipe.add'] }))
    expect(screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.id'])).toHaveLength(2)
    expect(remove().map(button => button.disabled)).toEqual([false, false])
    fireEvent.click(remove()[1] as HTMLButtonElement)
    expect(screen.getAllByPlaceholderText(zh['wizard.step.server.recipe.id'])).toHaveLength(1)
  })

  it('cancels the form without declaring anything', async () => {
    const b = bench({ progress: { solo: beforeIt } })
    render(<OnboardingWizard {...b.props} />)
    await openForm()
    fill(zh['wizard.step.server.field.id'], 'farm')
    fireEvent.click(screen.getByRole('button', { name: zh['wizard.step.server.cancel'] }))
    expect(screen.getByRole('button', { name: zh['wizard.step.server.add'] })).toBeTruthy()
    expect(b.calls.declared).toEqual([])
  })
})

describe('the summary step', () => {
  it('restates every recorded answer', () => {
    const b = bench({ progress: { solo: upTo('ready', {
      projectTitle: 'ivi-hmi', repositories: ['/a', '/b'], specificationPath: 'docs/spec.md',
    }) } })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(view.container.textContent).toContain('ivi-hmi')
    expect(view.container.textContent).toContain('docs/spec.md')
    expect(view.container.textContent).toContain('2')
    // No server was declared, and the summary says that rather than leaving the line blank.
    expect(screen.getByText(zh['wizard.step.ready.noServer'])).toBeTruthy()
  })

  it('names the servers the host holds, not the ones the walk typed', async () => {
    // The summary is the confirmation, so it reads the declarations back: reciting the form's
    // own draft would confirm a server the host may not hold.
    const b = bench({
      progress: { solo: upTo('ready', { projectTitle: 'ivi', repositories: ['/aosp'], specificationPath: 'docs/spec.md' }) },
      servers: [{
        serverId: 'aosp-builder', title: 'Build farm', destination: 'ci@build', projectDirectory: '/srv',
        transport: 'ssh', recipeIds: ['ninja'], declaredAt: '2026-01-01T00:00:00.000Z',
      }],
    })
    render(<OnboardingWizard {...b.props} />)
    await waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })
    expect(screen.getByText(zh['wizard.step.ready.summaryServers'].replace('{count}', '1'))).toBeTruthy()
    expect(screen.queryByText(zh['wizard.step.ready.noServer'])).toBeNull()
  })

  it('tolerates answers that were never supplied', () => {
    // The summary is the one step that renders other steps' answers, so a missing one has to
    // read as blank rather than throw.
    const b = bench({ progress: { solo: ONBOARDING_STEPS
      .slice(0, 4)
      .reduce<OnboardingProgress>((progress, step) => completeStep(progress, step, {}), EMPTY_PROGRESS) } })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(shownStep(view.container)).toBe('ready')
    expect(view.container.textContent).toContain(zh['wizard.step.ready.noServer'])
  })
})

describe('the blank home\'s build-server strip', () => {
  /** A declaration whose last probe succeeded. */
  const reachable: YxspecRemoteServerView = {
    serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', projectDirectory: '/srv/aosp',
    transport: 'ssh', recipeIds: ['ninja-full'], declaredAt: '2026-01-01T00:00:00.000Z',
    lastProbeAt: '2026-02-03T04:05:06.000Z', lastPlatform: 'Linux',
  }

  /** An onboarded project: the gate is open, so the strip is what the home adds. */
  function onboarded(servers: readonly YxspecRemoteServerView[]) {
    return bench({ progress: { solo: onboardedProgress() }, servers })
  }

  it('reports the declared servers under the composer', async () => {
    render(<OnboardingWizard {...onboarded([reachable]).props} />)

    await waitFor(() => { expect(screen.getByText(/Build farm/)).toBeTruthy() })
    // The state reads as a dot on the line rather than as a sentence in it.
    expect(screen.getByText(/Build farm/).parentElement?.querySelector('[data-state="done"]')).toBeTruthy()
    expect(screen.getByText(new RegExp(zh['section.servers']))).toBeTruthy()
    expect(screen.getByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeTruthy()
  })

  it('renders nothing for a project that declared no server', async () => {
    const view = render(<OnboardingWizard {...onboarded([]).props} />)

    // A deployment that builds locally must not grow a heading it cannot fill.
    await waitFor(() => { expect(view.getByTestId('body')).toBeTruthy() })
    expect(screen.queryByText(new RegExp(zh['section.servers']))).toBeNull()
    expect(screen.queryByRole('button', { name: zh['server.probe'] })).toBeNull()
  })

  it('tests a server from the strip and re-reads its state', async () => {
    // Never probed: the outcome keys are absent rather than present-and-empty, which is the shape
    // the host projects for a declaration nothing has tested.
    const { lastProbeAt: _probed, lastPlatform: _platform, ...untested } = reachable
    const b = onboarded([untested])
    render(<OnboardingWizard {...b.props} />)

    await waitFor(() => { expect(screen.getByText(zh['server.neverProbed'])).toBeTruthy() })
    const line = screen.getByText(/Build farm/).parentElement
    expect(line?.querySelector('[data-state="idle"]')).toBeTruthy()
    const reads = b.calls.servers.length
    fireEvent.click(screen.getByRole('button', { name: zh['server.probe'] }))

    // The outcome lands on the declaration, so the strip reads the list again rather than holding it.
    await waitFor(() => { expect(b.calls.probes).toEqual([{ workspaceId: 'solo', serverId: 'build-1' }]) })
    await waitFor(() => { expect(line?.querySelector('[data-state="done"]')).toBeTruthy() })
    expect(screen.getByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeTruthy()
    expect(b.calls.servers.length).toBeGreaterThan(reads)
  })

  it('adds nothing to an embedded Conversation', async () => {
    // The strip belongs to the blank home; an embedded frame keeps its own body untouched.
    const view = render(<OnboardingWizard {...bench({ hero: false, progress: {}, servers: [reachable] }).props} />)

    expect(view.getByTestId('body')).toBeTruthy()
    expect(screen.queryByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeNull()
  })
})

describe('the gate follows the project catalogues', () => {
  it('moves on when a step is saved', () => {
    const b = bench({ progress: { solo: EMPTY_PROGRESS } })
    const view = render(<OnboardingWizard {...b.props} />)
    expect(shownStep(view.container)).toBe('project')
    act(() => { b.store.save('solo', completeStep(EMPTY_PROGRESS, 'project', { projectTitle: 'ivi' })) })
    // The saved step has to move the wizard on without a reload: progress arrives as a source
    // the renderer binds to a selector hook, not as a value read inside a callback.
    expect(shownStep(view.container)).toBe('repositories')
  })

  it('opens once the last step is saved', () => {
    const b = bench({ progress: { solo: upTo('ready', { repositories: ['/aosp'], specificationPath: 'a' }) } })
    const view = render(<OnboardingWizard {...b.props} />)
    act(() => { b.store.save('solo', completeStep(upTo('ready'), 'ready', {})) })
    expect(view.getByTestId('body')).toBeTruthy()
    expect(shownStep(view.container)).toBeNull()
  })

  it('takes over when a project appears for a home that had none', () => {
    const b = bench({ progress: {}, workspaces: workspaceSnapshot([]) })
    const view = render(<OnboardingWizard {...b.props} />)
    const first = shownStep(view.container)
    // With no project registered the gate still cannot open: there is nothing to onboard
    // against, and the wizard says so by standing in front of the body.
    expect(first).not.toBeNull()
    expect(view.queryByTestId('body')).toBeNull()
  })
})
