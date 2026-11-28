/**
 * Wire types for the `yxspec` and `yxspecRemote` Remote namespaces.
 *
 * These mirror the domain types but are plain JSON: a Remote boundary crosses into the
 * browser, so nothing here is a class, a readonly brand, or a path object.
 * @module @deepseek-ai/dsh-yxspec-api/types
 */

/**
 * The probe outcome, re-exported rather than re-declared.
 *
 * It already is plain JSON, and the browser reads it — so the choice is between one shape and two
 * that must be kept in step. Re-exporting also keeps a client from depending on the seam package
 * itself just to name what a probe returned.
 */
export type {
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteProbe,
} from '@deepseek-ai/dsh-yxspec-remote'

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
  /** Server-side directory holding the checkout a run builds in. */
  projectDirectory: string
  /** Server-side directory products land in; absent means `<projectDirectory>/out`. */
  outputDirectory?: string
  /** The transport the declaration carries. */
  transport: string
  /** Recipe ids the server declares, sorted. */
  recipeIds: string[]
  /** ISO-8601 instant the declaration was written. */
  declaredAt: string
  /** ISO-8601 instant of the last probe, successful or not; absent until one runs. */
  lastProbeAt?: string
  /** Why the last probe failed; absent once a probe succeeds. */
  lastProbeError?: string
  /** Remote platform string observed by the last successful probe. */
  lastPlatform?: string
}

/**
 * One recipe as the client submits it.
 *
 * An ordered list on the wire rather than the id-keyed map the record stores, because the form
 * that fills it is a list of rows: an operator adding a second recipe would otherwise have to
 * name a key the map has no place for, and a repeated id would silently overwrite a row still
 * on screen.
 */
export interface YxspecRemoteRecipeDraft {
  /** Recipe id, unique within the declaration. */
  id: string
  /** Server command template; `{cwd}` is the project directory and `{out}` this recipe's output directory. */
  command: string
  /**
   * Absolute server directory this recipe's products land in.
   *
   * Per recipe rather than per server because a whole build and a module build of one tree write
   * to different places; omitted means `<projectDirectory>/out`.
   */
  outputDirectory?: string
}

/**
 * A build-server declaration as the client submits it.
 *
 * Every field the record needs, with the optional ones defaulted by the host rather than by the
 * form: a deployment that changes the default timeout then changes it for the tool path and the
 * wizard at once, instead of for whichever of the two the operator happened to use. No
 * credential field exists here or in the record — the destination is an OpenSSH destination the
 * host's own `~/.ssh/config` resolves.
 */
export interface YxspecRemoteServerDraft {
  /** Short id, unique within the project; a re-declaration under one id replaces it. */
  serverId: string
  /** Human-readable label; defaults to the id. */
  title?: string
  /** OpenSSH destination: a `~/.ssh/config` Host alias or `user@host`. */
  destination: string
  /** Absolute server directory holding the checkout to build; it must already exist. */
  projectDirectory: string
  /** Whether each run records the server-side source revision; omitted means it does not. */
  captureRevision?: boolean
  /** The recipes the server may run; at least one is required. */
  recipes: YxspecRemoteRecipeDraft[]
  /** Per-run wall clock budget in milliseconds; omitted means the host's default. */
  timeoutMs?: number
  /** Absolute local `ssh` client; omitted means the platform default. */
  sshExecutable?: string
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
