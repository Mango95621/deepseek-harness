/**
 * The onboarding wizard: the gate that stands between a blank home and a working
 * Conversation.
 *
 * It renders inside the `conversation.hero.frame` HOC layer and, while the current project is
 * not onboarded, **replaces the frame's children instead of wrapping them**. Those children
 * are the scroll body that holds the composer seat, so not rendering them is what removes the
 * input box — no second disable path, and no control that could re-enable it. Once every
 * prerequisite is recorded the layer renders its children untouched and the Conversation
 * behaves as it always did.
 *
 * One class of home is answered in advance rather than walked from the top, and it is a project
 * the operator established themselves. A project that already carries a repository root and
 * that no walk has ever started on was not the wizard's to create — it was adopted by pointing
 * at a directory, or minted by the default first-use path — so the two steps it has already
 * answered (its name, its repositories) are folded in as recorded and the walk opens at the
 * specification. Those steps are *recorded*, not skipped, so the trail still shows them, the
 * summary restates them, and Back reopens either one. A walk that has started is tracked by its
 * own record and is never re-derived this way, which is what keeps step 2's own root attachment
 * from rewriting the walk mid-flight.
 *
 * The wizard's order is forced by its data: the specification candidates are files inside the
 * project's declared roots, so the project and its repositories are settled first and only
 * then is there anything to enumerate. See `./onboarding.ts` for why.
 *
 * Step 1 is therefore where the project *comes into existence*: the operator supplies a name
 * and nothing else, the wizard creates the project over no directory, and step 2 attaches
 * repositories to it one at a time. The alternative — naming the project and pointing at its
 * directories in one act — is what the previous wizard did, and it made "I have named this
 * work, now let me point it at code" inexpressible; a project with no repository yet is a
 * legitimate state the host models, so the wizard exposes it rather than routing around it.
 *
 * A rootless project creates one resolution problem worth naming. The gate normally finds its
 * project in the session and workspace catalogues, but between the create and the next
 * catalogue frame those lists still describe the world before it, so the id the wizard just
 * received has to be remembered separately (`yxspec-onboarding-target`) — otherwise the walk
 * would drop the step that created the project, and a reload, which has no path to match on,
 * would create a second one.
 *
 * Reads are defensive at every step. A deployment without the `yxspec` or `yxspecRemote`
 * namespace, a project whose directories are empty, and a refused Remote call all render as a
 * quiet empty state rather than an error: onboarding is the first thing an operator does, and
 * it must not be where a partially deployed host looks broken.
 * @module @deepseek-ai/dsh-client-ui-yxspec/OnboardingWizard
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
// The project identity is a shared Host/Client shape that only the `types` entry declares; the
// `WorkspaceView` the hooks deliver arrives through `PropsRuntime`, so no import names it.
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import {
  Button, Checkbox, IconCheckOutlineRegular, IconFolderOpenRegular, IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type {
  YxspecDocumentListing,
  YxspecDocumentView,
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteProbe,
  YxspecRemoteServerDraft,
  YxspecRemoteServerView,
} from '@deepseek-ai/dsh-yxspec-api/types'
import type { NS } from './locales.ts'
import { resolveOnboardingProject } from './project.ts'
// The status wording is shared with the Session panel's section, so the two surfaces cannot
// describe one declaration differently.
import { ServerStateDot } from './ServerStateDot.tsx'
import {
  EMPTY_PROGRESS, ONBOARDING_STEPS, completeStep, currentStep, onboardingProgress, reopenStep, stepSatisfied,
  type OnboardingAnswers, type OnboardingProgress, type OnboardingState, type OnboardingStep,
  type OnboardingTarget, type OnboardingRequest,
} from './onboarding.ts'
import css from './OnboardingWizard.module.css'

/**
 * The wizard's registration-side business face.
 *
 * The component resolves the project it gates through these callbacks rather than through a
 * prop: a HOC layer's owner share belongs to the conversation package, and widening it would
 * make every other layer's props depend on this one's needs.
 */
export interface OnboardingWizardInjected {
  /**
   * The observable source the renderer binds to the `useOnboardingProgress` selector hook.
   *
   * Progress has to arrive as a source rather than through a callback read: saving a step
   * writes the store, and only a subscription tells React to render again. A value read
   * inside a function would be right at that instant and never updated afterwards.
   */
  hooks: {
    /** Every project's onboarding record, keyed by project id. */
    onboardingProgress: ObservableSnapshot<OnboardingState>
    /**
     * The project this walk created, so a reload keeps gating the same one.
     *
     * A project created over no directory has no path for the host's idempotent create to
     * match on, so it cannot be found by path afterwards; without this record a reloaded
     * wizard would silently create a second project.
     */
    onboardingTarget: ObservableSnapshot<OnboardingTarget>
    /**
     * A walk asked for from outside the wizard, which step 1 opens as a create over.
     *
     * Bound like the other two rather than injected as a value: the request flips while the
     * wizard is mounted (the gesture can arrive at any time), and this is the signal that
     * tells the gate to stop honoring the catalogue resolution and start a fresh walk.
     */
    onboardingRequest: ObservableSnapshot<OnboardingRequest>
  }
  /**
   * Persist one project's progress.
   * @param projectId - the project the record belongs to.
   * @param progress - the next record.
   */
  readonly saveProgress: (projectId: string | undefined, progress: OnboardingProgress) => void
  /**
   * Project-relative specification candidates for one project, with the directories the host
   * enumerated to find them.
   *
   * The report is part of the answer rather than a second call: an empty candidate list cannot
   * say on its own whether the project has no inputs yet or the wizard was pointed at the
   * wrong directory, and two calls could be answered by two different filesystem states.
   * @param workspaceId - the project to enumerate.
   * @param extraDirectories - absolute directories to search in addition to the project's own,
   *   in the order the operator added them.
   * @returns the candidates and where they were sought; empty when the host cannot enumerate.
   */
  readonly loadDocuments: (
    workspaceId: string,
    extraDirectories: readonly string[],
  ) => Promise<YxspecDocumentListing>
  /**
   * Declared build servers for one project.
   * @param workspaceId - the project to read.
   * @returns the declarations; empty when nothing is declared or the plugin is absent.
   */
  readonly loadServers: (workspaceId: string) => Promise<YxspecRemoteServerView[]>
  /**
   * Declare or replace one build server for a project.
   *
   * The step declares through the host rather than collecting a draft for later, because the
   * declaration is what a run resolves against: a server the operator typed but never stored
   * would let the walk finish declaring a build server that no `remote_build` call can find.
   * @param workspaceId - the project the declaration belongs to.
   * @param draft - the declaration the operator submitted.
   * @returns the stored declaration, as the step's list renders it.
   */
  readonly declareServer: (
    workspaceId: string,
    draft: YxspecRemoteServerDraft,
  ) => Promise<YxspecRemoteServerView>
  /**
   * Test one declared build server and report what the host answered.
   *
   * Separate from {@link loadServers} because it costs an SSH round trip: the step calls it when the
   * operator asks, and once after a declaration lands, rather than on every list render.
   * @param workspaceId - the project that declared the server.
   * @param serverId - the declaration to test.
   * @returns what the probe concluded; an unreachable host is reported, not thrown.
   */
  readonly probeServer: (workspaceId: string, serverId: string) => Promise<YxspecRemoteProbe>
  /**
   * List the directories under one path on a server, so the wizard can offer them instead of asking
   * for a path.
   *
   * Named by a destination rather than a declaration, and that is the point: the operator picks the
   * directory before the declaration that would name it exists.
   * @param request - the destination to reach and the directory to list.
   * @returns the listing; an unreachable host or a missing path is reported inside it, not thrown.
   */
  readonly browseServer: (request: YxspecRemoteBrowseRequest) => Promise<YxspecRemoteBrowse>
  /**
   * Name the project this walk is about, creating it when the walk has none yet.
   *
   * One call rather than a create plus a save, because they are one act. The project's id
   * does not exist until the create answers, and the progress record is keyed by that id, so
   * a component that created the project and then tried to record the step would be writing
   * under an identifier its own render never saw — it would have to re-resolve the project
   * from a catalogue that has not caught up yet, which for a rootless project never happens
   * by path at all.
   *
   * An existing project is renamed rather than duplicated: step 1 is reachable again from a
   * recorded walk, and by then naming the project is an edit, not a second creation.
   * @param projectId - the project this walk resolved, or undefined before it has one.
   * @param title - the operator's name for the project.
   */
  readonly nameProject: (projectId: WorkspaceId | undefined, title: string) => Promise<void>
  /**
   * Open the project the finished walk created.
   *
   * The last step is where the five add up to a created project: the gate governs a blank home,
   * so the whole walk runs with no Session selected and finishing is the first moment its project
   * is somewhere the operator can work. Omitted by a host whose workspace surfaces cannot open
   * one, in which case the walk still completes and the project appears in the sidebar.
   * @param workspaceId - the project the finished walk created.
   */
  readonly finishOnboarding: (workspaceId: WorkspaceId) => void
  /**
   * Append one repository root to the project step 1 created.
   *
   * An added root never becomes primary, which is exactly what step 2 needs: the first
   * directory appended to a rootless project lands at index 0 and *is* the primary root,
   * and every later one is appended behind it.
   * @param workspaceId - the project to extend.
   * @param path - existing directory to append.
   */
  readonly addRepositoryRoot: (workspaceId: WorkspaceId, path: string) => Promise<void>
  /**
   * Drop one repository root from a project.
   * @param workspaceId - the project to narrow.
   * @param path - directory to drop.
   */
  readonly removeRepositoryRoot: (workspaceId: WorkspaceId, path: string) => Promise<void>
  /**
   * Ask the host for a directory.
   *
   * One picker serves both steps that need a directory: step 2 attaches one as a repository
   * root, step 3 adds one to the specification search. The two differ in what they do with the
   * answer, not in how they ask, so they share the one host capability rather than each
   * carrying a near-identical twin that could drift.
   * @returns the chosen absolute path, or undefined when the operator cancelled.
   */
  readonly pickDirectory: () => Promise<string | undefined>
}

/** Full props of the wizard layer, as the composed slot contract delivers them. */
export type OnboardingWizardProps =
  PropsRuntime<'conversation.hero.frame'>
  & PropsLocale<typeof NS>
  & InjectFace<OnboardingWizardInjected>
  & { readonly children: ReactNode }

/**
 * Render the onboarding gate around the Conversation body.
 *
 * `hero` is the frame's own signal that this is a standalone blank home. The wizard only takes
 * over there: an embedded occurrence, a settling body, or an open conversation keeps its
 * composer, because none of them is where onboarding belongs.
 * @param props - the frame owner share, the wrapped body, and the wizard's data face.
 * @returns the wizard while the project is unonboarded, the untouched body otherwise.
 */
export function OnboardingWizard(props: OnboardingWizardProps): ReactNode {
  const { hero, children, useWorkspaces, useSessions, useOnboardingProgress, useOnboardingTarget, useOnboardingRequest, t } = props
  // All four reads are subscriptions, so a step's save, a project appearing, and a session
  // becoming current each re-render the gate. Reading them through a callback would decide
  // correctly once and never again.
  const workspaces = useWorkspaces(whole => whole)
  const sessions = useSessions(whole => whole)
  const target = useOnboardingTarget(whole => whole.workspaceId)
  const starting = useOnboardingRequest(whole => whole.starting === true)
  // A walk the operator asked for opens on a *new* project, so the catalogue resolution is
  // suppressed for its duration: the resolver would otherwise name whichever project the home
  // happens to belong to — and for an adopted one, its roots would fold steps 1 and 2 in as
  // recorded and open at the specification, which is the shape this walk exists to avoid. The
  // suppression lasts exactly as long as the request; step 1 clears it by creating the project.
  const projectId = starting ? undefined : resolveOnboardingProject(workspaces, sessions, target)
  // The resolved project's own row, and its declared roots straight off it: step 2 renders the
  // host's answer rather than a draft, so a root added or dropped anywhere else is visible here
  // too.
  const row = workspaces.items.find(item => item.workspaceId === projectId)
  const roots = row?.roots ?? []
  // The record for this project, or `undefined` when no walk has touched it.
  //
  // The absence is load-bearing and is therefore *not* collapsed into the empty record
  // (as a plain `?? EMPTY_PROGRESS` would). A project that arrived with a repository root and
  // no record was not the wizard's to create — it was adopted by pointing at a directory, or
  // minted by the first-use default — and it has already answered the wizard's first two steps.
  // Onboarding still applies to it: a specification, a server, and a confirmation are what an
  // ASPICE run needs, and none of them follows from having a directory. Asking for its name and
  // its repositories a second time is the part that would be busywork, so those two are folded
  // in as *recorded* rather than skipped — the walk opens at `specification` with a history
  // behind it, which is what lets Back reopen step 2 and change a wrong directory.
  //
  // A walk that has started keeps its own record and is never re-derived from the row: step 1
  // creates a *rootless* project and step 2 attaches its first root, so reading roots alone
  // would re-answer step 2 under the walk's feet the moment its own root landed.
  //
  // A requested walk reads no record at all: it is a request for a new project, and honoring an
  // earlier walk's record — or the target that names its project — is what would open it mid-way.
  const record = useOnboardingProgress(whole => whole[starting ? '' : projectId ?? ''])
  const progress = starting ? EMPTY_PROGRESS : onboardingProgress(record, row)
  const step = currentStep(progress)
  const [revisit, setRevisit] = useState<OnboardingStep | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  // The blank home is where the operator asks "will this build?" before typing anything, and it
  // is also the only surface a project has before its first Session — so the build servers the
  // project declared are reported here, under the composer, and nowhere else requires the
  // operator to know where a panel lives.
  const buildServers = hero ? (
    <BuildServerStrip
      projectId={projectId}
      loadServers={props.loadServers}
      probeServer={props.probeServer}
      t={t}
    />
  ) : null

  // The gate's open branch, and it must be exact: rendering the wizard over an onboarded
  // project would hide a live composer behind a form.
  if (!hero || step === undefined) return <>{children}{buildServers}</>

  const shown = revisit ?? step
  const complete = (answers: OnboardingAnswers): void => {
    props.saveProgress(projectId, completeStep(progress, shown, answers))
    setRevisit(undefined)
    setNotice(undefined)
  }
  // Back reopens the step before the one on screen and leaves it there. The earlier claim
  // that it was settled is withdrawn — the trail stops showing it as done — because an
  // operator who steps back to change an answer has not finished re-answering yet. Answers
  // survive (`reopenStep`), so the step reopens prefilled rather than blank.
  //
  // The target is a parameter rather than a closure read: the first step has nothing before
  // it, so the footer is what decides whether Back exists, and passing the already-narrowed
  // value here leaves no unreachable guard inside the handler.
  const previous = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(shown) - 1]
  const back = (target: OnboardingStep): void => {
    props.saveProgress(projectId, reopenStep(progress, target))
    setRevisit(target)
    setNotice(undefined)
  }
  // Forward: from a reopened step, return to the outstanding one without re-deciding.
  const review = revisit !== undefined

  return (
    <div className={css.layer}>
      <section className={css.card} data-yxspec-onboarding={shown}>
        <header className={css.header}>
          <h2 className={css.title}>{t('wizard.title')}</h2>
          <p className={css.subtitle}>{t('wizard.subtitle')}</p>
        </header>
        <Trail progress={progress} current={shown} t={t} />
        <div className={css.body}>
          <StepBody
            {...props}
            step={shown}
            projectId={projectId}
            roots={roots}
            progress={progress}
            busy={busy}
            setBusy={setBusy}
            notice={notice}
            setNotice={setNotice}
            onComplete={complete}
          />
        </div>
        <footer className={css.actions}>
          {previous === undefined
            ? <span />
            : (
              <Button variant="ghost" disabled={busy} onClick={() => { back(previous) }}>
                {t('wizard.back')}
              </Button>
            )}
          <span className={css.actionsEnd}>
            {shown === 'ready'
              ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    complete({})
                    // The walk's last act, and the reason it is five steps rather than a form:
                    // the gate it replaces governs a *blank home*, so nothing the walk recorded
                    // has been usable workspace yet. Opening the project is what turns the
                    // completed walk into a project the operator is actually in.
                    //
                    // Only a project this walk created. One that resolved from the catalogues was
                    // already established — it has a Session path of its own and the workspace
                    // surfaces are where the operator reaches it — so navigating there would be a
                    // move they did not ask for.
                    //
                    // And there is always one by now: this step is only reachable through a record,
                    // and a record is only ever written against a project id.
                    /* v8 ignore next -- unreachable: a record exists only under a project id, so
                     * reaching the summary implies one was resolved. */
                    if (projectId !== undefined) props.finishOnboarding(projectId)
                  }}
                >
                  {t('wizard.finish')}
                </Button>
              )
              : review
                ? (
                  <Button variant="ghost" disabled={busy} onClick={() => { setRevisit(undefined); setNotice(undefined) }}>
                    {t('wizard.next')}
                  </Button>
                )
                : null}
          </span>
        </footer>
        {notice !== undefined ? <p className={css.unavailable}>{notice}</p> : null}
      </section>
    </div>
  )
}

/**
 * The build servers the blank home's project declared, with what their last test concluded.
 *
 * The strip exists because the blank home is where a build is about to be asked for: the operator
 * types "build the IVI image" here, and whether the machine that would compile it is reachable is a
 * fact they need before typing rather than after failing. It renders nothing at all for a project
 * that declared no server, so a deployment that builds locally never grows a heading it cannot fill.
 *
 * The state is the host's: every test writes its outcome onto the declaration, and the strip re-reads
 * the list afterwards, so the line describes the last attempt rather than the last success.
 */
function BuildServerStrip({ projectId, loadServers, probeServer, t }: {
  projectId: WorkspaceId | undefined
  loadServers: OnboardingWizardInjected['loadServers']
  probeServer: OnboardingWizardInjected['probeServer']
  t: OnboardingWizardProps['t']
}): ReactNode {
  const [servers, setServers] = useState<readonly YxspecRemoteServerView[]>([])
  const [probing, setProbing] = useState<string | undefined>(undefined)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (projectId === undefined) {
      setServers([])
      return
    }
    let live = true
    void loadServers(projectId).then(
      (value) => { if (live) setServers(value) },
      // An absent build-server namespace is not a failure here: the strip shows nothing.
      () => { if (live) setServers([]) },
    )
    return () => { live = false }
  }, [loadServers, projectId, reload])

  if (servers.length === 0) return null
  return (
    <div className={css.buildServers}>
      {servers.map(server => (
        <span key={server.serverId} className={css.buildServer}>
          <span className={css.buildServerName}>
            {t('section.servers')}
            {' · '}
            {server.title || server.serverId}
          </span>
          <ServerStateDot server={server} t={t} className={css.buildServerState} />
          <Button
            variant="ghost"
            disabled={probing !== undefined}
            onClick={() => {
              /* v8 ignore next -- the strip renders only for a resolved project, so this guard is
               * a second line of defence rather than a live path. */
              if (projectId === undefined) return
              setProbing(server.serverId)
              void probeServer(projectId, server.serverId).then(
                () => { setProbing(undefined); setReload(count => count + 1) },
                // A refused call leaves the stored state as it was; this strip owns no notice surface.
                () => { setProbing(undefined) },
              )
            }}
          >
            {t('server.probe')}
          </Button>
        </span>
      ))}
    </div>
  )
}

/**
 * One trail chip per step, so the operator can see how far the wizard reaches.
 *
 * A chip reads "done" only when the step is completed *and* its own inputs are still supplied:
 * `stepSatisfied` is the same predicate that guards each step's Continue, so a chip can never
 * claim done over a step whose answer was cleared, and the trail cannot disagree with the body.
 */
function Trail({ progress, current, t }: {
  progress: OnboardingProgress
  current: OnboardingStep
  t: OnboardingWizardProps['t']
}): ReactNode {
  return (
    <ol className={css.trail}>
      {ONBOARDING_STEPS.map((step, index) => {
        const done = progress.completed.includes(step) && stepSatisfied(step, progress)
        return (
          <li
            key={step}
            className={css.trailStep}
            data-state={done ? 'done' : step === current ? 'current' : 'todo'}
          >
            <span className={css.trailIndex}>
              {done ? <IconCheckOutlineRegular size={10} /> : index + 1}
            </span>
            {t(`wizard.trail.${step}`)}
          </li>
        )
      })}
    </ol>
  )
}

/** Props every step body receives: the wizard's face plus its own commit callback. */
type StepProps = OnboardingWizardProps & {
  readonly step: OnboardingStep
  /** The project the gate resolved, or undefined while none is known. */
  readonly projectId: WorkspaceId | undefined
  /**
   * The resolved project's own declared roots, primary first; empty while none is known.
   *
   * Read from the host catalogue rather than kept as a draft: step 2's list *is* the project's
   * state, so the component displays what the host last answered and every edit is a command.
   * A local draft would drift the moment the same project is edited from another surface.
   */
  readonly roots: readonly string[]
  readonly progress: OnboardingProgress
  readonly busy: boolean
  readonly setBusy: (busy: boolean) => void
  readonly notice: string | undefined
  readonly setNotice: (notice: string | undefined) => void
  readonly onComplete: (answers: OnboardingAnswers) => void
}

/** Dispatch the current step's body. */
function StepBody(props: StepProps): ReactNode {
  switch (props.step) {
    case 'project': return <ProjectStep {...props} />
    case 'repositories': return <RepositoriesStep {...props} />
    case 'specification': return <SpecificationStep {...props} />
    case 'server': return <ServerStep {...props} />
    case 'ready': return <ReadyStep {...props} />
  }
}

/**
 * Step 1: name the project; the title is what sessions and artifacts are accounted to.
 *
 * This is the step that creates the project. It sends a title and no directory, which the host
 * accepts as a project whose repositories are not declared yet — a real state, not a partial
 * one: a session cannot be attached to it until a root exists, and step 2 is where that
 * happens. Naming first is what lets the operator decide what the work *is* before deciding
 * where the code lives, and it is what makes step 2 an "add" rather than a second create.
 *
 * The commit is asynchronous and owns its own busy/notice bookkeeping, because the create is a
 * Remote call. Nothing is recorded locally until the host answers: a step saved before the
 * project exists would be a record keyed by an id that never arrives.
 */
function ProjectStep({ progress, projectId, busy, setBusy, setNotice, nameProject, t }: StepProps): ReactNode {
  const [title, setTitle] = useState(progress.answers.projectTitle ?? '')
  const trimmed = title.trim()
  const submit = async (): Promise<void> => {
    if (trimmed.length === 0) return
    setBusy(true)
    setNotice(undefined)
    try {
      await nameProject(projectId, trimmed)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <StepHead title={t('wizard.step.project.title')} hint={t('wizard.step.project.hint')} />
      <label className={css.field}>
        <span className={css.label}>{t('wizard.step.project.field')}</span>
        <input
          className={css.text}
          value={title}
          autoFocus
          onChange={(event) => { setTitle(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
        />
      </label>
      <div className={css.actionsEnd}>
        <Button variant="primary" disabled={busy || trimmed.length === 0} onClick={() => { void submit() }}>
          {t('wizard.next')}
        </Button>
      </div>
    </>
  )
}

/**
 * Step 2: the repositories the project spans; the first is the session working directory.
 *
 * The list is the project's own `roots`, not a local draft. Step 1 already created the
 * project, so every choice here is a durable edit to it: adding calls `addRoot`, dropping
 * calls `removeRoot`, and the rendered list is what the host answered. A local draft would
 * have to be reconciled with the host on every revisit — and the one case that reconciliation
 * gets wrong is the one that matters, because a project's roots can also be edited from the
 * project surfaces outside this wizard.
 *
 * Appending is what makes the first directory primary: a root added to a rootless project
 * lands at index 0, and `addRoot` never promotes, so the working directory cannot shift under
 * the operator by adding a second repository.
 */
function RepositoriesStep({
  roots, projectId, busy, setBusy, setNotice, onComplete, pickDirectory, addRepositoryRoot,
  removeRepositoryRoot, t,
}: StepProps): ReactNode {
  const add = async (): Promise<void> => {
    /* v8 ignore next -- step 2 is only reachable through step 1, which always leaves a
     * project; the guard is a second line of defence so a call that somehow arrived cannot
     * append a root to nothing. */
    if (projectId === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      const picked = await pickDirectory()
      // A cancelled pick is not a failure and not a choice: it leaves the list exactly as it
      // was, without a host round trip.
      if (picked !== undefined && !roots.includes(picked)) await addRepositoryRoot(projectId, picked)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const drop = async (path: string): Promise<void> => {
    /* v8 ignore next -- same guard as `add`: the control only exists on a resolved project. */
    if (projectId === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      await removeRepositoryRoot(projectId, path)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  const commit = (): void => {
    // The Continue is disabled once every directory is dropped, and the guard repeats that
    // decision rather than trusting the control: a submit that somehow arrived would record a
    // step whose answer is empty, and step 3 would then have nothing to enumerate against.
    /* v8 ignore next -- unreachable through the UI: the control this is reached from is
     * disabled on an empty list, and a disabled button dispatches no click. The guard is what
     * makes "disabled" and "refused" the same answer instead of two that could disagree. */
    if (roots.length === 0) return
    onComplete({ repositories: roots })
  }
  return (
    <>
      <StepHead title={t('wizard.step.repositories.title')} hint={t('wizard.step.repositories.hint')} />
      {roots.length === 0
        ? <p className={css.empty}>{t('wizard.step.repositories.empty')}</p>
        : (
          <ul className={css.list}>
            {roots.map((root, index) => (
              <li key={root} className={css.row}>
                <IconFolderOpenRegular className={css.rowIcon} size={14} />
                <span className={css.rowTitle} title={root}>{root}</span>
                {index === 0 ? <span className={css.rowMeta}>{t('wizard.step.repositories.primary')}</span> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => { void drop(root) }}
                >
                  {t('wizard.step.repositories.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      <span className={css.hint}>{t('wizard.step.repositories.added', { count: roots.length })}</span>
      <div className={css.actionsEnd}>
        <Button
          variant="outline"
          icon={<IconPlusOutlineRegular size={14} />}
          disabled={busy}
          onClick={() => { void add() }}
        >
          {t('wizard.step.repositories.add')}
        </Button>
        <Button variant="primary" disabled={busy || roots.length === 0} onClick={commit}>
          {t('wizard.next')}
        </Button>
      </div>
    </>
  )
}

/**
 * Step 3: the ASPICE specification this run follows, chosen from the project's own files.
 *
 * The candidates are only half the answer. An empty list reads the same whether the project
 * has no inputs imported yet or the repositories chosen in step 2 point somewhere else
 * entirely, and this step is where the operator can still fix the second case — the folder
 * picker is one step back. So the directories the host actually enumerated are always on
 * screen, empty list or not: they are what turns "nothing found" from a dead end into a
 * diagnosis. A path the operator recognizes as wrong tells them to go back; the convention
 * paths they do not recognize tell them what this deployment expects instead.
 *
 * Not every specification tree is inside the project, and one may not exist yet, which the diagnosis above cannot help
 * with: a shared document folder or a delivered package sits beside the repositories, and no
 * amount of reading the search report will make the host find it. So the step also lets the
 * operator point at one directly, and the widening is a *retry* rather than a separate
 * feature — the same read runs again with the added directory, and the list it returns is the
 * whole answer for the whole search. The additions are recorded on the project's progress
 * record, so a reload or a return to this step keeps them, and they reach the host as an
 * argument on every listing call rather than as host-side state.
 */
function SpecificationStep({
  projectId, progress, busy, setBusy, setNotice, onComplete, saveProgress,
  loadDocuments, pickDirectory, t,
}: StepProps): ReactNode {
  const [listing, setListing] = useState<YxspecDocumentListing | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  // The additions the operator has made so far, mirrored from the recorded answers so a return
  // to this step reopens with the search it last ran rather than the project's bare layout. A
  // local copy rather than a read-through of the prop: a picker answer has to take effect
  // immediately, while the prop only advances on the next render.
  const [added, setAdded] = useState<readonly string[]>(progress.answers.searchPaths ?? [])

  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    // A fresh array identity per change is what re-runs this: an addition rewrites the list, so
    // the read is repeated with it. An earlier read that lands late is dropped rather than
    // allowed to overwrite the answer for the search the operator is actually looking at.
    void loadDocuments(projectId, added).then(
      (value) => { if (live) setListing(value) },
      () => { if (live) setFailed(true) },
    )
    return () => { live = false }
  }, [added, loadDocuments, projectId])

  /**
   * Record the additions on the project's own progress, without touching which steps are done.
   *
   * Written as they are made rather than with the eventual document choice, because the list is
   * an edit to the search rather than an answer to the step: an operator who adds a directory
   * and reloads before picking a document would otherwise lose the very path they had just
   * found, and the search they rebuilt it from is the expensive part.
   */
  const record = (next: readonly string[]): void => {
    setAdded(next)
    setListing(undefined)
    saveProgress(projectId, { completed: progress.completed, answers: { ...progress.answers, searchPaths: next } })
  }

  const addDirectory = async (): Promise<void> => {
    /* v8 ignore next -- step 3 is only reachable through step 2, which is only reachable
     * through step 1, and step 1 always leaves a project; the guard is a second line of
     * defence so a call that somehow arrived cannot widen a search for nothing. */
    if (projectId === undefined) return
    setBusy(true)
    setNotice(undefined)
    try {
      const picked = await pickDirectory()
      // A cancelled pick is not a failure and not a choice: the search stays exactly as it was,
      // with no read repeated. A directory already on the list is not an edit either, and
      // re-adding it would only add a duplicate row.
      if (picked === undefined || added.includes(picked)) return
      record([...added, picked])
    } catch (error) {
      // A refused picker leaves the list as it was; the notice is the operator's only signal
      // that the click did nothing.
      setNotice(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const documents = listing?.documents ?? []
  const searched = listing?.searched ?? []
  return (
    <>
      <StepHead title={t('wizard.step.specification.title')} hint={t('wizard.step.specification.hint')} />
      {projectId === undefined || failed
        ? <p className={css.unavailable}>{t('wizard.unavailable')}</p>
        : listing === undefined
          ? <p className={css.hint}>{t('wizard.step.specification.loading')}</p>
          : (
            <>
              {documents.length === 0
                ? <p className={css.empty}>{t('wizard.step.specification.empty')}</p>
                : (
                  <ul className={css.list}>
                    {documents.map(document => (
                      <li key={`${document.rootIndex}:${document.path}`}>
                        <button
                          type="button"
                          className={css.row}
                          aria-pressed={isChosen(document, progress)}
                          onClick={() => {
                            // The additions are already recorded; this commit is the document
                            // choice alone, so re-stating them here would be a second write of a
                            // value the record already holds.
                            onComplete({
                              specificationPath: document.path,
                              specificationRootIndex: document.rootIndex,
                              // Choosing and deferring answer the same question, so taking a
                              // document withdraws a deferral this record may already carry.
                              specificationDeferred: false,
                            })
                          }}
                        >
                          <span className={css.rowTitle} title={document.path}>{document.path}</span>
                          {document.partition === undefined
                            ? null
                            : <span className={css.rowMeta}>{document.partition}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              {listing.truncated
                ? <p className={css.hint}>{t('wizard.step.specification.truncated', { count: documents.length })}</p>
                : null}
              {/* The additions are listed above the search report because they are the part the
               * operator controls: the report tells them where the host looked, and this tells
               * them where they sent it. */}
              <ExtraPaths
                added={added}
                busy={busy}
                onAdd={addDirectory}
                onDrop={(path) => { setNotice(undefined); record(added.filter(entry => entry !== path)) }}
                t={t}
              />
              {/* Open by default exactly when the list is empty: that is the case where the
               * search report is the explanation rather than a footnote. */}
              <SearchedPaths searched={searched} initialOpen={documents.length === 0} t={t} />
              <div className={css.extra}>
                <p className={css.hint}>{t('wizard.step.specification.deferHint')}</p>
                <div className={css.actionsEnd}>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      onComplete({
                        specificationDeferred: true,
                        // The other direction of the same exclusivity: a deferral withdraws a document
                        // chosen earlier, so the record never claims both. Blank rather than absent,
                        // because the record merges answers and an absent key would leave the old
                        // choice standing; a blank path already reads as "none chosen".
                        specificationPath: '',
                      })
                    }}
                  >
                    {t('wizard.step.specification.defer')}
                  </Button>
                </div>
              </div>
            </>
          )}
    </>
  )
}

/**
 * The directories the operator added to this step's search, and the control to widen it again.
 *
 * Shown even when empty, unlike {@link SearchedPaths}: this is the step's only way out of an
 * empty candidate list caused by a specification that lives outside the project, so it has to
 * be discoverable in exactly the state that needs it.
 * @param props - the added absolute paths, the busy seat, the add/drop handlers, and the copy.
 * @returns the list and its add control.
 */
function ExtraPaths({ added, busy, onAdd, onDrop, t }: {
  added: readonly string[]
  busy: boolean
  onAdd: () => Promise<void>
  onDrop: (path: string) => void
  t: OnboardingWizardProps['t']
}): ReactNode {
  return (
    <div className={css.extra}>
      <span className={css.hint}>{t('wizard.step.specification.extraHint')}</span>
      {added.length === 0
        ? null
        : (
          <ul className={css.list}>
            {added.map(path => (
              <li key={path} className={css.row}>
                <IconFolderOpenRegular className={css.rowIcon} size={14} />
                <span className={css.rowTitle} title={path}>{path}</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { onDrop(path) }}>
                  {t('wizard.step.repositories.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      <div className={css.actionsEnd}>
        <Button
          variant="outline"
          icon={<IconPlusOutlineRegular size={14} />}
          disabled={busy}
          onClick={() => { void onAdd() }}
        >
          {t('wizard.step.specification.extraAdd')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The directories the host enumerated for the candidates above.
 *
 * Collapsed by default: with a populated list this is reference material an operator consults
 * only when the document they want is missing, and the one line it costs is enough to tell
 * them it is there. It is not the step's headline in either case — the candidates (or their
 * absence) are.
 * @param props - the enumerated paths, the copy seat, and whether to open the disclosure.
 * @returns the disclosure, or nothing when the host reported looking nowhere.
 */
function SearchedPaths({ searched, initialOpen, t }: {
  searched: readonly string[]
  initialOpen: boolean
  t: OnboardingWizardProps['t']
}): ReactNode {
  const [open, setOpen] = useState(initialOpen)
  // Nothing searched is a real answer — an unknown project resolves to no roots — and an empty
  // disclosure would be noise rather than a clue.
  if (searched.length === 0) return null
  return (
    <div className={css.searched}>
      <button type="button" className={css.searchedToggle} onClick={() => { setOpen(value => !value) }}>
        {t('wizard.step.specification.searched', { count: searched.length })}
      </button>
      {open
        ? (
          <ul className={css.searchedList}>
            {searched.map(path => <li key={path} title={path}>{path}</li>)}
          </ul>
        )
        : null}
    </div>
  )
}

/**
 * Whether one candidate is the operator's recorded choice. Both the path and the root have to
 * match: the same relative path can exist in two repositories of one project.
 * @param document - the candidate row.
 * @param progress - the project's recorded answers.
 * @returns whether this row is the recorded choice.
 */
function isChosen(document: YxspecDocumentView, progress: OnboardingProgress): boolean {
  return progress.answers.specificationPath === document.path
    && progress.answers.specificationRootIndex === document.rootIndex
}

/**
 * Step 4: the build server the project compiles on, declared here or not at all.
 *
 * Declaring used to be the Conversation's job, which made this step a status page with a
 * forward button: an operator who reached it with no server had to leave the walk, ask an
 * agent for a declaration, and come back. The step therefore carries the declaration itself,
 * over the same host operation `remote_server_declare` calls.
 *
 * The form asks for every field the record holds, including the recipe list, because the
 * recipes are the allowlist a run may choose from — a declaration without one could never
 * have a run requested against it, so the host refuses it too.
 *
 * Forward is one control, not two. "Declare nothing and continue" is the same act whether or
 * not the project already declares a server, and two buttons that both just advance invite
 * the operator to look for a difference that is not there; the label follows the state
 * instead, so the button says what it will do.
 */
function ServerStep({
  projectId, busy, setBusy, setNotice, onComplete, loadServers, declareServer, probeServer, browseServer, t,
}: StepProps): ReactNode {
  const [servers, setServers] = useState<readonly YxspecRemoteServerView[] | undefined>(undefined)
  const [draft, setDraft] = useState<ServerDraft | undefined>(undefined)
  const [declaring, setDeclaring] = useState(false)
  /** The declaration currently being tested, so its own row can say so and refuse a second click. */
  const [probing, setProbing] = useState<string | undefined>(undefined)
  // Bumped after each declaration, which re-runs the read below: the list is the host's answer,
  // so a declaration shows up by being read back rather than by being appended, and a
  // re-declaration under an existing id replaces its row instead of appearing twice.
  const [declared, setDeclared] = useState(0)

  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    void loadServers(projectId).then(
      (value) => { if (live) setServers(value) },
      // An absent remote plugin is not a failure: the step's answer is still "none declared".
      () => { if (live) setServers([]) },
    )
    return () => { live = false }
  }, [declared, loadServers, projectId])

  const submit = async (): Promise<void> => {
    /* v8 ignore next -- the control is disabled while no project is resolved, so this guard is
     * a second line of defence rather than a live path. */
    if (projectId === undefined || draft === undefined) return
    setBusy(true)
    setDeclaring(true)
    setNotice(undefined)
    try {
      const stored = await declareServer(projectId, toDraft(draft))
      setDraft(undefined)
      setNotice(t('wizard.step.server.saved', { id: stored.serverId }))
      setDeclared(count => count + 1)
      // Tested without blocking the form: the declaration is already durable, and the row reports
      // the outcome when it lands — which is exactly what "added, does it connect?" asks for.
      void test(stored.serverId)
    } catch (error) {
      // The host refuses a declaration with a message naming the field at fault, and the form
      // stays open over it so the operator can correct that field rather than retype the rest.
      setNotice(messageOf(error))
    } finally {
      setDeclaring(false)
      setBusy(false)
    }
  }

  /**
   * Test one declaration and fold the answer back into the list.
   *
   * A host that refuses the call is reported as the step's notice; a host that answers "no" is not a
   * refusal at all — the probe stores that outcome on the declaration, so re-reading the list is what
   * puts it on the row.
   * @param serverId - the declaration to test.
   */
  const test = async (serverId: string): Promise<void> => {
    /* v8 ignore next -- the control is disabled while no project is resolved, so this guard is a
     * second line of defence rather than a live path. */
    if (projectId === undefined) return
    setProbing(serverId)
    setNotice(undefined)
    try {
      await probeServer(projectId, serverId)
    } catch (error) {
      setNotice(messageOf(error))
    } finally {
      setProbing(undefined)
      setDeclared(count => count + 1)
    }
  }

  return (
    <>
      <StepHead title={t('wizard.step.server.title')} hint={t('wizard.step.server.hint')} />
      {servers === undefined
        ? <p className={css.hint}>{t('wizard.step.server.loading')}</p>
        : servers.length === 0
          ? <p className={css.empty}>{t('wizard.step.server.empty')}</p>
          : (
            <ul className={css.list}>
              {servers.map(server => (
                <li key={server.serverId} className={css.row}>
                  <span className={css.rowTitle} title={server.destination}>{server.title || server.serverId}</span>
                  <span className={css.rowMeta}>{server.destination}</span>
                  {/* The state is what the host last recorded, so it survives a reload and a
                   * re-render; its timestamp rides on the dot's tooltip rather than taking a line. */}
                  <ServerStateDot server={server} t={t} className={css.rowMeta} />
                  <Button
                    variant="ghost"
                    disabled={busy || probing !== undefined}
                    onClick={() => { void test(server.serverId) }}
                  >
                    {t('server.probe')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
      {draft === undefined
        ? (
          <div className={css.extra}>
            <p className={css.hint}>{t('wizard.step.server.declare')}</p>
            <div className={css.actionsEnd}>
              <Button
                variant="outline"
                disabled={busy || servers === undefined}
                onClick={() => { setNotice(undefined); setDraft(emptyServerDraft()) }}
              >
                {t('wizard.step.server.add')}
              </Button>
            </div>
          </div>
        )
        : (
          <ServerForm
            draft={draft}
            declaring={declaring}
            onChange={setDraft}
            onCancel={() => { setNotice(undefined); setDraft(undefined) }}
            onSubmit={() => { void submit() }}
            browseServer={browseServer}
            t={t}
          />
        )}
      <div className={css.actionsEnd}>
        <Button
          variant="primary"
          disabled={busy || servers === undefined}
          onClick={() => { onComplete({ serverResolved: true }) }}
        >
          {servers !== undefined && servers.length > 0 ? t('wizard.next') : t('wizard.skip')}
        </Button>
      </div>
    </>
  )
}

/** The form's own state: every field as typed, before the host resolves its defaults. */
interface ServerDraft {
  readonly serverId: string
  /** The login the operator connects as; half of the destination. */
  readonly username: string
  /** The machine to reach, as an address or a resolvable name; the other half. */
  readonly host: string
  readonly projectDirectory: string
  readonly captureRevision: boolean
  /**
   * One row per recipe. The output directory sits on the row rather than on the form because it
   * belongs to the compile being described: a whole build and a module build of one tree write
   * their products to different places.
   */
  readonly recipes: readonly {
    readonly id: string
    readonly command: string
    readonly outputDirectory: string
  }[]
  readonly timeoutMs: string
  readonly sshExecutable: string
}

/**
 * The OpenSSH destination the two fields add up to.
 *
 * Composed here rather than typed by the operator: it is one string with a syntax, and the only
 * thing they know is who they are and which machine they mean. An empty half yields no
 * destination at all rather than a malformed one, so the form is incomplete instead of wrong.
 * @param draft - the form's state.
 * @returns `user@host`, or `''` while either half is missing.
 */
function destinationOf(draft: ServerDraft): string {
  const username = draft.username.trim()
  const host = draft.host.trim()
  return username.length === 0 || host.length === 0 ? '' : `${username}@${host}`
}

/**
 * A blank form with one recipe row.
 *
 * One empty recipe rather than none: the host refuses a declaration without a recipe, so a
 * form that opened with an empty list would present a submit the operator could not satisfy
 * without first discovering the add control.
 * @returns the initial draft.
 */
function emptyServerDraft(): ServerDraft {
  return {
    serverId: '', username: '', host: '', projectDirectory: '',
    captureRevision: false, recipes: [{ id: '', command: '', outputDirectory: '' }],
    timeoutMs: '', sshExecutable: '',
  }
}

/**
 * Resolve the typed form into the declaration the host stores.
 *
 * Blank optional fields are dropped rather than sent as empty strings: the host defaults a
 * missing timeout, label, and output directory, while an empty string would travel as a value —
 * an `sshExecutable` of `''` is a path no run can execute, and an `outputDirectory` of `''` is
 * not the default but a directory named nothing.
 * @param draft - the form's state.
 * @returns the declaration to submit.
 */
function toDraft(draft: ServerDraft): YxspecRemoteServerDraft {
  const timeoutMs = Number.parseInt(draft.timeoutMs.trim(), 10)
  const sshExecutable = draft.sshExecutable.trim()
  return {
    serverId: draft.serverId.trim(),
    // The two halves the operator typed, joined here rather than by them: an OpenSSH destination
    // is one string, and asking a person to assemble it is asking them to get a syntax right for
    // a tool they are not running.
    destination: destinationOf(draft),
    projectDirectory: draft.projectDirectory.trim(),
    recipes: draft.recipes.map((recipe) => {
      const outputDirectory = recipe.outputDirectory.trim()
      return {
        id: recipe.id.trim(),
        command: recipe.command.trim(),
        ...outputDirectory.length === 0 ? {} : { outputDirectory },
      }
    }),
    ...draft.captureRevision ? { captureRevision: true } : {},
    ...Number.isFinite(timeoutMs) ? { timeoutMs } : {},
    ...sshExecutable.length === 0 ? {} : { sshExecutable },
  }
}

/**
 * Whether every field the host requires has been filled.
 *
 * The submit is disabled rather than refused, so this predicate and the host's own validation
 * agree on what "complete" means: a blank id, destination, project directory, or recipe row is
 * something the operator can see and fix here, while the rest — an absolute server path, a
 * positive timeout — is the host's to report, because the rule is the service's.
 * @param draft - the form's state.
 * @returns whether the form may be submitted.
 */
function draftComplete(draft: ServerDraft): boolean {
  return draft.serverId.trim().length > 0
    && draft.username.trim().length > 0
    && draft.host.trim().length > 0
    && draft.projectDirectory.trim().length > 0
    && draft.recipes.length > 0
    && draft.recipes.every(recipe => recipe.id.trim().length > 0 && recipe.command.trim().length > 0)
}

/**
 * The compile directory, chosen on the machine that holds it.
 *
 * Typing a server-side path from a developer machine is the step this replaces: the share a person
 * browses their tree through and the path that machine sees are different strings, and the operator
 * has no way to tell which one a declaration wants. Connecting first settles both questions at once —
 * the destination is proven to reach a shell, and everything below it is something the operator
 * recognizes rather than remembers.
 *
 * The listing is the host's: the first connect lands in the login directory, because that is where a
 * shell starts and where a tree usually lives, and every step after it is a fresh read of one
 * directory rather than a cached tree.
 */
function ServerDirectoryPicker({ draft, onChange, browseServer, t }: {
  draft: ServerDraft
  onChange: (draft: ServerDraft) => void
  browseServer: OnboardingWizardInjected['browseServer']
  t: OnboardingWizardProps['t']
}): ReactNode {
  const [held, setHeld] = useState<Readonly<Record<string, HeldDirectory>>>({})
  const [here, setHere] = useState<HeldHere | undefined>(undefined)
  /**
   * Whether the listing shows. It opens on a read and closes when a directory is taken, so
   * choosing ends the interaction the operator started instead of leaving a panel behind over a
   * decision they have already made.
   */
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const destination = destinationOf(draft)
  const sshExecutable = draft.sshExecutable.trim()

  /**
   * Read one directory, or the login directory when none is named, and keep what it covered.
   *
   * One call carries several levels, so the entries are merged into what the picker already holds
   * rather than replacing it as a single listing: navigating inside a level a call already answered
   * for costs nothing, which is the difference between a click and a connection.
   * @param directory - absolute directory to read; omitted reads the login directory.
   */
  const go = async (directory?: string): Promise<void> => {
    if (destination.length === 0) return
    setBusy(true)
    setFailure(undefined)
    try {
      const listing = await browseServer({
        destination,
        ...directory === undefined ? {} : { directory },
        ...sshExecutable.length === 0 ? {} : { sshExecutable },
      })
      setHeld(previous => mergeListing(previous, listing))
      setOpen(true)
      setHere({
        directory: listing.directory,
        ...listing.parent === undefined ? {} : { parent: listing.parent },
        truncated: listing.truncated,
        entryCount: listing.entries.filter(entry => !entry.includes('/')).length,
        ...listing.error === undefined ? {} : { error: listing.error },
      })
    } catch (error) {
      // A refused call is the host's own words about why, and the picker has no listing to show.
      setFailure(messageOf(error))
      setHere(undefined)
      setHeld({})
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Move into one child, reading it only when nothing held already covers it.
   * @param name - the child directory's name.
   */
  const enter = (name: string): void => {
    /* v8 ignore next -- the rows render only inside a listing, which needs a current directory. */
    if (here === undefined) return
    const next = joinRemote(here.directory, name)
    const cover = held[next]
    if (cover !== undefined) {
      const { children, truncated } = cover
      setHere({ directory: next, parent: here.directory, truncated, entryCount: children.length } satisfies HeldHere)
      return
    }
    void go(next)
  }

  const children = here === undefined ? [] : held[here.directory]?.children ?? []
  return (
    <div className={css.field}>
      <span className={css.label}>{t('wizard.step.server.field.projectDirectory')}</span>
      <div className={css.browseRow}>
        <span className={css.browsePath}>
          {draft.projectDirectory.length > 0
            ? draft.projectDirectory
            : t('wizard.step.server.directory.none')}
        </span>
        <Button
          variant="outline"
          disabled={busy || destination.length === 0}
          onClick={() => { void go(here?.directory) }}
        >
          {busy
            ? t('wizard.step.server.connecting')
            : open
              ? t('wizard.step.server.browse.refresh')
              : draft.projectDirectory.length > 0
                ? t('wizard.step.server.browse.change')
                : t('wizard.step.server.connect')}
        </Button>
      </div>
      {failure === undefined ? null : <p className={css.unavailable}>{failure}</p>}
      {!open || here === undefined ? null : (
        <div className={css.browse}>
          <span className={css.browseCurrent}>
            {t('wizard.step.server.browse.current', { path: here.directory })}
          </span>
          {here.error === undefined ? null : <p className={css.unavailable}>{here.error}</p>}
          <div className={css.browseList}>
            {here.parent === undefined ? null : (
              <button
                type="button"
                className={css.browseEntry}
                onClick={() => {
                  // The parent is read like any other directory: what a call covered is held, and
                  // going up may leave the covered part exactly as going down may.
                  const parent = here.parent as string
                  if (held[parent] === undefined) { void go(parent); return }
                  const above = parentOf(parent)
                  setHere({
                    directory: parent,
                    ...above === undefined ? {} : { parent: above },
                    truncated: held[parent].truncated,
                    entryCount: held[parent].children.length,
                  })
                }}
              >
                {t('wizard.step.server.browse.up')}
              </button>
            )}
            {children.map(name => (
              <button key={name} type="button" className={css.browseEntry} onClick={() => { enter(name) }}>
                {name}
              </button>
            ))}
          </div>
          {here.error !== undefined || children.length > 0 ? null : <p className={css.hint}>{t('wizard.step.server.browse.empty')}</p>}
          {here.truncated
            ? <p className={css.hint}>{t('wizard.step.server.browse.truncated', { count: here.entryCount })}</p>
            : null}
          <div className={css.actionsEnd}>
            <Button
              variant="primary"
              disabled={busy || here.error !== undefined}
              onClick={() => {
                onChange({ ...draft, projectDirectory: here.directory })
                // Closed rather than left standing: the listing was opened to answer this one
                // question, and the chosen path above it is the answer.
                setOpen(false)
              }}
            >
              {t('wizard.step.server.browse.choose')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** One directory the picker holds: what a call answered for, and whether it was cut short. */
interface HeldDirectory {
  /** Names directly below it, ready to render. */
  readonly children: readonly string[]
  /** Whether the call that produced it stopped at the entry ceiling. */
  readonly truncated: boolean
}

/** Where the picker currently is, and what its own call did or did not produce. */
interface HeldHere {
  readonly directory: string
  readonly parent?: string
  readonly truncated: boolean
  /** Direct children the listing held, which is the count a truncation notice reports. */
  readonly entryCount: number
  readonly error?: string
}

/**
 * Fold one listing into what the picker holds.
 *
 * Each entry is a path below the listed directory, so every segment boundary between the two is
 * a directory whose children this call also answered for. That is what makes descending free
 * inside the covered part, and it is why the fold is by parent rather than by the listed root.
 * @param held - what the picker already holds, keyed by absolute directory.
 * @param listing - the call's answer.
 * @returns the merged map.
 */
function mergeListing(
  held: Readonly<Record<string, HeldDirectory>>,
  listing: YxspecRemoteBrowse,
): Readonly<Record<string, HeldDirectory>> {
  const next: Record<string, string[]> = {}
  const cut: Record<string, boolean> = {}
  for (const entry of listing.entries) {
    const segments = entry.split('/')
    for (let at = 0; at < segments.length; at += 1) {
      // `joinRemote` rather than a plain join: the listed directory may be the root, and `'/'` and a
      // segment joined by hand would make `//srv`, a key no lookup ever asks for.
      const parent = at === 0
        ? listing.directory
        : joinRemote(listing.directory, segments.slice(0, at).join('/'))
      const name = segments[at] as string
      const children = next[parent] ?? []
      if (!children.includes(name)) children.push(name)
      next[parent] = children
      // The listed directory is the only one whose children the ceiling could have cut: the walk
      // reports what it reached, and everything it reached inside is complete.
      if (at === 0) cut[parent] = listing.truncated
    }
  }
  const merged: Record<string, HeldDirectory> = { ...held }
  for (const [directory, children] of Object.entries(next)) {
    merged[directory] = { children, truncated: cut[directory] ?? false }
  }
  // A directory the call reached but found empty still belongs in the map, or the picker would
  // ask for it again on the next click.
  merged[listing.directory] = {
    children: merged[listing.directory]?.children ?? [],
    truncated: listing.truncated,
  }
  return merged
}

/**
 * The absolute parent of one path, or undefined at the root.
 * @param directory - an absolute POSIX directory.
 * @returns the parent path, or undefined when there is nowhere to go up.
 */
function parentOf(directory: string): string | undefined {
  if (directory === '/') return undefined
  const cut = directory.lastIndexOf('/')
  return cut <= 0 ? '/' : directory.slice(0, cut)
}
/**
 * One path below another, POSIX-separated.
 *
 * The separator is written here rather than taken from `node:path`: these names came from a POSIX
 * shell on the other side of an SSH connection, and the client's own platform says nothing about
 * what that machine uses.
 * @param directory - the absolute directory already listed.
 * @param name - the child entry's name.
 * @returns the child's absolute path.
 */
function joinRemote(directory: string, name: string): string {
  return directory === '/' ? `/${name}` : `${directory}/${name}`
}

/** The declaration form: one labelled field per record field, and one row per recipe. */
function ServerForm({ draft, declaring, onChange, onCancel, onSubmit, browseServer, t }: {
  draft: ServerDraft
  declaring: boolean
  onChange: (draft: ServerDraft) => void
  onCancel: () => void
  onSubmit: () => void
  browseServer: OnboardingWizardInjected['browseServer']
  t: OnboardingWizardProps['t']
}): ReactNode {
  const field = (
    label: string,
    value: string,
    update: (value: string) => void,
    placeholder?: string,
  ): ReactNode => (
    <label className={css.field}>
      <span className={css.label}>{label}</span>
      <input
        className={css.text}
        value={value}
        {...placeholder === undefined ? {} : { placeholder }}
        onChange={(event) => { update(event.target.value) }}
      />
    </label>
  )
  const recipe = (
    entry: { readonly id: string; readonly command: string; readonly outputDirectory: string },
    index: number,
  ): ReactNode => {
    const edit = (patch: Partial<typeof entry>): void => {
      onChange({ ...draft, recipes: draft.recipes.map((row, at) => at === index ? { ...row, ...patch } : row) })
    }
    return (
      <div key={index} className={css.recipe}>
        <input
          className={css.text}
          value={entry.id}
          placeholder={t('wizard.step.server.recipe.id')}
          onChange={(event) => { edit({ id: event.target.value }) }}
        />
        <input
          className={css.text}
          value={entry.command}
          placeholder={t('wizard.step.server.recipe.command')}
          onChange={(event) => { edit({ command: event.target.value }) }}
        />
        {/* The output directory is per recipe, so it sits on the row it belongs to: a whole build
         * and a module build of one tree do not write their products to the same place. */}
        <input
          className={css.text}
          value={entry.outputDirectory}
          placeholder={t('wizard.step.server.recipe.output')}
          onChange={(event) => { edit({ outputDirectory: event.target.value }) }}
        />
        <Button
          variant="ghost"
          disabled={draft.recipes.length === 1}
          onClick={() => { onChange({ ...draft, recipes: draft.recipes.filter((_, at) => at !== index) }) }}
        >
          {t('wizard.step.server.recipe.remove')}
        </Button>
      </div>
    )
  }
  const timeout = draft.timeoutMs.trim()
  // A blank timeout means "the host's default"; anything else has to be a number the host can
  // accept, because it refuses a non-positive or unparsable one and the operator would only
  // learn that from the refusal.
  const timeoutValid = timeout.length === 0 || Number.parseInt(timeout, 10) > 0
  return (
    <div className={css.extra}>
      <p className={css.hint}>{t('wizard.step.server.formHint')}</p>
      {field(t('wizard.step.server.field.id'), draft.serverId, (value) => { onChange({ ...draft, serverId: value }) }, t('wizard.step.server.placeholder.id'))}
      {field(t('wizard.step.server.field.username'), draft.username, (value) => { onChange({ ...draft, username: value }) }, t('wizard.step.server.placeholder.username'))}
      {field(t('wizard.step.server.field.host'), draft.host, (value) => { onChange({ ...draft, host: value }) }, t('wizard.step.server.placeholder.host'))}
      {/* Chosen rather than typed: a path on a machine the operator is not sitting at is exactly the
       * field people get wrong, and the connection that proves the destination works is the same one
       * that can list what is on the other side. */}
      <ServerDirectoryPicker draft={draft} onChange={onChange} browseServer={browseServer} t={t} />
      <div className={css.field}>
        <span className={css.label}>{t('wizard.step.server.recipes')}</span>
        {draft.recipes.map(recipe)}
        <div className={css.actionsEnd}>
          <Button
            variant="outline"
            onClick={() => { onChange({ ...draft, recipes: [...draft.recipes, { id: '', command: '', outputDirectory: '' }] }) }}
          >
            {t('wizard.step.server.recipe.add')}
          </Button>
        </div>
      </div>
      {field(t('wizard.step.server.field.timeout'), draft.timeoutMs, (value) => { onChange({ ...draft, timeoutMs: value }) }, t('wizard.step.server.placeholder.timeout'))}
      {field(t('wizard.step.server.field.ssh'), draft.sshExecutable, (value) => { onChange({ ...draft, sshExecutable: value }) })}
      {/* A checkbox rather than a text field: the host treats anything but an explicit true as
       * "do not capture", so the form must send a boolean and not a string it would have to parse. */}
      <Checkbox
        checked={draft.captureRevision}
        onChange={(next) => { onChange({ ...draft, captureRevision: next }) }}
        label={t('wizard.step.server.field.captureRevision')}
        title={t('wizard.step.server.captureRevisionHint')}
      />
      <div className={css.actionsEnd}>
        <Button variant="ghost" disabled={declaring} onClick={onCancel}>
          {t('wizard.step.server.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={declaring || !draftComplete(draft) || !timeoutValid}
          onClick={onSubmit}
        >
          {declaring ? t('wizard.step.server.declaring') : t('wizard.step.server.submit')}
        </Button>
      </div>
    </div>
  )
}

/**
 * Step 5: the summary the operator confirms, which is what opens the Conversation.
 *
 * The confirm itself lives in the footer beside Back, like every other step's forward control:
 * the step renders what is being confirmed, and the footer owns the commit. See
 * {@link OnboardingWizard} for what the commit does beyond recording the step.
 */
function ReadyStep({ progress, projectId, loadServers, t }: StepProps): ReactNode {
  const { answers } = progress
  // The servers are read back rather than taken from the walk's own record: a step declares
  // them on the host, and a summary that recited what the operator typed would keep claiming a
  // server the host does not hold — the one thing a confirmation must not do.
  const [servers, setServers] = useState<readonly YxspecRemoteServerView[]>([])
  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    void loadServers(projectId).then(
      (value) => { if (live) setServers(value) },
      () => { if (live) setServers([]) },
    )
    return () => { live = false }
  }, [loadServers, projectId])
  return (
    <>
      <StepHead title={t('wizard.step.ready.title')} hint={t('wizard.step.ready.hint')} />
      <ul className={css.summary}>
        <li>{t('wizard.step.ready.summaryProject', { project: answers.projectTitle ?? '' })}</li>
        <li>{t('wizard.step.ready.summaryRepositories', { count: answers.repositories?.length ?? 0 })}</li>
        <li>{t('wizard.step.ready.summary', { specification: answers.specificationPath ?? '' })}</li>
        <li>
          {servers.length === 0
            ? t('wizard.step.ready.noServer')
            : t('wizard.step.ready.summaryServers', { count: servers.length })}
        </li>
        {/* One row per declared server under the count, rather than a joined sentence: the
         * names are data, and the separator a sentence would need is copy this component does
         * not own. */}
        {servers.map(server => (
          <li key={server.serverId} className={css.rowMeta}>{server.title || server.serverId}</li>
        ))}
      </ul>
    </>
  )
}

/** The shared step heading: what this step is, and what it is for. */
function StepHead({ title, hint }: { title: string; hint: string }): ReactNode {
  return (
    <div className={css.stepHead}>
      <span className={css.stepTitle}>{title}</span>
      <span className={css.hint}>{hint}</span>
    </div>
  )
}

/**
 * The text of a thrown value, for the wizard's own notice line.
 * @param error - the caught value.
 * @returns its message, or its string form.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Re-exported so a caller resolving the project does not import the state machine too. */
export { currentStep } from './onboarding.ts'
