/**
 * Vocabulary of the YXSpec capability seam: the ASPICE stage model, the dual-track
 * (MCU/MPU) functional-domain map, and the flow-step description a step driver
 * advances through.
 *
 * These are plain host-realm JSON-shaped types. The service that owns them lives in
 * `index.ts`; consumers read them through `ctx.yxspec` and never construct them.
 * @module @deepseek-ai/dsh-yxspec/types
 */

/** The two development tracks a functional domain can be assigned to. */
export type YxspecTrack = 'mcu' | 'mpu' | 'both'

/**
 * The ASPICE process the YXSpec toolchain realizes. Kept as a closed list so consumers can
 * exhaustively route on it; unknown ids pass through as plain strings for deployment
 * extension.
 */
export const ASPICE_PROCESSES = [
  'ACQ.4',
  'SYS.1', 'SYS.2', 'SYS.3', 'SYS.4', 'SYS.5',
  'SWE.1', 'SWE.2', 'SWE.3', 'SWE.4', 'SWE.5',
  'SUP.1', 'SUP.8', 'SUP.10',
  'SPL.2',
] as const

/** One ASPICE process name from the closed list. */
export type AspiceProcess = typeof ASPICE_PROCESSES[number]

/**
 * One ASPICE stage definition, as declared by the deployment. YXSpec's stage model is
 * project configuration — the immutable part is the ASPICE process identity, which this
 * record names.
 */
export interface YxspecStage {
  /** Short kebab-case stage id (the skill suffix, e.g. `swe-arch`). */
  readonly id: string
  /** The Chinese display name used across the toolchain. */
  readonly title: string
  /** The ASPICE process this stage realizes (e.g. `SWE.2`). */
  readonly aspice: string
  /** The worktable group that owns this stage (e.g. `design`). */
  readonly group: string
  /** The ordered step ids this stage decomposes into. */
  readonly steps: readonly YxspecStep[]
}

/** One numbered step inside a stage. */
export interface YxspecStep {
  /** Step id within the stage (e.g. `freeze`). */
  readonly id: string
  /** The numbered cell file backing this step (e.g. `03-freeze.md`). */
  readonly cell: string
  /** Short human label. */
  readonly title: string
  /**
   * Whether this step is a frozen ❄ point that MUST be confirmed in the main
   * session by a human. The seam enforces this; the cell only documents it.
   */
  readonly frozen: boolean
  /**
   * Workspace-relative artifacts that must already exist before this step may run.
   * An empty list means the step has no declared input gate.
   */
  readonly requiredInputs: readonly string[]
  /** Optional deterministic gate script, workspace-relative. */
  readonly gateScript?: string
}

/** Identity of the spec being produced. */
export interface YxspecSpecIdentity {
  /** The spec id (e.g. `qr-yf-v103-2026`). */
  readonly specId: string
  /** The human project name. */
  readonly projectName: string
  /** The customer. */
  readonly customer: string
  /** The product type token (e.g. `ivi`). */
  readonly productType: string
}

/** One functional domain's track assignment plus the evidence for it. */
export interface YxspecDomainTarget {
  /** The domain key as it appears in the PRD. */
  readonly domain: string
  /** The assigned track. */
  readonly track: YxspecTrack
  /** Why this assignment was made; absent when the map carried none. */
  readonly evidence?: string
}

/** A snapshot of everything a consumer needs to render or gate on. */
export interface YxspecSnapshot {
  /** The resolved spec identity. */
  readonly identity: YxspecSpecIdentity
  /** Every declared stage, in business order. */
  readonly stages: readonly YxspecStage[]
  /** The functional-domain track map. */
  readonly domains: readonly YxspecDomainTarget[]
  /** The tracks this deployment declares. */
  readonly tracks: readonly YxspecTrack[]
}

/** Live progress of one stage: which step is open and what has landed. */
export interface YxspecStageStatus {
  /** The stage id. */
  readonly stage: string
  /** The step id currently open, or `undefined` when the stage is not started. */
  readonly currentStep: string | undefined
  /** Whether the stage has been advanced to its terminal step. */
  readonly complete: boolean
}
