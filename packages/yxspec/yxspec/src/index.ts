/**
 * Service Definition for the YXSpec capability seam. Owns the ASPICE stage model, the
 * dual-track (MCU/MPU) functional-domain map, and spec identity for gated automotive R&D.
 *
 * YXSpec's premise is that process discipline must be enforced by the host, not requested
 * in prose. This service is the read-mostly domain model the enforcement plugins
 * (`yxspec-gate`, `yxspec-freeze`, `yxspec-step`, `yxspec-artifact`) gate on. It performs
 * no enforcement itself.
 *
 * Configuration is deployment-supplied; the default stage model mirrors the ASPICE
 * process names YXSpec's 92 skills implement, and the domain map is read from the
 * workspace's `swe-track-map.json` when present.
 * @module @deepseek-ai/dsh-yxspec
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROJECT_CONFIG_PATH } from './project.ts'
import type {
  YxspecDomainTarget,
  YxspecSnapshot,
  YxspecSpecIdentity,
  YxspecStage,
  YxspecStageStatus,
  YxspecStep,
  YxspecTrack,
} from './types.ts'

export type {
  AspiceProcess,
  YxspecDomainTarget,
  YxspecSnapshot,
  YxspecSpecIdentity,
  YxspecStage,
  YxspecStageStatus,
  YxspecStep,
  YxspecTrack,
} from './types.ts'

/** Plugin configuration: every deployment-specific constant lives here. */
export interface Config {
  /** Workspace root the flow operates in. Resolved against cwd when relative. */
  workspaceRoot?: string
  /** The spec identity to report. */
  identity?: Partial<YxspecSpecIdentity>
  /**
   * Path to the dual-track map, workspace-relative. Read on `snapshot()`; a missing file
   * yields an empty domain list rather than a failure, so a workspace without SWE.1 yet
   * still resolves its stage model.
   */
  trackMapPath?: string
  /**
   * Path to the project's `yxspec.json`, workspace-relative. When present its identity
   * fields seed {@link Config.identity}, so the deployment reads the project's own config
   * instead of restating it. An explicit `identity` key wins over the file.
   */
  projectConfigPath?: string
  /**
   * The declared stage model. An empty or absent list falls back to
   * {@link DEFAULT_STAGES}, which mirrors the SWE.1–SWE.5 stages the shipped skills
   * implement.
   */
  stages?: YxspecStage[]
}

/** Schemastery configuration for the YXSpec domain service. */
const Config: z<Config> = z.object({
  workspaceRoot: z.string(),
  identity: z.object({
    specId: z.string(),
    projectName: z.string(),
    customer: z.string(),
    productType: z.string(),
  }),
  trackMapPath: z.string(),
  projectConfigPath: z.string(),
  stages: z.array(z.any()).default([]),
})

/**
 * The default stage model. These are the SWE-domain stages YXSpec's `yxspec-swe-*` skills
 * implement, each naming its real ASPICE process. Deployments override via `Config.stages`.
 */
const DEFAULT_STAGES: readonly YxspecStage[] = [
  {
    id: 'swe-analysis',
    title: '软件需求分析',
    aspice: 'SWE.1',
    group: 'requirements',
    steps: [
      { id: 'scan', cell: '01-scan.md', title: '源码扫描', frozen: false, requiredInputs: [] },
      { id: 'swr', cell: '02-swr.md', title: 'SWR 产出', frozen: false, requiredInputs: [] },
      { id: 'review', cell: '03-review.md', title: '需求评审', frozen: false, requiredInputs: [] },
    ],
  },
  {
    id: 'swe-arch',
    title: '软件架构设计',
    aspice: 'SWE.2',
    group: 'design',
    steps: [
      {
        id: 'mapping', cell: '01-mapping.md', title: 'SWR→模块映射', frozen: false,
        requiredInputs: [],
      },
      {
        id: 'impl-judge', cell: '02-impl-judge.md', title: '实现度精判', frozen: false,
        requiredInputs: ['project/inputs/extracted/swe-arch/mod-swr-mapping.json'],
      },
      {
        id: 'freeze', cell: '03-freeze.md', title: '❄ 映射冻结', frozen: true,
        requiredInputs: [
          'project/inputs/extracted/swe-arch/mod-swr-mapping.json',
          'project/inputs/extracted/swe-arch/swr-impl-candidates.json',
          'project/inputs/extracted/swe-arch/swr-impl-symbols.json',
          'project/inputs/extracted/swe-arch/baseline-modules.json',
          'project/inputs/extracted/swe-arch/code-module-inventory.json',
        ],
        gateScript: '.agents/skills/yxspec-swe-arch/scripts/freeze-user-confirm.py',
      },
      {
        id: 'contract', cell: '04-contract.md', title: '❄ 契约冻结', frozen: true,
        requiredInputs: ['project/inputs/extracted/swe-arch/sw-arch-framework-preview.md'],
      },
      {
        id: 'docgen', cell: '05-docgen.md', title: '架构文档生成', frozen: false,
        requiredInputs: ['project/inputs/extracted/swe-arch/sw-arch-if-contract.json'],
      },
      {
        id: 'cr-finalize', cell: '06-cr-finalize.md', title: 'CR 收尾', frozen: false,
        requiredInputs: [],
      },
    ],
  },
  {
    id: 'swe-coding-plan',
    title: '编码计划',
    aspice: 'SWE.3',
    group: 'implementation',
    steps: [
      { id: 'plan', cell: '01-plan.md', title: '编码计划', frozen: false, requiredInputs: [] },
      { id: 'do', cell: '02-do.md', title: '编码执行', frozen: false, requiredInputs: [] },
      { id: 'verify', cell: '03-verify.md', title: '编码验证', frozen: false, requiredInputs: [] },
    ],
  },
  {
    id: 'swe-unit-verify',
    title: '单元验证',
    aspice: 'SWE.4',
    group: 'verification',
    steps: [
      { id: 'ut', cell: '01-ut.md', title: '单元测试', frozen: false, requiredInputs: [] },
      { id: 'static', cell: '02-static.md', title: '静态检查', frozen: false, requiredInputs: [] },
    ],
  },
  {
    id: 'swe-integration-verify',
    title: '集成验证',
    aspice: 'SWE.5',
    group: 'verification',
    steps: [
      { id: 'integration', cell: '01-integration.md', title: '集成测试', frozen: false, requiredInputs: [] },
      { id: 'release', cell: '02-release.md', title: '发布验证', frozen: false, requiredInputs: [] },
    ],
  },
]

/** Shape of the deployment's `swe-track-map.json` we consume. */
interface TrackMapFile {
  tracks?: unknown
  domain_targets?: unknown
  domain_targets_evidence?: unknown
}

/** The subset of a project's `yxspec.json` this service consumes. */
interface ProjectConfigFile {
  spec_id?: unknown
  project_name?: unknown
  customer?: unknown
  product_type?: unknown
}

/** Coerce a config value to a non-empty string, or `undefined`. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read the project's own `yxspec.json` and project out the identity fields. A missing or
 * malformed file yields `undefined` rather than throwing: identity is reporting metadata,
 * and a deployment without it still gates correctly on the stage model.
 * @param path - absolute path to the project config.
 * @returns the identity fields the file declares, or `undefined`.
 */
function readProjectIdentity(path: string): Partial<YxspecSpecIdentity> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: ProjectConfigFile
  try {
    parsed = JSON.parse(raw) as ProjectConfigFile
  } catch {
    return undefined
  }
  const out: { specId?: string; projectName?: string; customer?: string; productType?: string } = {}
  const specId = asText(parsed.spec_id)
  const projectName = asText(parsed.project_name)
  const customer = asText(parsed.customer)
  const productType = asText(parsed.product_type)
  if (specId !== undefined) out.specId = specId
  if (projectName !== undefined) out.projectName = projectName
  if (customer !== undefined) out.customer = customer
  if (productType !== undefined) out.productType = productType
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The YXSpec domain service. Read-mostly: consumers gate on it, it does not gate on them.
 */
export class YxspecService extends Service {
  // The Loader reads config metadata from the class for a service plugin, so the
  // schema lives here rather than as a module-level `export const Config` — the
  // latter would be a fifth value export beside the default-exported class.
  static Config = Config

  private readonly workspaceRoot: string
  private readonly stageModel: readonly YxspecStage[]
  private readonly trackMapPath: string
  private readonly identity: YxspecSpecIdentity
  private domainCache: readonly YxspecDomainTarget[] | undefined
  /** Per-agent active step, keyed by an identity minted onto the agent object. */
  private readonly activeSteps = new Map<string, { stepId: string }>()
  private agentSeq = 0

  /**
   * @param ctx - the owning context.
   * @param config - resolved deployment configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'yxspec')
    this.workspaceRoot = resolve(config.workspaceRoot ?? process.cwd())
    this.stageModel = config.stages && config.stages.length > 0 ? config.stages : DEFAULT_STAGES
    this.trackMapPath = config.trackMapPath ?? 'project/config/swe-track-map.json'

    // Identity resolution order: explicit config → project's own yxspec.json → placeholder.
    // Reading the project file means a deployment does not restate what the project already
    // declares, while an explicit config key still wins for a test or an override.
    const projectPath = resolve(
      this.workspaceRoot,
      config.projectConfigPath ?? PROJECT_CONFIG_PATH,
    )
    const fromFile = readProjectIdentity(projectPath)
    const pick = (key: keyof YxspecSpecIdentity): string =>
      asText(config.identity?.[key]) ?? asText(fromFile?.[key]) ?? 'unspecified'
    this.identity = {
      specId: pick('specId'),
      projectName: pick('projectName'),
      customer: pick('customer'),
      productType: pick('productType'),
    }
  }

  /** The resolved workspace root every path in this service is relative to. */
  get root(): string {
    return this.workspaceRoot
  }

  /** The declared spec identity. */
  get spec(): YxspecSpecIdentity {
    return this.identity
  }

  /**
   * Every declared stage, in business order (SWE.1 → SWE.5, then SUP/SPL when present).
   * @returns the stage model; never empty.
   */
  stages(): readonly YxspecStage[] {
    return this.stageModel
  }

  /**
   * Resolve one stage by id.
   * @param id - the stage id.
   * @returns the stage, or `undefined` when the deployment declares no such stage.
   */
  stage(id: string): YxspecStage | undefined {
    return this.stageModel.find(s => s.id === id)
  }

  /**
   * Resolve one step across the whole model. Enumerated so a caller holding only a step id
   * (as a gate hook does) can find its stage and frozen-ness.
   * @param stepId - the step id, unique across the model by convention.
   * @returns the step and its owning stage, or `undefined`.
   */
  step(stepId: string): { stage: YxspecStage; step: YxspecStep } | undefined {
    for (const stage of this.stageModel) {
      const step = stage.steps.find(s => s.id === stepId)
      if (step) return { stage, step }
    }
    return undefined
  }

  /**
   * Whether a step is a frozen ❄ point requiring main-session human confirmation.
   * @param stepId - the step id.
   * @returns true when the step is frozen; false when unknown or not frozen.
   */
  isFrozenStep(stepId: string): boolean {
    return this.step(stepId)?.step.frozen === true
  }

  /**
   * The step a given agent is currently on, as set by the step driver. The gate hook reads
   * this to decide which step's input contract to enforce; with no active step, no step
   * gate applies.
   *
   * Ownership is per-agent so a fan-out workflow's workers do not gate on each other's
   * progress.
   * @param agent - the agent whose active step to read.
   * @returns the active step and its stage, or `undefined` when the agent has none.
   */
  activeStep(agent: object): { stage: YxspecStage; step: YxspecStep } | undefined {
    const key = this.agentKey(agent)
    const held = this.activeSteps.get(key)
    if (held === undefined) return undefined
    return this.step(held.stepId)
  }

  /**
   * Set the step an agent is working on. The step driver calls this when it hands out a
   * step; the gate hook reads it.
   * @param agent - the agent taking the step.
   * @param stepId - the step id, or `undefined` to clear.
   * @returns true when the step id resolved in the stage model.
   */
  setActiveStep(agent: object, stepId: string | undefined): boolean {
    const key = this.agentKey(agent)
    if (stepId === undefined) {
      this.activeSteps.delete(key)
      return true
    }
    const found = this.step(stepId)
    if (found === undefined) return false
    this.activeSteps.set(key, { stepId })
    return true
  }

  private agentKey(agent: object): string {
    const symbol = Symbol.for('@deepseek-ai/dsh-yxspec/agent')
    const held = (agent as Record<symbol, unknown>)[symbol]
    if (typeof held === 'string') return held
    const minted = `agent-${this.agentSeq++}`
    ;(agent as Record<symbol, unknown>)[symbol] = minted
    return minted
  }

  /**
   * The whole declarative model plus the read track map, for a UI or a step driver that
   * wants one call.
   * @returns an immutable snapshot.
   */
  async snapshot(): Promise<YxspecSnapshot> {
    return {
      identity: this.identity,
      stages: this.stageModel,
      domains: await this.domains(),
      tracks: await this.declaredTracks(),
    }
  }

  /**
   * The functional-domain → track map, read from the workspace's track-map file. Results are
   * cached for the process lifetime; the map is deployment configuration, not live state.
   * @returns the domain assignments; empty when the file is absent or malformed.
   */
  async domains(): Promise<readonly YxspecDomainTarget[]> {
    if (this.domainCache !== undefined) return this.domainCache
    this.domainCache = await this.readTrackMap()
    return this.domainCache
  }

  /**
   * Assign a functional domain to its track.
   * @param domain - the domain key.
   * @returns the assigned track, defaulting to `both` when unmapped.
   */
  async trackOf(domain: string): Promise<YxspecTrack> {
    const hit = (await this.domains()).find(d => d.domain === domain)
    return hit?.track ?? 'both'
  }

  /**
   * Progress of one stage, derived from the artifact ledger rather than from any agent
   * self-report. A stage is complete only when its terminal step's outputs have landed.
   *
   * This is the seam `yxspec-step` and `yxspec-artifact` cooperate on; the domain service
   * exposes the hook so a UI can read the same answer without duplicating the rule.
   * @param stageId - the stage id.
   * @param landed - predicate answering whether a workspace-relative path has landed.
   * @returns the stage's status.
   */
  async status(stageId: string, landed: (path: string) => Promise<boolean>): Promise<YxspecStageStatus> {
    const stage = this.stage(stageId)
    if (!stage) return { stage: stageId, currentStep: undefined, complete: false }
    let currentStep: string | undefined
    for (const step of stage.steps) {
      const ready = await this.inputsLanded(step, landed)
      if (!ready) break
      currentStep = step.id
    }
    const last = stage.steps.at(-1)
    return {
      stage: stageId,
      currentStep,
      complete: currentStep !== undefined && last !== undefined && currentStep === last.id,
    }
  }

  /**
   * Whether every declared input of a step has landed.
   * @param step - the step whose inputs to test.
   * @param landed - the path predicate.
   * @returns true when all inputs are present (or the step declares none).
   */
  async inputsLanded(step: YxspecStep, landed: (path: string) => Promise<boolean>): Promise<boolean> {
    for (const rel of step.requiredInputs) {
      if (!(await landed(rel))) return false
    }
    return true
  }

  private async declaredTracks(): Promise<readonly YxspecTrack[]> {
    const raw = await this.readTrackMapRaw()
    const tracks = raw?.tracks
    if (!Array.isArray(tracks)) return ['mcu', 'mpu']
    const kept = tracks.filter((t): t is YxspecTrack => t === 'mcu' || t === 'mpu' || t === 'both')
    return kept.length > 0 ? kept : ['mcu', 'mpu']
  }

  private async readTrackMap(): Promise<readonly YxspecDomainTarget[]> {
    const raw = await this.readTrackMapRaw()
    const targets = raw?.domain_targets
    if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) return []
    const evidence = raw?.domain_targets_evidence
    const evidenceMap = (typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence))
      ? evidence as Record<string, unknown>
      : {}
    const out: YxspecDomainTarget[] = []
    for (const [domain, value] of Object.entries(targets as Record<string, unknown>)) {
      if (typeof value !== 'string') continue
      if (value !== 'mcu' && value !== 'mpu' && value !== 'both') continue
      const why = evidenceMap[domain]
      out.push({
        domain,
        track: value,
        ...(typeof why === 'string' && why.length > 0 ? { evidence: why } : {}),
      })
    }
    return out
  }

  private async readTrackMapRaw(): Promise<TrackMapFile | undefined> {
    const path = resolve(this.workspaceRoot, this.trackMapPath)
    try {
      const text = await readFile(path, 'utf8')
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return undefined
      // Every TrackMapFile member is optional and untyped, so a checked object already
      // satisfies it; an assertion here would only restate what the guard proved.
      return parsed
    } catch {
      // Absent or malformed deployment configuration is not a service failure: a workspace
      // before SWE.1 simply has no domain map yet, and callers fall back to `both`.
      return undefined
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    yxspec: YxspecService
  }
}

export default YxspecService
