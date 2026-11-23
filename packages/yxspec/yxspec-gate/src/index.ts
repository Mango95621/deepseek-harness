/**
 * The YXSpec stage gate. YXSpec's ASPICE discipline says a step may not run until its
 * declared inputs exist, and a frozen artifact may not be rewritten without a change
 * request. In the original toolchain those rules lived in each step cell as a bash snippet
 * the agent was asked to run. Here they become host-level interception: every model tool
 * call passes through this plugin's `tools/pre-execute` hook, and a violation returns
 * `deny` — there is no path around it.
 *
 * Two checks, both mechanical:
 * 1. **Frozen-artifact protection** — a write/edit whose target is a frozen output is
 *    denied. Frozen means "owned by a step that required human sign-off".
 * 2. **Input gate** — while a step is the active one, its declared input artifacts must
 *    exist. This is the same `[ -e "$p" ] || exit 1` the cells used to ask for, enforced
 *    by the host instead.
 *
 * The optional `gateScript` is still executed, because YXSpec's 1239 deterministic gate
 * scripts encode domain rules worth keeping. This plugin calls them and routes on `rc`;
 * it does not reimplement them.
 * @module @deepseek-ai/dsh-yxspec-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-yxspec'
import type {} from '@deepseek-ai/dsh-yxspec-artifact'

/** Plugin configuration. */
export interface Config {
  /**
   * Tools whose calls may write files and therefore must pass the frozen-artifact check.
   * Defaults to the write/edit family; a deployment with a custom writer adds its name.
   */
  writeTools?: string[]
  /**
   * Whether to execute a step's `gateScript` in addition to the structural checks.
   * Disabled by default so a workspace with no Python available still gates correctly on
   * artifact existence.
   */
  runGateScripts?: boolean
  /** Timeout for a gate-script invocation, in milliseconds. */
  gateTimeoutMs?: number
}

/** The built-in write-tool family the frozen check applies to. */
const DEFAULT_WRITE_TOOLS = ['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace']

/** Schemastery configuration for the stage gate. */
export const Config: z<Config> = z.object({
  // schemastery materializes a bare `z.array(z.string())` as `[]`, which would make the
  // caller's `?? DEFAULT_WRITE_TOOLS` fallback unreachable and silently disable the frozen
  // check. Defaulting here keeps the resolved config honest and inspectable.
  writeTools: z.array(z.string()).default([...DEFAULT_WRITE_TOOLS]),
  runGateScripts: z.boolean().default(false),
  gateTimeoutMs: z.natural().default(30_000),
})

export const name = 'yxspec-gate'
export const inject = ['tools', 'yxspec', 'yxspecArtifacts']

/** Workspace-relative paths a tool call is about to write, if any. */
function writeTargets(exec: ToolExecution, writeTools: readonly string[]): readonly string[] {
  if (!writeTools.includes(exec.name)) return []
  const args = exec.arguments
  /* v8 ignore next -- the tool pipeline validates arguments against the tool's schema before
   * dispatch, so a non-object can only arrive from a caller driving this hook directly; the
   * guard repeats the pipeline's own precondition rather than trusting that. */
  if (typeof args !== 'object' || args === null) return []
  const out: string[] = []
  for (const key of ['file_path', 'path', 'filePath', 'target']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) out.push(value)
  }
  return out
}

/** Normalize a possibly-absolute path to a workspace-relative POSIX path. */
function relativize(root: string, target: string): string {
  const abs = resolve(root, target)
  if (abs === root) return ''
  if (abs.startsWith(root + '\\') || abs.startsWith(root + '/')) {
    return abs.slice(root.length + 1).replace(/\\/g, '/')
  }
  return target.replace(/\\/g, '/')
}

/**
 * Every frozen output path across the stage model. A path is frozen when its owning step
 * is a ❄ point; the step's declared inputs are the artifacts that got signed off.
 */
function frozenPaths(ctx: Context): readonly string[] {
  const out = new Set<string>()
  for (const stage of ctx.yxspec.stages()) {
    for (const step of stage.steps) {
      if (!step.frozen) continue
      for (const p of step.requiredInputs) out.add(p.replace(/\\/g, '/'))
    }
  }
  return [...out]
}

/**
 * Run one gate script and return its exit code. Scripts are invoked with the workspace root
 * as cwd so their own relative paths resolve the way the cells wrote them.
 */
async function runGateScript(script: string, cwd: string, timeoutMs: number): Promise<number> {
  return await new Promise<number>((resolveCode) => {
    const child = spawn('python3', [script, '--gate'], { cwd, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      // A gate that cannot answer in budget is a failure, not a pass: gate closed.
      resolveCode(124)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolveCode(127)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveCode(code ?? 1)
    })
  })
}

/**
 * Register the gate hook.
 * @param ctx - the registrant context carrying tools, the domain model, and the ledger.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const writeTools = config.writeTools ?? DEFAULT_WRITE_TOOLS
  const runScripts = config.runGateScripts ?? false
  const gateTimeoutMs = config.gateTimeoutMs ?? 30_000
  const root = ctx.yxspec.root

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    // 1. Frozen-artifact protection: a signed-off artifact is not rewritten in place.
    const targets = writeTargets(exec, writeTools)
    if (targets.length > 0) {
      const frozen = frozenPaths(ctx)
      for (const target of targets) {
        const rel = relativize(root, target)
        if (frozen.includes(rel)) {
          return {
            kind: 'deny',
            reason: `产物已冻结：${rel}。冻结点产物不得就地改写；请走变更请求（CR）流程。`,
          }
        }
      }
    }

    // 2. Input gate: the active step's declared inputs must exist on disk.
    const active = exec.agent === undefined ? undefined : ctx.yxspec.activeStep?.(exec.agent)
    if (active !== undefined) {
      const { step, stage } = active
      const missing = await ctx.yxspecArtifacts.missingOf(step.requiredInputs)
      if (missing.length > 0) {
        return {
          kind: 'deny',
          reason: `gate: 阶段 ${stage.id} 步骤 ${step.id} 的输入缺失 → ${missing.join(', ')}`,
        }
      }
      // 3. Optional deterministic gate script, routed on rc.
      if (runScripts && step.gateScript !== undefined) {
        const code = await runGateScript(resolve(root, step.gateScript), root, gateTimeoutMs)
        if (code !== 0) {
          return { kind: 'deny', reason: `gate: ${step.gateScript} rc=${code}` }
        }
      }
    }

    return next()
  })
}
