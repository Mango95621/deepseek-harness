/**
 * The YXSpec plugin's two halves: the browser entry's registrations against the real
 * SlotRegistry (dictionaries, the session-panel section, and the onboarding gate) and the inert
 * node entry.
 *
 * The registrations are the contract these specs own. The gate's own decision is covered by the
 * wizard's suite; what is proven here is that the layer is *installed* on
 * `conversation.hero.frame` outermost, that it declares the locale namespace its `t` seat needs,
 * and that the data face it injects answers the way a partially deployed host requires —
 * a missing namespace and a refused call both read as "nothing to enumerate", never as an error,
 * because onboarding is the first thing an operator does and it must not be where a half-deployed
 * host looks broken.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceCreateRequest, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { YxspecDocumentView, YxspecRemoteServerView } from '@deepseek-ai/dsh-yxspec-api/types'
import { apply, inject } from '../src/client/index.ts'
import type { OnboardingWizardInjected } from '../src/client/OnboardingWizard.tsx'
import type { YxspecSectionInjected } from '../src/client/slots.ts'
import { completeStep, EMPTY_PROGRESS, EMPTY_REQUEST, ONBOARDING_STEPS, type OnboardingProgress } from '../src/client/onboarding.ts'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as applyNode } from '../src/index.ts'

/** The two clips the gate rides; the root declaration supplies both. */
const HERO_FRAME = 'conversation.hero.frame'
const PANEL_SECTION = 'conversation.session.panel.section'

/** A project id, branded the way the registry hands one back. */
const wid = (id: string): WorkspaceId => id as WorkspaceId

/** One candidate document, as the Remote would project it. */
const DOCUMENT: YxspecDocumentView = { path: 'specs/spec.md', title: 'spec', size: 12, rootIndex: 0 }

/** One declared build server, as the Remote would project it. */
const SERVER: YxspecRemoteServerView = {
  serverId: 'build-1', title: 'Build farm', destination: 'ci@farm', baseDirectory: '/srv/build',
  transport: 'ssh', recipeIds: ['make'], declaredAt: '2026-01-01T00:00:00.000Z',
}

/** A project create the Host accepts; the gate only forwards the payload it was handed. */
function created(input: WorkspaceCreateRequest): WorkspaceView {
  const roots = input.roots ?? (input.path === undefined ? [] : [input.path])
  return {
    workspaceId: wid('ws'),
    roots,
    path: roots[0] ?? null,
    title: input.title ?? 'ws',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * The `workspaces` service key the gate drives.
 *
 * Every mutation the wizard can reach is recorded rather than merely answered: what these specs
 * check is that the wizard routes a step to the *command it names*, so the recorded payloads
 * are the assertion.
 */
function workspacesService(creates: WorkspaceCreateRequest[]) {
  const renames: { workspaceId: string; title: string }[] = []
  const added: { workspaceId: string; path: string }[] = []
  const removed: { workspaceId: string; path: string }[] = []
  const view = (workspaceId: string, roots: readonly string[], title: string): WorkspaceView => ({
    workspaceId: wid(workspaceId), roots, path: roots[0] ?? null, title, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })
  // The listed projects, empty until a spec stages one. The guided-creation claim resolves its
  // subject from this list, so a spec that needs "there is a project here" stages it rather than
  // mocking the resolver — the rule under test is the guide's, not the catalogue's.
  let items: WorkspaceView[] = []
  return {
    list: { getSnapshot: () => ({ items, phase: 'ready' }), subscribe: () => () => {} },
    /** Stage the projects the claim resolves against. */
    stage: (next: WorkspaceView[]): void => { items = next },
    create: (input: WorkspaceCreateRequest) => {
      creates.push(input)
      return Promise.resolve(created(input))
    },
    rename: (workspaceId: string, title: string) => {
      renames.push({ workspaceId, title })
      return Promise.resolve(view(workspaceId, ['/aosp'], title))
    },
    addRoot: (workspaceId: string, path: string) => {
      added.push({ workspaceId, path })
      return Promise.resolve(view(workspaceId, [path], 'ws'))
    },
    removeRoot: (workspaceId: string, path: string) => {
      removed.push({ workspaceId, path })
      return Promise.resolve(view(workspaceId, [], 'ws'))
    },
    renames,
    added,
    removed,
  }
}

/** One project's onboarding record, as the store holds it. */
const RECORD: OnboardingProgress = completeStep(EMPTY_PROGRESS, 'project', { projectTitle: 'ivi' })

/** A record with every step settled — a project whose walk has nothing left to resume. */
function onboardedRecord(): OnboardingProgress {
  return ONBOARDING_STEPS.reduce<OnboardingProgress>(
    (progress, step) => completeStep(progress, step, {}), EMPTY_PROGRESS,
  )
}

/**
 * The `uiWorkspace` service key the guided-creation flow drives.
 *
 * Two calls matter and are recorded rather than merely answered: `openHome` is how a walk raised
 * from the sidebar reaches the only surface its gate rides, and `startSession` is how a finished
 * walk turns into an opened project. The recorded order is the assertion for both.
 */
function uiWorkspaceService() {
  const calls: string[] = []
  const opened: { readonly workspaceId?: string }[] = []
  return {
    calls,
    opened,
    openHome: () => { calls.push('openHome') },
    startSession: (workspaceId?: string) => {
      calls.push('startSession')
      // Omitted rather than set to `undefined`: `exactOptionalPropertyTypes` distinguishes the
      // two, and the real call site passes either a project id or nothing at all.
      opened.push(workspaceId === undefined ? {} : { workspaceId })
    },
  }
}

/**
 * Boot the browser half over a real slot tree that declares the two clips.
 *
 * The Remote namespaces start scripted and mutable: a spec moves the answer between calls to
 * stage a refused call, and clears the property to stage a Host whose plugin is absent — the two
 * shapes the wizard's reads have to survive.
 * @returns the mounted context, the Remote double, the recorded creates, and the two inject faces.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      [HERO_FRAME]: { kind: 'hoc', scope: 'root' },
      [PANEL_SECTION]: { kind: 'list', scope: 'session' },
    },
  } as never, () => null)

  const creates: WorkspaceCreateRequest[] = []
  const workspaces = workspacesService(creates)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('sessions', { list: { getSnapshot: () => ({ ids: [] }), subscribe: () => () => {} } } as never)
  // The guided-creation flow navigates through `uiWorkspace`: it is what moves the operator to the
  // blank home the gate rides, and what opens the project a finished walk created. Both are
  // recorded so a spec can assert the navigation happened, not merely that it was reachable.
  const uiWorkspace = uiWorkspaceService()
  ctx.provide('uiWorkspace', uiWorkspace as never)

  const yxspec = {
    status: (landedStages?: string[]) => Promise.resolve({ ok: true, value: { stages: [], landedStages } }),
    documents: (workspaceId: string) => Promise.resolve({
      ok: true,
      value: {
        documents: [{ ...DOCUMENT, path: `${workspaceId}/spec.md` }],
        searched: [`/projects/${workspaceId}/project/inputs`],
        truncated: false,
      },
    }),
  }
  const yxspecRemote = {
    servers: (workspaceId: string) => Promise.resolve({ ok: true, value: [{ ...SERVER, serverId: workspaceId }] }),
  }
  const pickerAnswers: { ok: boolean; value?: string; message?: string }[] = []
  const directoryPicker = {
    pick: () => {
      const answer = pickerAnswers.shift()
      if (answer === undefined) throw new Error('no scripted picker answer')
      return Promise.resolve(answer.ok
        ? { ok: true as const, value: answer.value }
        : { ok: false as const, error: new RemoteError('gateway/internal', answer.message ?? '', {}) })
    },
  }
  const remote = new TestRemote(ctx, { yxspec, yxspecRemote, directoryPicker })

  // The locale plugin binds a settings scope, which reads the connection handle and the
  // forwarded-event port.
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('configForms', { get: () => undefined } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  // These specs assert the shipped Chinese copy. There is no jsdom `window` in this lane, so
  // browser-language detection never runs and the locale comes from FALLBACK_LOCALE (en): state
  // the asserted locale explicitly.
  ctx.locale.setLocale('zh')

  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  onTestFinished(() => ctx.fiber.dispose())

  const sectionFace = ctx.slots.entries(PANEL_SECTION)
    .find(entry => entry.options.id === 'yxspec')?.inject as (() => YxspecSectionInjected) | undefined
  const wizardFace = ctx.slots.entries(HERO_FRAME)[0]?.inject as (() => OnboardingWizardInjected) | undefined
  if (sectionFace === undefined || wizardFace === undefined) {
    throw new Error('expected both halves to register an inject face')
  }
  return {
    ctx, fiber, remote, creates, workspaces, uiWorkspace,
    section: sectionFace(),
    wizard: wizardFace(),
    setYxspec: (next: unknown): void => { Object.assign(remote, { yxspec: next }) },
    setYxspecRemote: (next: unknown): void => { Object.assign(remote, { yxspecRemote: next }) },
    answerPick: (answer: { ok: boolean; value?: string; message?: string }): void => { pickerAnswers.push(answer) },
  }
}

describe('ui-yxspec browser half', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual([
      'remote', 'remote.yxspec', 'remote.yxspecRemote', 'remote.directoryPicker',
      'slots', 'locale', 'workspaces', 'sessions', 'uiWorkspace',
    ])
  })

  it('registers the panel section, keyed so its label follows the locale', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries(PANEL_SECTION).find(candidate => candidate.options.id === 'yxspec')
    expect(entry?.options).toMatchObject({ id: 'yxspec', order: 20 })
    // Declaring the namespace is what puts the `t` seat on the composed props; the nav label is a
    // locale-following thunk, so an owner resolves it at read time rather than at registration.
    expect(entry?.locale).toBe(NS)
    expect(resolveSlotLabel(entry?.options.label)).toBe(zh['section.title'])
  })

  it('installs the gate as the outermost hero-frame layer, under the locale seat it renders with', async () => {
    const b = await bench()
    const hero = b.ctx.slots.entries(HERO_FRAME)
    expect(hero).toHaveLength(1)
    // Outermost (lowest order wins the outside): the gate decides whether the scroll body exists
    // at all, so it has to wrap the decorative layers rather than sit inside one of them.
    expect(hero[0]?.options).toMatchObject({ id: 'yxspec-onboarding', order: -100 })
    expect(hero[0]?.locale).toBe(NS)
  })

  it('drops both registrations and the dictionaries when the fiber unloads', async () => {
    const b = await bench()
    const translate = b.ctx.locale.bind(NS)
    expect(translate('wizard.title')).toBe(zh['wizard.title'])
    b.ctx.locale.setLocale('en')
    expect(translate('wizard.title')).toBe(en['wizard.title'])

    await b.fiber.dispose()
    expect(b.ctx.slots.entries(HERO_FRAME)).toHaveLength(0)
    expect(b.ctx.slots.entries(PANEL_SECTION)).toHaveLength(0)
    // Withdrawn dictionaries leave the key unresolved rather than translated.
    expect(translate('wizard.title')).not.toBe(en['wizard.title'])
  })

  it('keeps every shipped dictionary key-identical to the Chinese source of truth', () => {
    // The default locale's shape is the key union; a locale missing a key is a hole the
    // operator would see as a raw key string in one language only.
    for (const dict of [en, zh]) expect(Object.keys(dict).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('the section data face', () => {
  it('passes the landed-stage list through and unwraps the projected state', async () => {
    const b = await bench()
    // The section renders the value itself: `load` unwraps the carrier's envelope, so what the
    // component sees is the state or nothing — never an `{ ok }` it would have to know about.
    await expect(b.section.load(['design', 'verify'])).resolves.toMatchObject({ landedStages: ['design', 'verify'] })
    await expect(b.section.load()).resolves.toMatchObject({ landedStages: undefined })
  })

  it.each([
    ['the namespace is absent', undefined],
    ['the call is refused', { status: () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'no', {}) }) }],
  ])('reads as unavailable when %s', async (_name, namespace) => {
    const b = await bench()
    b.setYxspec(namespace)
    await expect(b.section.load()).resolves.toBeUndefined()
  })
})

describe('the wizard data face', () => {
  it('hands the store over as a source rather than reading it through a closure', async () => {
    const b = await bench()
    const store = b.wizard.hooks.onboardingProgress
    expect(store.getSnapshot()).toEqual({})
    const seen: unknown[] = []
    store.subscribe(() => { seen.push(store.getSnapshot()) })
    b.wizard.saveProgress('solo', RECORD)
    // The renderer binds this source to a selector hook, so a save has to notify: a value read
    // inside a callback would decide correctly once and never re-render.
    expect(store.getSnapshot()).toEqual({ solo: RECORD })
    expect(seen).toEqual([{ solo: RECORD }])
  })

  it('records nothing without a project to key the record by', async () => {
    const b = await bench()
    b.wizard.saveProgress(undefined, RECORD)
    expect(b.wizard.hooks.onboardingProgress.getSnapshot()).toEqual({})
  })

  it('keys each project separately', async () => {
    const b = await bench()
    b.wizard.saveProgress('one', RECORD)
    b.wizard.saveProgress('two', EMPTY_PROGRESS)
    expect(b.wizard.hooks.onboardingProgress.getSnapshot()).toEqual({ one: RECORD, two: EMPTY_PROGRESS })
  })

  it.each([
    ['the namespace is absent', undefined, { documents: [], searched: [], truncated: false }],
    ['the call is refused', { documents: () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'no', {}) }) }, { documents: [], searched: [], truncated: false }],
    ['the call answers nothing', { documents: () => Promise.resolve({ ok: true, value: undefined }) }, { documents: [], searched: [], truncated: false }],
  ])('enumerates no document when %s', async (_name, namespace, expected) => {
    const b = await bench()
    b.setYxspec(namespace)
    await expect(b.wizard.loadDocuments('solo', [])).resolves.toEqual(expected)
  })

  it('reads the documents of the project it was handed', async () => {
    const b = await bench()
    await expect(b.wizard.loadDocuments('solo', [])).resolves.toEqual({
      documents: [{ ...DOCUMENT, path: 'solo/spec.md' }],
      searched: ['/projects/solo/project/inputs'],
      truncated: false,
    })
  })

  it('forwards the operator’s added directories to the host rather than filtering host-side', async () => {
    // The additions are the caller's to hold: this face is what carries them across the Remote
    // boundary, so a listing that silently dropped them would show the project's own layout for
    // a search the operator had already widened.
    const b = await bench()
    const asked: unknown[][] = []
    b.setYxspec({
      documents: (workspaceId: string, extraDirectories: string[]) => {
        asked.push([workspaceId, extraDirectories])
        return Promise.resolve({ ok: true, value: { documents: [], searched: [], truncated: false } })
      },
    })
    await b.wizard.loadDocuments('solo', ['/shared/spec', '/delivered/prd'])
    // Copied into a fresh array: the host receives a value it can hold, not the caller's own
    // list, which a later edit could change under it.
    expect(asked).toEqual([['solo', ['/shared/spec', '/delivered/prd']]])
  })

  it.each([
    ['the namespace is absent', undefined, []],
    ['the call is refused', { servers: () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'no', {}) }) }, []],
    ['the call answers nothing', { servers: () => Promise.resolve({ ok: true, value: undefined }) }, []],
  ])('declares no server when %s', async (_name, namespace, expected) => {
    const b = await bench()
    b.setYxspecRemote(namespace)
    // An absent remote plugin is not a failure: the step's answer is still "none declared".
    await expect(b.wizard.loadServers('solo')).resolves.toEqual(expected)
  })

  it('reads the servers declared for the project it was handed', async () => {
    const b = await bench()
    await expect(b.wizard.loadServers('solo')).resolves.toEqual([{ ...SERVER, serverId: 'solo' }])
  })

  it('creates a project over a name alone, then records the step against the id it answered', async () => {
    const b = await bench()
    await b.wizard.nameProject(undefined, 'ivi-hmi')
    // A title and no directory: the shape that makes "name the work first, point it at code
    // after" expressible, and the reason step 2 can be an append rather than a second create.
    expect(b.creates).toEqual([{ title: 'ivi-hmi' }])
    // The create's own id keys both writes. This is why the seam lives here: the component
    // never renders with this id, so it could not have written either record itself.
    expect(b.wizard.hooks.onboardingTarget.getSnapshot()).toEqual({ workspaceId: 'ws' })
    expect(b.wizard.hooks.onboardingProgress.getSnapshot().ws?.completed).toEqual(['project'])
    expect(b.wizard.hooks.onboardingProgress.getSnapshot().ws?.answers.projectTitle).toBe('ivi-hmi')
  })

  it('renames the project it already resolved instead of creating a second one', async () => {
    const b = await bench()
    // A rootless project has no path for `create` to match on, so "create always and let the
    // host dedupe" would silently make a second project on every revisit.
    await b.wizard.nameProject(wid('existing'), 'ivi-hmi')
    expect(b.creates).toEqual([])
    expect(b.workspaces.renames).toEqual([{ workspaceId: 'existing', title: 'ivi-hmi' }])
    expect(b.wizard.hooks.onboardingTarget.getSnapshot()).toEqual({ workspaceId: 'existing' })
  })

  it('keeps a later step’s answers when step 1 is reached again', async () => {
    const b = await bench()
    // Reopening step 1 from a walk already past it must not clear what the later steps
    // recorded — the save merges, it does not replace.
    b.wizard.saveProgress('ws', {
      completed: ['project', 'repositories'], answers: { repositories: ['/aosp'] },
    })
    await b.wizard.nameProject(undefined, 'renamed')
    const record = b.wizard.hooks.onboardingProgress.getSnapshot().ws
    expect(record?.completed).toEqual(['project', 'repositories'])
    expect(record?.answers).toEqual({ repositories: ['/aosp'], projectTitle: 'renamed' })
  })

  it('appends and drops repository roots through the project, never through a create', async () => {
    const b = await bench()
    await b.wizard.addRepositoryRoot(wid('ws'), '/aosp')
    await b.wizard.removeRepositoryRoot(wid('ws'), '/aosp')
    expect(b.workspaces.added).toEqual([{ workspaceId: 'ws', path: '/aosp' }])
    expect(b.workspaces.removed).toEqual([{ workspaceId: 'ws', path: '/aosp' }])
  })

  it('answers a chosen directory, and a cancelled pick as undefined', async () => {
    const b = await bench()
    b.answerPick({ ok: true, value: '/aosp' })
    await expect(b.wizard.pickDirectory()).resolves.toBe('/aosp')
    // A picker that answered with no path is a cancellation, not a failure.
    b.answerPick({ ok: true })
    await expect(b.wizard.pickDirectory()).resolves.toBeUndefined()
  })

  it('reports a refused pick as an error the step can show', async () => {
    const b = await bench()
    b.answerPick({ ok: false, message: 'picker unavailable' })
    // The wizard catches this into its notice line; swallowing it here would leave the operator
    // with a button that appears to do nothing.
    await expect(b.wizard.pickDirectory()).rejects.toThrow('picker unavailable')
  })
})

describe('ui-yxspec node half', () => {
  it('contributes no host behavior', () => {
    // The node half exists only so the plugin appears in the Loader tree.
    expect(applyNode).not.toThrow()
    expect(EMPTY_PROGRESS.completed).toEqual([])
  })
})

/**
 * The guided-creation port the workspace surfaces claim the add gesture with.
 *
 * What these specs own is the *decision* `begin` makes, because that is the one thing the caller
 * cannot make for it: whether the gesture means "resume the walk already in flight" or "start a
 * new one" needs the resolved project's stored progress, which belongs to this package. The port
 * existing at all is the other claim — `ctx.provide` under the name the surfaces read.
 */
describe('the guided-creation port', () => {
  it('is registered as an optional service the workspace surfaces can read', async () => {
    const b = await bench()
    // Read the way the surfaces read it: `ctx.get` from another Context. Registration is what
    // makes the add gesture composable rather than replaced, so it is the port's own existence
    // that is asserted — not merely that `begin` is reachable through the returned face.
    expect(b.ctx.get('projectOnboarding')).toBeDefined()
  })

  it('starts a fresh walk when nothing is outstanding, and lands on the blank home', async () => {
    const b = await bench()
    // No project resolves from the empty catalogues, so there is nothing to resume: the gesture
    // means "let me name a new piece of work".
    b.ctx.projectOnboarding.begin()
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual({ starting: true })
    // The gate rides the blank home and nowhere else, so the navigation is part of the claim: a
    // request raised without it would sit unread until the operator happened to close their view.
    expect(b.uiWorkspace.calls).toEqual(['openHome'])
  })

  it('resumes the outstanding step of a project whose walk is unfinished', async () => {
    const b = await bench()
    b.workspaces.stage([created({ title: 'ivi' })])
    b.wizard.saveProgress('ws', RECORD)
    b.ctx.projectOnboarding.begin()
    // Nothing is raised: the gate already gates this project, so its home is what shows the
    // outstanding step, and a request would only be a second statement of the same thing.
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual(EMPTY_REQUEST)
    expect(b.uiWorkspace.calls).toEqual(['openHome'])
  })

  it('resumes an adopted project, whose roots already answered the first two steps', async () => {
    const b = await bench()
    // The case the record alone would answer wrongly the *other* way: a project adopted by
    // pointing at a directory has no record and has still answered steps 1 and 2, so reading the
    // stored record alone would call it unstarted and raise a fresh walk — which is exactly the
    // gesture that created it over a directory in the first place.
    b.workspaces.stage([created({ path: '/aosp' })])
    expect(b.wizard.hooks.onboardingProgress.getSnapshot()).toEqual({})
    b.ctx.projectOnboarding.begin()
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual(EMPTY_REQUEST)
    expect(b.uiWorkspace.calls).toEqual(['openHome'])
  })

  it('resumes rather than restarts a project whose walk was fully recorded but is being read again', async () => {
    const b = await bench()
    b.workspaces.stage([created({ title: 'ivi' })])
    // A finished project's walk has no outstanding step, so `begin` cannot resume it — and
    // restarting over it would ask for a title the project already has.
    b.wizard.saveProgress('ws', onboardedRecord())
    b.ctx.projectOnboarding.begin()
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual({ starting: true })
  })

  it('clears the request instead of navigating when the operator chose something else', async () => {
    const b = await bench()
    b.ctx.projectOnboarding.begin()
    b.uiWorkspace.calls.length = 0
    // Withdrawing answers a navigation gesture, so the caller is already on its way somewhere:
    // moving the view again would fight it. Writing the shared constant back is a no-op for a
    // store that already holds it, which is what makes "nothing outstanding" free.
    b.ctx.projectOnboarding.cancel()
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual(EMPTY_REQUEST)
    expect(b.uiWorkspace.calls).toEqual([])
  })

  it('opens the project a finished walk created, through the surface that gives it its blank', async () => {
    const b = await bench()
    await b.wizard.nameProject(undefined, 'ivi')
    b.wizard.finishOnboarding(wid('ws'))
    // The walk runs with no Session selected — a project with no root cannot have one — so
    // finishing is the first moment its project is somewhere the operator can work.
    expect(b.uiWorkspace.opened).toEqual([{ workspaceId: 'ws' }])
    // `startSession` rather than `openWorkspace`: it resolves the reusable blank the host already
    // has instead of minting a second one on a re-walk.
    expect(b.uiWorkspace.calls).toEqual(['startSession'])
  })

  it('answers the requested walk the moment step 1 creates the project', async () => {
    const b = await bench()
    b.ctx.projectOnboarding.begin()
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual({ starting: true })
    await b.wizard.nameProject(undefined, 'ivi')
    // Cleared here rather than when the walk finishes: a request still standing would keep
    // suppressing the resolution, so steps 2 onward would render against no project at all.
    expect(b.wizard.hooks.onboardingRequest.getSnapshot()).toEqual(EMPTY_REQUEST)
  })
})
