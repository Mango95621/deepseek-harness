/**
 * Host Remote owner for the YXSpec process surface. Exposes the ASPICE stage model and each
 * stage's landing status to the desktop client as the `yxspec` namespace, so the UI reads
 * the same domain service the gate plugins enforce against — one source of truth, not a
 * second copy of the stage table in the front end.
 *
 * The controller is a thin projection: it owns no rules. Every value it returns comes from
 * `ctx.yxspec` and `ctx.yxspecArtifacts`, which are the seams the gate and freeze plugins
 * already consume.
 * @module @deepseek-ai/dsh-yxspec-api
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-yxspec'
import type {} from '@deepseek-ai/dsh-yxspec-artifact'
// Type-only: pulls the `ctx.workspaceRegistry` service merge.
import type {} from '@deepseek-ai/dsh-workspace'
import { YxspecRemoteController } from './remote.ts'
import { readDocumentListing } from './documents.ts'
import type {
  YxspecDocumentListing,
  YxspecDomainView,
  YxspecStageView,
  YxspecStatusValue,
  YxspecStepView,
} from './types.ts'

export type * from './types.ts'
export { YxspecRemoteController } from './remote.ts'

/**
 * Merge this owner's Remote failure vocabulary. Declaring the codes next to the throwing
 * code is the protocol's convention; a caller can then branch on `code` with `details`
 * already narrowed.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The YXSpec domain service (`ctx.yxspec`) is not mounted in this context. */
    'yxspec/service-unavailable': {}
    /** The YXSpec artifact ledger (`ctx.yxspecArtifacts`) is not mounted in this context. */
    'yxspec/ledger-unavailable': {}
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `yxspec` Remote namespace. */
    yxspecController: YxspecController
  }
}

/**
 * Host service backing the generated `ctx.remote.yxspec` namespace. Read-only: the client
 * renders process state, it does not advance it. Advancing a step is a tool call, which
 * travels through the gate — the same path an agent takes.
 */
export class YxspecController extends TypertRemoteService {
  /**
   * No `static inject`: the two seams are read per call through `ctx.get` so the namespace
   * is published on every deployment and a missing seam surfaces as the typed error below.
   * Declaring them here would instead hold the whole plugin pending — `ctx.yxspecController`
   * would be absent, the client's `yxspec` namespace would never appear, and the section
   * would vanish with no diagnostic rather than reporting what is missing.
   * @param ctx - Host context carrying the domain service and artifact ledger.
   */
  constructor(ctx: Context) {
    super(ctx, 'yxspecController', { namespace: 'yxspec' })
    // Second Remote owner of this package, mounted here because this module is the Loader
    // entry the deployment names. Its own data source (`ctx.yxspecRemote`) is optional, so
    // the child registers on every deployment and simply reports an empty list where no
    // remote plugin is mounted — see `./remote.ts`.
    ctx.plugin(YxspecRemoteController)
  }

  /**
   * The declared identity, stage model, and dual-track map in one call, plus each named
   * stage's landing status.
   * @param landedStages - stage ids to compute status for; omitted means every stage.
   * @returns the projected process state.
   * @throws RemoteError when the domain service or its ledger is not mounted.
   */
  @Remote
  async status(landedStages?: string[]): Promise<YxspecStatusValue> {
    const yxspec = this.domain()
    const ledger = this.ledger()
    const snapshot = await yxspec.snapshot()
    const wanted = landedStages ?? snapshot.stages.map(stage => stage.id)

    const stages: YxspecStageView[] = []
    for (const stage of snapshot.stages) {
      const steps: YxspecStepView[] = stage.steps.map(step => ({
        id: step.id,
        cell: step.cell,
        title: step.title,
        frozen: step.frozen,
        requiredInputs: [...step.requiredInputs],
        hasGateScript: step.gateScript !== undefined,
      }))
      const base = {
        id: stage.id,
        title: stage.title,
        aspice: stage.aspice,
        group: stage.group,
        steps,
      }
      if (!wanted.includes(stage.id)) {
        stages.push({ ...base })
        continue
      }
      // A stage is landed when every declared input across its steps exists on disk. The
      // ledger re-stats on every query, so this reflects the filesystem now, not a cache.
      const declared = stage.steps.flatMap(step => step.requiredInputs)
      const missing = await ledger.missingOf(declared)
      stages.push({ ...base, landed: missing.length === 0, missing })
    }

    const domains: YxspecDomainView[] = snapshot.domains.map(domain => ({
      domain: domain.domain,
      track: domain.track,
      hasEvidence: domain.evidence !== undefined,
    }))

    return {
      identity: {
        specId: snapshot.identity.specId,
        projectName: snapshot.identity.projectName,
        customer: snapshot.identity.customer,
        productType: snapshot.identity.productType,
      },
      root: yxspec.root,
      stages,
      domains,
      tracks: [...snapshot.tracks],
    }
  }

  /**
   * Candidate specification documents for one project, for the onboarding wizard's first
   * step, together with the directories the host enumerated to find them. A bounded
   * enumeration of the project's declared input and design directories; an unknown project,
   * an absent directory, or an unmounted registry all yield an empty listing rather than an
   * error, because "this project has no inputs yet" is a state the wizard renders and not a
   * failure.
   *
   * The search report travels with the candidates rather than in a second call: a client that
   * asked twice could be answered by two different filesystem states, and the report is
   * exactly what makes the empty case legible.
   *
   * `extraDirectories` is how the operator widens the search beyond the project's own layout.
   * It is a parameter rather than host state, and this controller stays read-only: where the
   * operator looks is a property of one operator's search, not of the project, and storing it
   * here would make an unvalidated write path into durable state to answer a question the
   * caller already holds. The client persists its own additions per project and passes them
   * back on each call; the host validates and walks them exactly as it walks the project's own
   * directories.
   * @param workspaceId - the project whose candidate documents to list.
   * @param extraDirectories - absolute directories to search in addition to the project's own;
   *   omitted or empty means the project's layout decides the search.
   * @returns the candidates, the absolute directories searched, and whether the ceiling
   *   truncated the listing.
   */
  @Remote
  async documents(
    workspaceId: string,
    extraDirectories?: string[],
  ): Promise<YxspecDocumentListing> {
    // Optional seam: a deployment that mounts no registry still lists (nothing) rather than
    // raising, which is why this is read through `ctx.get` and not as a property.
    return await readDocumentListing(
      this.ctx.get('workspaceRegistry'),
      workspaceId,
      extraDirectories ?? [],
    )
  }

  /**
   * Every workspace-relative path the domain model declares, so a client can render the
   * artifact tree without hardcoding the layout.
   * @returns the declared artifact paths, de-duplicated and sorted.
   * @throws RemoteError when the domain service is not mounted.
   */
  @Remote
  declaredArtifacts(): string[] {
    const out = new Set<string>()
    for (const stage of this.domain().stages()) {
      for (const step of stage.steps) {
        for (const path of step.requiredInputs) out.add(path.replace(/\\/g, '/'))
      }
    }
    return [...out].sort()
  }

  /**
   * The declared artifact paths belonging to one stage. A client rendering a stage detail
   * view calls this instead of filtering {@link declaredArtifacts}.
   * @param stageId - the stage whose declared inputs to return.
   * @returns the stage's declared artifact paths, de-duplicated and sorted; empty when the
   *   stage id is unknown.
   * @throws RemoteError when the domain service is not mounted.
   */
  @Remote
  declaredArtifactsOf(stageId: string): string[] {
    const stage = this.domain().stage(stageId)
    if (stage === undefined) return []
    const out = new Set<string>()
    for (const step of stage.steps) {
      for (const path of step.requiredInputs) out.add(path.replace(/\\/g, '/'))
    }
    return [...out].sort()
  }

  /** Resolve the domain service or fail with an actionable diagnostic. */
  private domain() {
    // `ctx.get` rather than a property read: the property read is gated on `inject`, so a
    // deployment that omitted the row would get cordis's own "cannot get property without
    // inject" instead of the code this method exists to report.
    const yxspec = this.ctx.get('yxspec')
    if (yxspec === undefined) {
      throw new RemoteError('yxspec/service-unavailable', 'ctx.yxspec is not mounted', {})
    }
    return yxspec
  }

  /** Resolve the artifact ledger or fail with an actionable diagnostic. */
  private ledger() {
    const artifacts = this.ctx.get('yxspecArtifacts')
    if (artifacts === undefined) {
      throw new RemoteError('yxspec/ledger-unavailable', 'ctx.yxspecArtifacts is not mounted', {})
    }
    return artifacts
  }
}

export default YxspecController
