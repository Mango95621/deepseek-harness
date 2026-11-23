/**
 * YXSpec freeze points. Each ASPICE ❄ step must be confirmed by a human in the main
 * session — the cells say so in prose (`禁止委派 subagent 代确认、禁止自动跳过`), and
 * nothing in the original toolchain enforced it. Here the rule lives in the host: a tool
 * call belonging to a frozen step does not proceed until `ctx.approval` answers
 * `allowed-once`.
 *
 * The failure mode is the point. `ctx.approval`'s answerer waterfall settles `unavailable`
 * when no answerer owns the request, and this plugin denies on anything but `allowed-once`.
 * A flow with nobody at the keyboard therefore stops at the freeze point rather than
 * signing itself off — the ASPICE behaviour, obtained from the approval seam rather than
 * re-implemented.
 * @module @deepseek-ai/dsh-yxspec-freeze
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-yxspec'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Plugin configuration. */
export interface Config {
  /**
   * Tools that constitute "working a frozen step" and must therefore be confirmed. Defaults
   * to the writing family plus the shell, since a frozen step's sign-off covers both the
   * artifact it produces and the commands that produce it.
   */
  guardedTools?: string[]
  /** Whether the freeze hook is active. Disabling it reverts to prose-only enforcement. */
  enabled?: boolean
}

/** The built-in set of calls a frozen step must have confirmed. */
const DEFAULT_GUARDED = ['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'bash']

/** Schemastery configuration for the freeze gate. */
export const Config: z<Config> = z.object({
  // A bare `z.array(z.string())` resolves to `[]`, which would make the caller's
  // `?? DEFAULT_GUARDED` fallback unreachable and silently exempt every tool from the
  // freeze confirmation. Defaulting here keeps the fail-closed behaviour intact.
  guardedTools: z.array(z.string()).default([...DEFAULT_GUARDED]),
  enabled: z.boolean().default(true),
})

export const name = 'yxspec-freeze'
export const inject = ['tools', 'yxspec', 'approval']

/**
 * Register the freeze hook. Runs after the stage gate so a call that fails the structural
 * gate is denied before the user is ever asked.
 * @param ctx - the registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.enabled === false) return
  const guarded = config.guardedTools ?? DEFAULT_GUARDED

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!guarded.includes(exec.name)) return next()
    const agent = exec.agent
    if (agent === undefined) return next()

    const active = ctx.yxspec.activeStep(agent)
    if (active === undefined || !active.step.frozen) return next()

    const outcome = await ctx.approval.request({
      agent,
      toolName: exec.name,
      callId: exec.callId,
      reason:
        `❄ 冻结点：阶段 ${active.stage.id} 步骤 ${active.step.id}（${active.step.title}）`
        + '需主会话人工确认后方可继续。',
      signal: exec.signal,
    })

    // Fail closed on everything but a one-shot grant. `unavailable` (no answerer) and
    // `rejected`/`cancelled` all stop the call: an unattended session must not sign itself.
    if (outcome !== 'allowed-once') {
      return {
        kind: 'deny',
        reason: `冻结点未获人工确认（${String(outcome)}）：${active.stage.id}/${active.step.id}`,
      }
    }
    return next()
  })
}
