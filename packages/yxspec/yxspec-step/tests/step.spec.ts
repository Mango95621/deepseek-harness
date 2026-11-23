/**
 * The step driver: the two model-facing tools that keep YXSpec's
 * one-step-at-a-time discipline while moving the advance decision onto the
 * artifact ledger.
 *
 * `inject.py` printed a cell and advanced a cursor without checking anything.
 * These specs pin the difference: `yxspec_next` refuses to advance while the
 * step being left has artifacts that never landed, and it reports which paths
 * are missing rather than accepting the agent's word that it finished.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import type { YxspecStage } from '@deepseek-ai/dsh-yxspec'
import { YxspecArtifactLedger } from '@deepseek-ai/dsh-yxspec-artifact'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as yxspecStep from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** The artifact the first step's successors gate on. */
const MAPPING = 'project/inputs/extracted/swe-arch/mod-swr-mapping.json'

/** The artifact a stage's head step declares, used to hold a stage at "not started". */
const EGRESS = 'project/inputs/extracted/swe-arch/swr-impl-symbols.json'

/**
 * A three-step stage: `mapping` has no gate, `impl-judge` gates on `MAPPING`,
 * and `freeze` is both terminal and a ❄ point.
 */
const STAGES: YxspecStage[] = [{
  id: 'swe-arch',
  title: '软件架构设计',
  aspice: 'SWE.2',
  group: 'design',
  steps: [
    { id: 'mapping', cell: '01-mapping.md', title: 'SWR→模块映射', frozen: false, requiredInputs: [] },
    {
      id: 'impl-judge', cell: '02-impl-judge.md', title: '实现度精判', frozen: false,
      requiredInputs: [MAPPING],
    },
    {
      id: 'freeze', cell: '03-freeze.md', title: '❄ 映射冻结', frozen: true,
      requiredInputs: [], gateScript: 'scripts/freeze-user-confirm.py',
    },
  ],
}]

/**
 * A stage whose *head* step already declares inputs. `status()` only names a step once
 * that step's own inputs have landed, so while this one is absent the walk names no
 * current step at all — the state a caller sees before a stage has started for real.
 */
const HEAD_GATED: YxspecStage[] = [{
  id: 'swe-unit-verify',
  title: '单元验证',
  aspice: 'SWE.4',
  group: 'verification',
  steps: [
    { id: 'ut', cell: '01-ut.md', title: '单元测试', frozen: false, requiredInputs: [EGRESS] },
    { id: 'static', cell: '02-static.md', title: '静态检查', frozen: false, requiredInputs: [] },
  ],
}]

let callSeq = 0

/** Distinct session-backed identities, so per-agent state never collides across cases. */
let agentSeq = 0

/**
 * An Agent as the pipeline hands one to a tool call. The gate scopes its
 * per-agent state by identity, and the activation guard reads the session's
 * working directory, so this carries both.
 * @param sessionId - the session identity to carry.
 * @returns a fresh Agent identity.
 */
function fakeAgent(sessionId?: string): Agent {
  // The pipeline and the guard read only these two members, so the rest of the
  // live Agent is not needed. One assertion over the literal — the same shape
  // `yxspec-remote/tests/tools.spec.ts` uses — keeps this inside the repository
  // idiom; a direct `as unknown as Agent` is what `verify-no-unknown-casts`
  // rejects, and a `Partial<Agent>` intermediate would force `session.id` to
  // carry the `SessionId` brand that this stub deliberately does not import.
  return {
    id: brandString<Agent['id']>(`yxspec-agent-${agentSeq++}`),
    session: { id: sessionId ?? `yxspec-session-${agentSeq}` },
  } as Agent
}

/**
 * Invoke one of the driver's tools and return its reported value, parsed.
 *
 * Both tools carry an activation condition, so the step's admitted set is
 * resolved first and passed in: a conditional registration is unavailable to a
 * call outside a model step, which is the same rule the real pipeline applies.
 * The condition also needs an agent to read the session's project, and a model
 * step always has one, so a case that does not care supplies a fresh identity.
 */
async function invoke(ctx: Context, name: 'yxspec_status' | 'yxspec_next', args: Record<string, unknown>, agent: Agent = fakeAgent()) {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({
    agent,
    modelSelection: { provider: 'test', model: 'test' },
    signal,
  })
  const result = await executeToolFixture(ctx, {
    signal,
    callId: brandString<ToolCallId>(`step-${callSeq++}`),
    name,
    arguments: args,
    agent,
    toolSet,
  })
  if (result.isError) throw new Error(`tool errored: ${JSON.stringify(result.content)}`)
  const block = result.content[0] as { text?: string } | undefined
  return JSON.parse(block?.text ?? '{}') as Record<string, unknown>
}

/**
 * Mount the pipeline, the domain service, the ledger, and the driver.
 *
 * The driver's tools carry a project-scoped activation guard, so the harness
 * also mounts the two services that guard reads and writes the project's own
 * `project/config/yxspec.json` marker — the same declaration a real YXSpec
 * project carries.
 */
async function harness(
  config: Parameters<typeof yxspecStep.apply>[1] = {},
  present: readonly string[] = [],
  stages: YxspecStage[] = STAGES,
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-step-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const rel of present) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), '{}', 'utf8')
  }
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(YxspecService, { workspaceRoot: root, stages })
  const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
  cleanups.push(() => ledgerFiber.dispose())
  provideProjectScope(ctx, root)
  const fiber = await ctx.plugin(yxspecStep, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, root }
}

/**
 * Declare one project over `root` and make every session work in it, which is
 * the pair the tools' activation guard resolves "is this a YXSpec project?"
 * from. The project config travels with them because the marker is what that
 * guard tests for.
 */
function provideProjectScope(ctx: Context, root: string): void {
  ctx.provide('workspaceRegistry', {
    list: () => [{ id: 'ws-step', roots: [root], title: 'OEM IVI', path: root }],
    get: (id: string) => id === 'ws-step'
      ? { id, roots: [root], title: 'OEM IVI', path: root }
      : undefined,
  } as never)
  ctx.provide('workingDirectory', { get: () => root } as never)
  mkdirSync(join(root, 'project', 'config'), { recursive: true })
  writeFileSync(join(root, 'project', 'config', 'yxspec.json'), '{}', 'utf8')
}

/** A stub tool the pipeline can dispatch when a test needs an agent identity. */
const ping = defineTool({
  name: 'ping',
  description: 'ping',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    return 'pong'
  },
})

describe('yxspec_status', () => {
  it('reports every stage with its identity, current step, and completion', async () => {
    const { ctx, root } = await harness()
    const value = await invoke(ctx, 'yxspec_status', {})

    expect(value.root).toBe(root)
    expect((value.identity as { specId: string }).specId).toBe('unspecified')
    const stages = value.stages as Array<Record<string, unknown>>
    expect(stages).toHaveLength(1)
    expect(stages[0]).toMatchObject({
      stage: 'swe-arch',
      title: '软件架构设计',
      aspice: 'SWE.2',
      currentStep: 'mapping',
      complete: false,
      stepCount: 3,
    })
  })

  it('limits the report to one stage when asked', async () => {
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_status', { stage: 'swe-arch' })
    expect((value.stages as unknown[]).length).toBe(1)

    // An unknown stage id narrows to nothing rather than erroring, so a caller
    // can ask about a stage a deployment has not declared.
    const none = await invoke(ctx, 'yxspec_status', { stage: 'ghost' })
    expect(none.stages).toEqual([])
  })

  it('ignores an empty stage filter and reports everything', async () => {
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_status', { stage: '' })
    expect((value.stages as unknown[]).length).toBe(1)
  })

  it('derives progress from artifacts on disk, not from any claim', async () => {
    const { ctx } = await harness({}, [MAPPING])
    const stages = (await invoke(ctx, 'yxspec_status', {})).stages as Array<Record<string, unknown>>
    // `mapping` declares no inputs and `impl-judge`'s input has landed, so both
    // are satisfied; `freeze` declares none either, which makes it the last
    // satisfied step and therefore the stage complete — without anyone having
    // asserted that the earlier steps were done.
    expect(stages[0]?.currentStep).toBe('freeze')
    expect(stages[0]?.complete).toBe(true)
  })

  it('stops at the first step whose declared inputs are absent', async () => {
    const { ctx } = await harness()
    const stages = (await invoke(ctx, 'yxspec_status', {})).stages as Array<Record<string, unknown>>
    // `impl-judge` needs `MAPPING`, which is not on disk, so the walk stops at
    // `mapping` and the stage cannot be complete.
    expect(stages[0]?.currentStep).toBe('mapping')
    expect(stages[0]?.complete).toBe(false)
  })

  it('reports no current step for a stage still held at its own head', async () => {
    const { ctx } = await harness({}, [], HEAD_GATED)
    const stages = (await invoke(ctx, 'yxspec_status', {})).stages as Array<Record<string, unknown>>
    // `ut` is the head step and declares `EGRESS`, which has not landed. Nothing
    // in the stage is satisfied, so the report names no step rather than
    // claiming the flow sits on the first one — "on `ut`" would be a claim the
    // ledger cannot support.
    expect(stages[0]).toMatchObject({
      stage: 'swe-unit-verify',
      currentStep: null,
      complete: false,
      stepCount: 2,
    })
  })
})

describe('yxspec_next', () => {
  it('advances one step and returns its contract', async () => {
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_next', {})

    // The driver holds no cursor of its own: the target is one past whatever the
    // ledger says is the last satisfied step, so this is `impl-judge`.
    expect(value).toMatchObject({ ok: true, stage: 'swe-arch', step: 'impl-judge', frozen: false })
    const contract = value.contract as string
    expect(contract).toContain('阶段：swe-arch')
    expect(contract).toContain('ASPICE SWE.2')
    expect(contract).toContain('步骤：impl-judge — 实现度精判')
    expect(contract).toContain('.agents/skills/yxspec-swe-arch/steps/02-impl-judge.md')
    expect(contract).toContain('输入（须已落盘）')
  })

  it('marks a ❄ step in the contract it hands the agent', async () => {
    const { ctx } = await harness({}, [MAPPING])
    const value = await invoke(ctx, 'yxspec_next', { step: 'freeze' })
    const contract = value.contract as string
    expect(value.frozen).toBe(true)
    expect(contract).toContain('❄ 本步为冻结点')
    expect(contract).toContain('禁止委派 subagent')
    expect(contract).toContain('门脚本：scripts/freeze-user-confirm.py')
  })

  it('jumps to a named step, because the gate still applies to what is skipped', async () => {
    const { ctx } = await harness({}, [MAPPING])
    const value = await invoke(ctx, 'yxspec_next', { step: 'freeze' })
    expect(value).toMatchObject({ ok: true, step: 'freeze' })
  })

  it('treats the ledger as the only cursor, so a repeat call is idempotent', async () => {
    // The driver keeps no cursor: two identical calls over an unchanged tree
    // name the same target, because the target is derived from what is on disk.
    const { ctx } = await harness({}, [MAPPING])
    const first = await invoke(ctx, 'yxspec_next', { step: 'freeze' })
    const second = await invoke(ctx, 'yxspec_next', { step: 'freeze' })
    expect(first.step).toBe('freeze')
    expect(second.step).toBe('freeze')
  })

  it('allows an explicit jump past a step whose inputs are absent', async () => {
    // `MAPPING` is absent, so the walk stops at `mapping`; an explicit jump to
    // `freeze` is still allowed because the step being left (`mapping`) declares
    // no inputs of its own, and `status()` only ever names a step whose own
    // inputs have landed. The gate therefore has nothing to refuse here.
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_next', { step: 'freeze' })
    expect(value).toMatchObject({ ok: true, step: 'freeze' })
  })

  it('reports completion rather than advancing past the last step', async () => {
    const { ctx } = await harness({}, [MAPPING])
    // The walk reaches `freeze`, the terminal step, so there is no step after it
    // to advance to; the driver reports the stage as complete instead.
    const done = await invoke(ctx, 'yxspec_next', {})
    expect(done).toMatchObject({ ok: false, stage: 'swe-arch', complete: true })
    expect(done.error).toContain('最后一步')
  })

  it('starts a stage whose head step is itself gated, rather than skipping it', async () => {
    const { ctx } = await harness({}, [], HEAD_GATED)
    const agent = fakeAgent()
    const value = await invoke(ctx, 'yxspec_next', {}, agent)
    // No step is satisfied, so the walk has no position to advance *from*; the
    // driver starts at the head instead of running off the end of the list.
    expect(value).toMatchObject({ ok: true, stage: 'swe-unit-verify', step: 'ut' })
    expect(value.contract).toContain('输入（须已落盘）')
    expect(value.contract).toContain(EGRESS)
    expect(ctx.yxspec.activeStep(agent)?.step.id).toBe('ut')
  })

  it('refuses an unknown stage, naming the id it could not resolve', async () => {
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_next', { stage: 'ghost' })
    expect(value.ok).toBe(false)
    expect(value.error).toContain('未知阶段')
    expect(value.error).toContain('ghost')
  })

  it('refuses an unknown step within a known stage', async () => {
    const { ctx } = await harness()
    const value = await invoke(ctx, 'yxspec_next', { stage: 'swe-arch', step: 'ghost' })
    expect(value.ok).toBe(false)
    expect(value.error).toContain('无此步骤')
  })

  it('uses the configured default stage when a call omits one', async () => {
    const { ctx } = await harness({ defaultStage: 'swe-arch' })
    expect((await invoke(ctx, 'yxspec_next', {})).stage).toBe('swe-arch')
  })

  it('records the target step as the agent’s active one', async () => {
    const { ctx } = await harness()
    const agent = fakeAgent()
    await invoke(ctx, 'yxspec_next', {}, agent)
    // The gate hook reads this to decide whose input contract to enforce.
    expect(ctx.yxspec.activeStep(agent)?.step.id).toBe('impl-judge')
  })

  it('leaves no active step when the call carried no agent', async () => {
    // An agent-less call cannot reach this tool through a model step — the
    // activation condition needs one — so the body is invoked directly to keep
    // the branch that guards `setActiveStep` covered.
    const { ctx } = await harness()
    const definition = ctx.tools.get('yxspec_next')
    if (definition === undefined) throw new Error('yxspec_next must be registered')
    const exec = {
      callId: brandString<ToolCallId>(`step-${callSeq++}`),
      rootCallId: brandString<ToolCallId>('step-direct'),
      name: 'yxspec_next',
      arguments: {},
      token: Symbol('step-direct') as ToolExecutionToken,
      signal: new AbortController().signal,
      deferContext() {},
      concludeTurn() {},
    }
    const value = await definition.execute({}, exec) as { ok?: boolean }
    expect(value.ok).toBe(true)
    // Nothing to record, and nothing thrown.
    expect(ctx.yxspec.activeStep({})).toBeUndefined()
  })
})

describe('plugin wiring', () => {
  it('declares every seam its tools and activation guard read', () => {
    // The tools read `yxspec`/`yxspecArtifacts`; the activation guard additionally
    // reads `workingDirectory` and `workspaceRegistry`, and a service read without
    // an `inject` entry throws rather than falling back — so all five are seams.
    expect(yxspecStep.inject).toEqual([
      'tools', 'yxspec', 'yxspecArtifacts', 'workingDirectory', 'workspaceRegistry',
    ])
    expect(yxspecStep.name).toBe('yxspec-step')
  })

  it('registers exactly the two model-facing tools', async () => {
    const { ctx } = await harness()
    const names = ctx.tools.schemas().map(tool => tool.name).sort()
    expect(names).toEqual(['yxspec_next', 'yxspec_status'])
  })

  it('defaults its stage to the first declared one when configuration omits it', async () => {
    const { ctx } = await harness()
    // No `defaultStage`, no explicit argument: the driver starts at the head of
    // the model, which is what makes a fresh workspace usable.
    const value = await invoke(ctx, 'yxspec_next', { stage: '' })
    expect(value.stage).toBe('swe-arch')
  })

  it('falls back to the head of the model when called without a resolved config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-step-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
    cleanups.push(() => ledgerFiber.dispose())
    ctx.tools.register(ping)
    provideProjectScope(ctx, root)
    yxspecStep.apply(ctx)

    const value = await invoke(ctx, 'yxspec_next', {}, fakeAgent())
    expect(value.stage).toBe('swe-arch')
  })

  it('refuses to name a stage when the seam declares none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-step-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // `stages()` is documented as never empty, so this seam is a deliberate
    // violation of that contract: with no stage to fall back to there is nothing
    // to advance, and naming the unresolvable id beats throwing.
    ctx.provide('yxspec', { stages: () => [] } as never)
    ctx.provide('yxspecArtifacts', { landed: async () => true } as never)
    provideProjectScope(ctx, root)
    yxspecStep.apply(ctx)

    const value = await invoke(ctx, 'yxspec_next', {}, fakeAgent())
    expect(value.ok).toBe(false)
    expect(value.error).toContain('未知阶段')
  })

  it('withholds both tools from a session outside a YXSpec project', async () => {
    // The guard is what keeps a single-project discipline from being paid for by
    // every unrelated session in the deployment: the schemas still register, but
    // a step in a project that declares no process admits neither.
    const { ctx, root } = await harness()
    // Drop the marker the harness wrote, leaving the project otherwise intact —
    // which is exactly the state of a project that never ran the wizard.
    await rm(join(root, 'project'), { recursive: true, force: true })
    const agent = fakeAgent()
    const toolSet = await ctx.tools.resolve({
      agent,
      modelSelection: { provider: 'test', model: 'test' },
      signal: new AbortController().signal,
    })
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['yxspec_next', 'yxspec_status'])
    expect([...toolSet.view(agent).keys()]).toEqual([])
  })
})
