/**
 * Wire types for the `yxspec` Remote namespace.
 *
 * These mirror the domain types but are plain JSON: a Remote boundary crosses into the
 * browser, so nothing here is a class, a readonly brand, or a path object.
 * @module @deepseek-ai/dsh-yxspec-api/types
 */

/** One step, as the client renders it. */
export interface YxspecStepView {
  /** Step id, unique across the model by convention. */
  id: string
  /** The step cell filename inside the owning skill. */
  cell: string
  /** Human-readable step title. */
  title: string
  /** Whether the step is a ❄ point requiring human sign-off. */
  frozen: boolean
  /** Workspace-relative artifacts the step requires before it may run. */
  requiredInputs: string[]
  /** Whether the deployment declared a deterministic gate script for this step. */
  hasGateScript: boolean
}

/** One stage, as the client renders it. */
export interface YxspecStageView {
  /** Stage id. */
  id: string
  /** Human-readable stage title. */
  title: string
  /** The ASPICE process this stage realizes. */
  aspice: string
  /** The stage group used for layout. */
  group: string
  /** The stage's steps, in business order. */
  steps: YxspecStepView[]
  /**
   * Whether every declared input across the stage's steps exists on disk. Absent when the
   * caller did not ask for this stage's status.
   */
  landed?: boolean
  /** The declared inputs that are still missing. Present only alongside `landed: false`. */
  missing?: readonly string[]
}

/** One functional domain and its track assignment. */
export interface YxspecDomainView {
  /** The domain key. */
  domain: string
  /** The assigned track. */
  track: string
  /** Whether the track map carries evidence for this assignment. */
  hasEvidence: boolean
}

/** The declared spec identity, as the client renders it. */
export interface YxspecIdentityView {
  /** The spec id. */
  specId: string
  /** The project name. */
  projectName: string
  /** The customer name. */
  customer: string
  /** The product type. */
  productType: string
}

/** The complete process state the client renders. */
export interface YxspecStatusValue {
  /** The declared spec identity. */
  identity: YxspecIdentityView
  /** Absolute workspace root every path above is relative to. */
  root: string
  /** The stage model, in business order. */
  stages: YxspecStageView[]
  /** The dual-track functional-domain map. */
  domains: YxspecDomainView[]
  /** The declared track names, in declaration order. */
  tracks: string[]
}

/**
 * One declared build server, as the client renders it.
 *
 * The declaration's recipe map is projected to its keys: the command templates behind them
 * are server-side deployment detail, and the client only needs to know which recipes a
 * server offers before it offers a run control.
 */
export interface YxspecRemoteServerView {
  /** Short id, unique within the project. */
  serverId: string
  /** Human-readable label. */
  title: string
  /** OpenSSH destination resolved against the host's own `~/.ssh/config`. */
  destination: string
  /** Server-side directory a run's scratch tree lands in. */
  baseDirectory: string
  /** The transport the declaration carries. */
  transport: string
  /** Recipe ids the server declares, sorted. */
  recipeIds: string[]
  /** ISO-8601 instant the declaration was written. */
  declaredAt: string
  /** ISO-8601 instant of the last successful probe; absent until one succeeds. */
  lastProbeAt?: string
  /** Remote platform string observed by the last successful probe. */
  lastPlatform?: string
}

/** One candidate specification document a deployment may adopt. */
export interface YxspecDocumentView {
  /** Project-relative path, POSIX-separated. */
  path: string
  /** Basename without the extension, as the wizard lists it. */
  title: string
  /** The declared partition the document lives under, when it has one. */
  partition?: string
  /** File size in bytes. */
  size: number
  /**
   * Index of the declared root this document was found under; `0` is the primary root.
   *
   * A project spans several repositories and a relative path alone does not identify a
   * document — the same `specs/spec.md` can exist in two of them. Carrying the index lets the
   * wizard both disambiguate two rows and hand back which root the operator chose.
   */
  rootIndex: number
}

/**
 * A candidate listing together with where the host looked for it.
 *
 * The candidates alone cannot answer the question an empty list provokes. "No specification
 * document found" is the same sentence whether the project genuinely has no inputs yet or the
 * operator pointed the wizard at the wrong directory, and a wizard that shows only the
 * sentence leaves the operator to guess which. Reporting the directories the host actually
 * enumerated turns that guess into a legible answer.
 *
 * `searched` is what was *walked*, not what was declared: a declared location that does not
 * exist is still reported, because "I looked here and it is not there" is exactly the fact
 * that explains an empty list. Paths are absolute so the operator can compare them against a
 * file manager without knowing how the host resolves a project root.
 */
export interface YxspecDocumentListing {
  /** The candidates, the project's declared ones first and each group path-sorted. */
  documents: YxspecDocumentView[]
  /**
   * Absolute directories the host enumerated, de-duplicated, in walk order.
   *
   * Declared locations come first, then the deployment's own convention directories. Not
   * truncated by the candidate ceiling, so the report stays complete exactly when the listing
   * does not.
   */
  searched: string[]
  /**
   * Whether the candidate ceiling cut the listing short.
   *
   * A project whose specification tree holds more documents than the wizard will list still
   * holds them — the operator has to know the list they see is bounded, and that the document
   * they want may be below the fold rather than absent.
   */
  truncated: boolean
}
