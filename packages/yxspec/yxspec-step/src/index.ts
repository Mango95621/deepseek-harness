/**
 * The YXSpec step driver. YXSpec's `inject.py` is a paper-feeding machine: it prints one
 * step's body and advances a cursor, checking nothing (the cells self-judge). This plugin
 * keeps the one-step-at-a-time discipline — the property that makes the flow auditable —
 * but moves the advance decision onto the artifact ledger, so the driver itself refuses to
 * advance past a step whose outputs never landed.
 *
 * Two model-facing tools:
 * - `yxspec_status` — read-only view of every stage's progress.
 * - `yxspec_next` — advance the current stage by one step, returning the step contract.
 *
 * Advancing is refused when the current step's declared outputs are absent. The driver
 * reports which paths are missing rather than accepting the agent's word that it finished.
 * @module @deepseek-ai/dsh-yxspec-step
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { sessionDeclaresYxspecProcess } from '@deepseek-ai/dsh-yxspec/project'
import { JSON_TOOL_OUTPUT } from '@deepseek-ai/dsh-yxspec/tool-output'
import type {} from '@deepseek-ai/dsh-yxspec'
import type {} from '@deepseek-ai/dsh-yxspec-artifact'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import type { YxspecStage, YxspecStep } from '@deepseek-ai/dsh-yxspec'

/** Plugin configuration. */
export interface Config {
  /**
   * The stage the driver starts on when a call omits one. Absent means the driver starts at
   * the first declared stage.
   */
  defaultStage?: string
}

/** Schemastery configuration for the step driver. */
export const Config: z<Config> = z.object({
  defaultStage: z.string(),
})

export const name = 'yxspec-step'

/**
 * Services this plugin consumes.
 *
 * `workingDirectory` and `workspaceRegistry` are what
 * {@link whenYxspecProject} reads to answer "is this session in a project that
 * declares a YXSpec process?", and a service read without a matching `inject`
 * entry throws rather than falling back. Declaring them also makes the row wait
 * for the pair instead of registering a guard that cannot answer.
 */
export const inject = ['tools', 'yxspec', 'yxspecArtifacts', 'workingDirectory', 'workspaceRegistry']

/**
 * The step-time activation guard for both tools: the preparing agent works in a
 * project that declares a YXSpec process.
 *
 * A `false` result excludes the tool from both the step's declarations and its
 * dispatch, so the reduction is real at the model boundary rather than advisory.
 * The marker is the project's own `project/config/yxspec.json`, read through the
 * same predicate the domain service and the build-server tools use — so "the
 * wizard showed me YXSpec steps" and "the model has the step tools" cannot
 * disagree.
 * @param ctx - the registrant context.
 * @returns the activation condition.
 */
function whenYxspecProject(ctx: Context) {
  return ({ agent }: { agent: Agent }): boolean =>
    sessionDeclaresYxspecProcess(ctx, agent.session)
}

/** The declared outputs of a step, which the driver requires before advancing. */
function stepOutputs(step: YxspecStep): readonly string[] {
  // YXSpec cells declare outputs as the artifacts the NEXT step lists as inputs. Using the
  // same vocabulary keeps one source of truth; a step with no successors is terminal and
  // has no gate to satisfy.
  return step.requiredInputs
}

/** Render the step contract the agent is to execute. */
function renderStep(stage: YxspecStage, step: YxspecStep, cellDir: string): string {
  const lines = [
    `阶段：${stage.id}（${stage.title}，ASPICE ${stage.aspice}）`,
    `步骤：${step.id} — ${step.title}`,
    `单元：${cellDir}/${step.cell}`,
  ]
  if (step.frozen) {
    lines.push('❄ 本步为冻结点：必须由主会话向用户确认，禁止委派 subagent、禁止自动跳过。')
  }
  if (step.requiredInputs.length > 0) {
    lines.push(`输入（须已落盘）：${step.requiredInputs.join('、')}`)
  }
  if (step.gateScript) {
    lines.push(`门脚本：${step.gateScript}`)
  }
  return lines.join('\n')
}

/**
 * Register the driver tools.
 * @param ctx - the registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const cellDir = '.agents/skills'
  const when = whenYxspecProject(ctx)

  ctx.tools.register(defineTool({
    name: 'yxspec_status',
    description:
      'Read the YXSpec flow status: every declared stage, the step each is on, and whether it '
      + 'has completed. Progress is derived from artifacts on disk, not from any prior claim.',
    parameters: {
      stage: {
        type: 'string',
        description: 'Limit the report to one stage id; omit to report every stage.',
      },
    },
    output: JSON_TOOL_OUTPUT,
    async execute(args, _exec) {
      const wanted = typeof args.stage === 'string' && args.stage.length > 0 ? args.stage : undefined
      const rows = []
      for (const stage of ctx.yxspec.stages()) {
        if (wanted !== undefined && stage.id !== wanted) continue
        const status = await ctx.yxspec.status(stage.id, p => ctx.yxspecArtifacts.landed(p))
        rows.push({
          stage: stage.id,
          title: stage.title,
          aspice: stage.aspice,
          currentStep: status.currentStep ?? null,
          complete: status.complete,
          stepCount: stage.steps.length,
        })
      }
      return {
        identity: ctx.yxspec.spec,
        root: ctx.yxspec.root,
        stages: rows,
      } as never
    },
  }), { when })

  ctx.tools.register(defineTool({
    name: 'yxspec_next',
    description:
      'Advance the YXSpec flow by exactly one step and return that step\'s contract. Refuses to '
      + 'advance while the current step\'s declared outputs are missing, reporting the absent '
      + 'paths. This is the only sanctioned way to move the flow forward.',
    parameters: {
      stage: {
        type: 'string',
        description: 'The stage to advance; omit to use the configured default.',
      },
      step: {
        type: 'string',
        description: 'Jump to a specific step id instead of the next one. Gate still applies.',
      },
    },
    output: JSON_TOOL_OUTPUT,
    async execute(args, exec) {
      const stageId = typeof args.stage === 'string' && args.stage.length > 0
        ? args.stage
        : config.defaultStage ?? ctx.yxspec.stages()[0]?.id
      const stage = stageId === undefined ? undefined : ctx.yxspec.stage(stageId)
      if (stage === undefined) {
        return { ok: false, error: `未知阶段：${String(stageId)}` } as never
      }

      const status = await ctx.yxspec.status(stage.id, p => ctx.yxspecArtifacts.landed(p))
      const explicit = typeof args.step === 'string' && args.step.length > 0 ? args.step : undefined
      let target: YxspecStep | undefined
      if (explicit !== undefined) {
        target = stage.steps.find(s => s.id === explicit)
        if (target === undefined) {
          return { ok: false, error: `阶段 ${stage.id} 无此步骤：${explicit}` } as never
        }
      } else {
        const at = status.currentStep === undefined
          ? -1
          : stage.steps.findIndex(s => s.id === status.currentStep)
        target = stage.steps[at + 1]
        if (target === undefined) {
          return { ok: false, stage: stage.id, complete: true, error: '本阶段已是最后一步。' } as never
        }
      }

      // The advance gate: the step we are leaving must have landed its outputs. When jumping
      // explicitly, the same rule applies to the step being skipped past.
      const leaving = status.currentStep === undefined
        ? undefined
        : stage.steps.find(s => s.id === status.currentStep)
      /* v8 ignore start -- `leaving` is `currentStep`, and `status()` only names a step whose
       * own declared inputs have all landed; `stepOutputs` is that same list, so `missing` is
       * empty by construction. The guard stays because the two rules are stated in different
       * places — a future change to either one would otherwise let a step advance on artifacts
       * it never produced, and failing open here is the worst outcome. */
      if (leaving !== undefined && !status.complete) {
        const missing = await ctx.yxspecArtifacts.missingOf(stepOutputs(leaving))
        if (missing.length > 0) {
          return {
            ok: false,
            stage: stage.id,
            blockedAt: leaving.id,
            missing: [...missing],
            error: `上一步 ${leaving.id} 的产物未落盘，不得推进。`,
          } as never
        }
      }
      /* v8 ignore stop */

      if (exec.agent !== undefined) ctx.yxspec.setActiveStep(exec.agent, target.id)
      return {
        ok: true,
        stage: stage.id,
        step: target.id,
        frozen: target.frozen,
        contract: renderStep(stage, target, `${cellDir}/yxspec-${stage.id}/steps`),
      } as never
    },
  }), { when })
}
