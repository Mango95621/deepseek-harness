/**
 * The onboarding gate's state: the five prerequisites a project must satisfy before its
 * Conversation accepts input, and how far the operator has come.
 *
 * The gate exists because an ASPICE run is only meaningful against a chosen specification,
 * a named project, its repositories, and (when the deployment builds remotely) a declared
 * server. Letting an operator type a prompt first and discover the missing inputs from a
 * failed tool call inverts the process: the discipline lives in the host, but the operator
 * still has to be told what the host expects. The wizard is that telling.
 *
 * **Completion is per project, not global.** Two projects in the same browser have
 * different specifications and different servers; a global "done" flag would gate the
 * second project on the first one's answers. The store is therefore keyed by workspace id,
 * and this module holds the pure state transitions — reading and writing localStorage is
 * `createSnapshotStore`'s job, and resolution of the current project is the caller's.
 *
 * Nothing here advances a process step. Selecting a specification records a prerequisite;
 * it does not move the ASPICE pointer, which stays a tool call through the host gate.
 * @module @deepseek-ai/dsh-client-ui-yxspec/onboarding
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import type { YxspecDocumentListing } from '@deepseek-ai/dsh-yxspec-api/types'

/** The wizard's steps, in the order they must be satisfied. */
export const ONBOARDING_STEPS = ['project', 'repositories', 'specification', 'server', 'ready'] as const
/** One step id from the closed list. */
export type OnboardingStep = typeof ONBOARDING_STEPS[number]

/**
 * Answers one project recorded while walking the wizard.
 *
 * The wizard starts with the project's identity and its repositories, and only then asks
 * which specification document applies. That order is forced by the data: the specification
 * candidates are files inside the project's own roots, so there is nothing to enumerate
 * before the roots are declared. A wizard that asked for the document first would show an
 * empty list to every cold start and only work on the second visit.
 */
export interface OnboardingAnswers {
  /** The operator's chosen project title, when it differs from the folder name. */
  readonly projectTitle?: string
  /** Repository roots the project spans, primary first. */
  readonly repositories?: readonly string[]
  /**
   * Absolute directories the operator added to the specification search, in the order added.
   *
   * A specification tree frequently lives beside the repositories rather than inside one — a
   * shared document folder, a delivered package, a process-input archive — and nothing in the
   * project's own layout names it, so the host's walk cannot find it. These are the locations
   * the operator pointed at by hand, passed back to every listing call.
   *
   * Held here rather than as host state because they are a property of this search rather than
   * of the project: they gate nothing, no other surface reads them, and recording them in the
   * host would mean a second write path into durable state for an answer the client already
   * has. The progress record is keyed by project, so they are still per project and still
   * survive a reload.
   */
  readonly searchPaths?: readonly string[]
  /** Project-relative path of the chosen specification document. */
  readonly specificationPath?: string
  /**
   * Whether the operator left the specification for later.
   *
   * A specification is often delivered after the project is set up, and a walk that refused to
   * finish without one would hold the Conversation shut over a document nobody has yet. Skipping is
   * therefore an answer — recorded like one, so the gate opens — while leaving the step itself
   * reachable: the trail reopens it, and a document chosen later overwrites the skip.
   */
  readonly specificationDeferred?: boolean
  /**
   * Which declared root the specification sits in, by index (`0` is the primary root).
   *
   * A project spans several repositories, so a project-relative path alone does not identify a
   * document: `specs/spec.md` can exist in two of them. Recording the root keeps the answer
   * unambiguous without storing an absolute path the project may later relocate.
   */
  readonly specificationRootIndex?: number
  /**
   * Whether the operator finished the server step. Recorded even when no server was
   * declared: "this project builds locally" is an answer, and without it the step would
   * ask again on every blank session.
   */
  readonly serverResolved?: boolean
}

/** One project's onboarding progress. */
export interface OnboardingProgress {
  /** Steps the operator has completed, in the order they were completed. */
  readonly completed: readonly OnboardingStep[]
  /** What the operator chose, for redisplay and for prefilling a later re-run. */
  readonly answers: OnboardingAnswers
}

/** The stored shape: one progress record per workspace id. */
export type OnboardingState = Readonly<Record<string, OnboardingProgress>>

/**
 * The project this walk of the wizard is onboarding.
 *
 * Normally the gate resolves its project from the session and workspace catalogues — the
 * same two lists every other client surface reads. Step 1 is the one place where that is not
 * enough, because step 1 is where the project *comes into existence*: the operator submits a
 * name, a project is created over no directory, and only then is there an id to key a record
 * by. Between that create and the next catalogue frame the resolver still answers "not
 * known", so a wizard that persisted only through the resolver would drop the very step that
 * created the project and appear to do nothing.
 *
 * Recording the id here — in its own persisted slot rather than inside the progress record,
 * which is keyed by this same id and cannot hold it without being circular — closes that
 * window and also survives a reload: `create` matches nothing for a project with no roots, so
 * a reloaded wizard cannot find its own project by path and must be told which one it was.
 */
export interface OnboardingTarget {
  /** The project step 1 created, once the host has answered. */
  readonly workspaceId?: WorkspaceId
}

/** The target before step 1 has created anything. */
export const EMPTY_TARGET: OnboardingTarget = {}

/**
 * A walk the operator asked for from outside the wizard.
 *
 * The wizard's gate normally decides *which* project to onboard by resolving one from the
 * catalogues, and that is right when the operator arrives at a home that already belongs to a
 * project. It is wrong for the one gesture that means "let me name a new piece of work": the
 * operator is looking at a project they may not want to touch, and the catalogues will happily
 * resolve *that* one — or, worse, an adopted project's roots would fold steps 1 and 2 in as
 * already answered and the walk would open at the specification, which is exactly the flow the
 * wizard exists to replace.
 *
 * So a walk started from outside is announced here and the gate honours it: while `starting`
 * is set the walk opens at step 1 with an empty record and *no* resolved project, so naming the
 * project is a create again. Step 1 clears it, because from the moment the project exists the
 * walk is described by that project's own record and nothing else.
 *
 * The store is deliberately *not* keyed by project, unlike progress: it is a request about a
 * walk that has no project yet, and it names no project by construction.
 */
export interface OnboardingRequest {
  /** True while a fresh walk is owed: step 1 opens as a create regardless of what resolves. */
  readonly starting?: boolean
}

/** No walk has been asked for; the gate resolves its subject from the catalogues. */
export const EMPTY_REQUEST: OnboardingRequest = {}

/** The empty state a project starts from. */
export const EMPTY_PROGRESS: OnboardingProgress = { completed: [], answers: {} }

/**
 * The progress an already-established project starts its walk from.
 *
 * A project that arrived with a repository root and that no walk has ever touched was not the
 * wizard's to create: it was adopted by pointing at a directory, or minted by the first-use
 * default. Onboarding still applies to it — the specification, the server, and the
 * confirmation are exactly what an ASPICE run needs and none of them is implied by a
 * directory — but the two steps it has already answered must not be asked again. Its roots
 * *are* step 2's answer, and its title is step 1's.
 *
 * So the walk opens at `specification` with the first two steps recorded rather than skipped.
 * That is stronger than "start later in the list": recording them means the trail shows them
 * as done, the summary restates them, and Back can reopen either one — an operator who
 * adopted the wrong directory is one click from fixing it, which is not true of a walk that
 * began at step 3 with no history behind it.
 *
 * @param roots - the project's own declared roots, primary first.
 * @param title - the project's current title, so the trail and summary read it back.
 * @returns the progress prefix the gate starts such a walk from; {@link EMPTY_PROGRESS} when
 *   the project holds no root, because a project with nothing pointing it at code has not
 *   established anything and the wizard is exactly what it needs.
 */
export function establishedProgress(
  roots: readonly string[],
  title: string,
): OnboardingProgress {
  if (roots.length === 0) return EMPTY_PROGRESS
  return completeStep(
    completeStep(EMPTY_PROGRESS, 'project', { projectTitle: title }),
    'repositories',
    { repositories: roots },
  )
}

/**
 * What a specification listing holds before the host has answered, and when it cannot.
 *
 * Declared here rather than inline at the read site so the wizard's empty state and a
 * half-deployed host's answer are the same value: the step renders "nothing found, and here is
 * nowhere I looked" identically in both cases, which is the truth for both.
 */
export const EMPTY_LISTING: YxspecDocumentListing = { documents: [], searched: [], truncated: false }

/**
 * One project's progress, from its record when a walk has written one and from its own row when
 * none has.
 *
 * The rule is shared because two callers need the same answer and a second spelling would be a
 * second thing to keep in step with the gate. The gate asks it to decide where to open; the
 * guided-creation claim asks it to decide whether there is an unfinished walk to resume, and a
 * claim that read the record alone would call a project that was adopted with a directory
 * "unstarted" and start a fresh walk over it.
 * @param record - the project's stored progress, or undefined when no walk has touched it.
 * @param row - the project's own row, for the roots and title an adoption already answered.
 * @returns the progress the wizard opens from.
 */
export function onboardingProgress(
  record: OnboardingProgress | undefined,
  row: { readonly roots: readonly string[]; readonly title: string } | undefined,
): OnboardingProgress {
  if (record !== undefined) return record
  return row === undefined ? EMPTY_PROGRESS : establishedProgress(row.roots, row.title)
}

/**
 * The first step still outstanding, which is where a resumed wizard opens.
 *
 * This is the wizard's own terminal test: `undefined` means every step is recorded and the
 * gate opens. Reaching that state is what `completed` accumulating all five ids means, so
 * there is no separate `isOnboarded` predicate — a second spelling of the same rule would be
 * one more thing that could drift from the gate's actual behaviour.
 * @param progress - the project's stored progress.
 * @returns the step to show, or undefined when the project is fully onboarded.
 */
export function currentStep(progress: OnboardingProgress | undefined): OnboardingStep | undefined {
  const done = progress?.completed ?? []
  return ONBOARDING_STEPS.find(step => !done.includes(step))
}

/**
 * Record one step's completion and its answers.
 *
 * Re-completing a step is idempotent and does not reorder the trail: an operator who steps
 * back to change the specification and returns leaves one entry, so `completed` reads as a
 * set with a history rather than accumulating duplicates.
 * @param progress - the project's current progress.
 * @param step - the step being completed.
 * @param answers - answers this step produced; merged over what was there.
 * @returns the next progress value.
 */
export function completeStep(
  progress: OnboardingProgress | undefined,
  step: OnboardingStep,
  answers: OnboardingAnswers = {},
): OnboardingProgress {
  const base = progress ?? EMPTY_PROGRESS
  return {
    completed: base.completed.includes(step) ? base.completed : [...base.completed, step],
    answers: { ...base.answers, ...answers },
  }
}

/**
 * Drop one step's completion so the wizard reopens there.
 *
 * The answers survive: stepping back to change the specification should show the one
 * currently chosen, not an empty form. What is removed is the claim that the step is
 * settled.
 * @param progress - the project's current progress.
 * @param step - the step to reopen.
 * @returns the next progress value.
 */
export function reopenStep(
  progress: OnboardingProgress | undefined,
  step: OnboardingStep,
): OnboardingProgress {
  const base = progress ?? EMPTY_PROGRESS
  return { completed: base.completed.filter(done => done !== step), answers: base.answers }
}

/**
 * Whether a step's own inputs are supplied, independent of the steps before it.
 *
 * The selector uses this to keep a later step's Continue disabled without re-deriving the
 * rule in the view. It answers about one step's own data only; ordering is
 * {@link currentStep}'s concern.
 * @param step - the step to test.
 * @param progress - the project's current progress.
 * @returns whether the step has what it needs to be completed.
 */
export function stepSatisfied(step: OnboardingStep, progress: OnboardingProgress | undefined): boolean {
  const answers = progress?.answers ?? {}
  switch (step) {
    case 'specification':
      // A deferred choice answers the step as fully as a document does: both mean the operator has
      // said what this run is against, or that there is nothing to say yet.
      return (answers.specificationPath?.length ?? 0) > 0 || answers.specificationDeferred === true
    case 'project':
      return (answers.projectTitle?.trim().length ?? 0) > 0
    case 'repositories':
      return (answers.repositories?.length ?? 0) > 0
    case 'server':
      return answers.serverResolved === true
    case 'ready':
      // The summary is confirmable once the four it summarizes are done. Asking
      // `isOnboarded` here would be circular — that answer includes this step.
      return prerequisitesMet(progress)
  }
}

/**
 * Whether the four steps before the summary are complete.
 * @param progress - the project's current progress.
 * @returns whether the summary has something to confirm.
 */
export function prerequisitesMet(progress: OnboardingProgress | undefined): boolean {
  const done = progress?.completed ?? []
  return ONBOARDING_STEPS
    .filter(step => step !== 'ready')
    .every(step => done.includes(step))
}
