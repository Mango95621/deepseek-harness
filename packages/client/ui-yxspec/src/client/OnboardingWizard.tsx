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
  Button, IconCheckOutlineRegular, IconFolderOpenRegular, IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { YxspecDocumentListing, YxspecDocumentView, YxspecRemoteServerView } from '@deepseek-ai/dsh-yxspec-api/types'
import type { NS } from './locales.ts'
import { resolveOnboardingProject } from './project.ts'
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

  // The gate's open branch, and it must be exact: rendering the wizard over an onboarded
  // project would hide a live composer behind a form.
  if (!hero || step === undefined) return children

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
 * Not every specification tree is inside the project, which the diagnosis above cannot help
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

/** Step 4: whether a build server is declared; declaring one stays a tool call. */
function ServerStep({ projectId, onComplete, loadServers, t }: StepProps): ReactNode {
  const [servers, setServers] = useState<readonly YxspecRemoteServerView[] | undefined>(undefined)

  useEffect(() => {
    if (projectId === undefined) return
    let live = true
    void loadServers(projectId).then(
      (value) => { if (live) setServers(value) },
      // An absent remote plugin is not a failure: the step's answer is still "none declared".
      () => { if (live) setServers([]) },
    )
    return () => { live = false }
  }, [loadServers, projectId])

  return (
    <>
      <StepHead title={t('wizard.step.server.title')} hint={t('wizard.step.server.hint')} />
      {servers === undefined
        ? <p className={css.hint}>{t('wizard.step.specification.loading')}</p>
        : servers.length === 0
          ? (
            <p className={css.empty}>
              {t('wizard.step.server.empty')}
              {' '}
              {t('wizard.step.server.declare')}
            </p>
          )
          : (
            <ul className={css.list}>
              {servers.map(server => (
                <li key={server.serverId} className={css.row}>
                  <span className={css.rowTitle} title={server.destination}>{server.title || server.serverId}</span>
                  <span className={css.rowMeta}>{server.transport}</span>
                </li>
              ))}
            </ul>
          )}
      <div className={css.actionsEnd}>
        <Button variant="outline" disabled={servers === undefined} onClick={() => { onComplete({ serverResolved: true }) }}>
          {t('wizard.skip')}
        </Button>
        <Button variant="primary" disabled={servers === undefined} onClick={() => { onComplete({ serverResolved: true }) }}>
          {t('wizard.next')}
        </Button>
      </div>
    </>
  )
}

/**
 * Step 5: the summary the operator confirms, which is what opens the Conversation.
 *
 * The confirm itself lives in the footer beside Back, like every other step's forward control:
 * the step renders what is being confirmed, and the footer owns the commit. See
 * {@link OnboardingWizard} for what the commit does beyond recording the step.
 */
function ReadyStep({ progress, t }: StepProps): ReactNode {
  const { answers } = progress
  return (
    <>
      <StepHead title={t('wizard.step.ready.title')} hint={t('wizard.step.ready.hint')} />
      <ul className={css.summary}>
        <li>{t('wizard.step.ready.summaryProject', { project: answers.projectTitle ?? '' })}</li>
        <li>{t('wizard.step.ready.summaryRepositories', { count: answers.repositories?.length ?? 0 })}</li>
        <li>{t('wizard.step.ready.summary', { specification: answers.specificationPath ?? '' })}</li>
        <li>{t('wizard.step.ready.noServer')}</li>
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
