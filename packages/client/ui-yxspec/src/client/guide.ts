/**
 * The guided-creation port: the wizard's answer to "add a project".
 *
 * Adding a project from the workspace surfaces has always meant pointing at a directory, and
 * that is the right route when a project *is* its directory. It is the wrong route for a
 * deployment where a project must also carry a chosen ASPICE specification, its repositories,
 * and (when the build is remote) a declared server before any Session may be attached: the
 * directory picker would create the project over that directory first, which is precisely the
 * two steps the wizard means to ask for — and the walk would then open at the third step, having
 * silently recorded the very answers it exists to collect.
 *
 * So this port claims the gesture instead. It is registered as an optional service, read by the
 * workspace surfaces with `ctx.get`, because it *replaces* an affordance those surfaces already
 * have: a deployment without this plugin keeps the directory flow and is fully functional, which
 * is exactly what an optional service expresses and a hard dependency could not.
 *
 * `begin` chooses between the two things the gesture can mean, and that choice belongs here
 * rather than in the caller because it needs this package's state and rules:
 *
 * - The resolved project already has a step outstanding: **resume**. Nothing is raised — the
 *   gate is already gating that project, so reaching its home shows the outstanding step, and a
 *   request would only be a second statement of what the gate already says. A project that
 *   answered the first two steps by being *adopted* through a directory is in this case too:
 *   its roots are step 2's answer, so the walk has something outstanding from step 3 on.
 * - Nothing is outstanding, or there is no project: **start**. This is the case the catalogue
 *   resolution answers wrongly, because it names a project that is *finished* (whose walk would
 *   not open at all) or one with nothing pointing it at code (whose walk would otherwise have
 *   no name or repository to fold in either way, but which the request must still open over as
 *   a create so the operator is not silently renaming an existing project).
 *
 * "Unfinished" is not read off the record alone, which is why the adopted case above is a
 * *resume* rather than a start: such a project has no record and has still answered steps 1 and
 * 2, so {@link onboardingProgress} — the gate's own rule, shared rather than restated — is what
 * tells `begin` it is not a fresh project.
 *
 * The port is declared by its consumer (`ui-workspace`) so the two packages share the shape
 * without either importing the other's values; this file implements it.
 * @module @deepseek-ai/dsh-client-ui-yxspec/guide
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectOnboarding } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { currentStep, onboardingProgress, type OnboardingState } from './onboarding.ts'
import { resolveProjectId } from './project.ts'

/**
 * The two writes the port needs from the registration that owns the wizard's stores.
 *
 * Passed as callbacks rather than reached for through the Context: the request is a store the
 * gate subscribes to, and that store's declaration is the registration's private business. A
 * service hop would publish an internal seam as API and cost a second name for the same thing.
 */
export interface GuidedCreationHost {
  /**
   * Show the guided creation, starting a new walk or resuming the one already in flight.
   *
   * Both outcomes land on the blank home, because that is the only place the wizard takes over
   * (its gate rides the hero frame). They differ in the request: a new walk raises it so step 1
   * opens as a create, and a resumed one leaves it clear so the outstanding project's record is
   * what the gate opens on. The caller decides which; this is one call rather than two so the
   * navigation — which is identical — cannot be forgotten on one branch.
   * @param fresh - true to start a new walk, false to resume the resolved project's.
   */
  open(fresh: boolean): void
  /**
   * Withdraw an unclaimed walk request, leaving the navigation alone.
   *
   * Not a return to the blank home: this answers a gesture the operator made *instead* — they
   * navigated to a project or Session — so moving the view again would fight the very
   * navigation it is responding to. Answering with no request outstanding is expected.
   */
  cancel(): void
}

/**
 * Install the guided-creation port.
 *
 * Registered through `ctx.provide` rather than as a `Service` subclass: the port is two closures
 * over state this plugin already holds, and a class would add a lifecycle to a value whose
 * lifetime is exactly the plugin's own.
 * @param ctx - client root context.
 * @param host - the request store's two writes, owned by the registration.
 * @param state - the onboarding record, read to tell an unfinished walk from a finished one.
 * @returns the port's disposer, owned by the caller's fiber.
 */
export function provideProjectOnboarding(
  ctx: Context,
  host: GuidedCreationHost,
  state: () => OnboardingState,
): () => void {
  const port: ProjectOnboarding = {
    begin: () => {
      const resolved = resolveProjectId(ctx.workspaces.list.getSnapshot(), ctx.sessions.list.getSnapshot())
      const resuming = resolved !== undefined && currentStep(progressOf(ctx, state(), resolved)) !== undefined
      host.open(!resuming)
    },
    cancel: host.cancel,
  }
  return ctx.provide('projectOnboarding', port)
}

/**
 * The resolved project's progress, its own row standing in for a record no walk has written.
 *
 * A project adopted by pointing at a directory has no record and has still answered steps 1 and
 * 2 — its roots *are* step 2's answer and its title is step 1's. Reading the record alone would
 * call it unstarted and start a fresh walk over it.
 * @param ctx - client root context, for the project's row.
 * @param state - every project's onboarding record.
 * @param workspaceId - the project to read.
 * @returns its progress, from the record when there is one and its row otherwise.
 */
function progressOf(ctx: Context, state: OnboardingState, workspaceId: WorkspaceId) {
  const row = ctx.workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspaceId)
  return onboardingProgress(state[workspaceId], row)
}
