/**
 * The freeze point: an ASPICE ❄ step must be confirmed by a human in the main
 * session, and the rule lives in the host rather than in the cells' prose.
 *
 * The failure mode is the point of this plugin, so the specs are written around
 * the answers `ctx.approval` can give. `unavailable` — the answer a waterfall
 * with nobody at the keyboard settles — must stop the call exactly as a
 * rejection does; a plugin that only denied an explicit `rejected` would let an
 * unattended flow sign itself off, which is the behaviour ASPICE forbids.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import type { YxspecStage } from '@deepseek-ai/dsh-yxspec'
import { YxspecArtifactLedger } from '@deepseek-ai/dsh-yxspec-artifact'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as yxspecFreeze from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A stage whose middle step is the ❄ point under test. */
const STAGES: YxspecStage[] = [{
  id: 'swe-arch',
  title: '软件架构设计',
  aspice: 'SWE.2',
  group: 'design',
  steps: [
    { id: 'mapping', cell: '01.md', title: 'SWR→模块映射', frozen: false, requiredInputs: [] },
    { id: 'freeze', cell: '03.md', title: '❄ 映射冻结', frozen: true, requiredInputs: [] },
  ],
}]

/** The calls whose names the freeze hook guards. */
function guardTool(name: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      return `${name} ran`
    },
  })
}

let callSeq = 0

/** Distinct session-backed identities, so per-agent state never collides across cases. */
let agentSeq = 0

/**
 * An Agent as the pipeline hands one to a tool call. The gate only needs an
 * identity to scope its per-agent state, so a real one is built from its id
 * rather than asserted into shape.
 * @returns a fresh Agent identity.
 */
function fakeAgent(): Agent {
  // The pipeline only ever reads the identity, so the rest of the live Agent
  // is not needed; a single assertion matches the repository's test idiom.
  return { id: brandString<Agent['id']>(`yxspec-agent-${agentSeq++}`) } as Agent
}

/** Drive one call through the real pipeline and report what the tools saw. */
async function call(ctx: Context, name: string, agent?: Agent) {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: brandString<ToolCallId>(`freeze-${callSeq++}`),
    name,
    arguments: {},
    ...agent === undefined ? {} : { agent },
  })
  return { isError: result.isError, text: JSON.stringify(result.content) }
}

/**
 * Mount the pipeline, the domain service, and the freeze hook, with the approval
 * answer scripted.
 *
 * `seen` collects the requests the hook handed the approval seam, so a spec can
 * assert the reason the user would be shown rather than only the decision.
 */
async function harness(
  answer: ApprovalOutcome | 'none',
  config: Parameters<typeof yxspecFreeze.apply>[1] = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-freeze-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const seen: { reason?: string; toolName?: string }[] = []
  ctx.provide('approval', {
    request: async (request: { reason?: string; toolName?: string }) => {
      seen.push(request)
      if (answer === 'none') throw new Error('unavailable')
      return answer
    },
  } as never)
  await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
  const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
  cleanups.push(() => ledgerFiber.dispose())

  await mkdir(join(root, 'project'), { recursive: true })
  await writeFile(join(root, 'project', 'landed.json'), '{}', 'utf8')

  for (const name of ['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'bash', 'read']) {
    ctx.tools.register(guardTool(name))
  }
  const fiber = await ctx.plugin(yxspecFreeze, config)
  cleanups.push(() => fiber.dispose())

  return { ctx, root, seen }
}

describe('freeze confirmation', () => {
  it('denies a guarded call on a frozen step until the user allows it once', async () => {
    const { ctx } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'write', agent)
    expect(isError).toBe(true)
    expect(text).toContain('冻结点未获人工确认')
    expect(text).toContain('swe-arch/freeze')
  })

  it('lets the call proceed on a one-shot grant', async () => {
    const { ctx } = await harness('allowed-once')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'write', agent)
    // Reaching the tool's own output is the proof the hook returned `next()`
    // rather than a denial; a denied call never runs the tool body.
    expect(isError).toBe(false)
    expect(text).toContain('write ran')
  })

  it('fails closed when no answerer owns the request', async () => {
    // The load-bearing case: an unattended flow must stop rather than sign
    // itself off, and `unavailable` is the answer a waterfall with nobody at
    // the keyboard settles.
    const { ctx } = await harness('none')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'write', agent)
    expect(isError).toBe(true)
    expect(text).toContain('unavailable')
  })

  it('passes through a call on a step that is not a freeze point', async () => {
    const { ctx } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'mapping')
    expect((await call(ctx, 'write', agent)).isError).toBe(false)
  })

  it('passes through a call from an agent with no active step', async () => {
    const { ctx } = await harness('rejected')
    expect((await call(ctx, 'write', fakeAgent())).isError).toBe(false)
    // A call carrying no agent at all is likewise unguarded.
    expect((await call(ctx, 'write')).isError).toBe(false)
  })

  it('guards the whole writing family plus the shell', async () => {
    const { ctx } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    for (const name of ['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace', 'bash']) {
      expect((await call(ctx, name, agent)).isError, name).toBe(true)
    }
  })

  it('leaves a tool outside the guarded family alone', async () => {
    const { ctx } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    // `read` cannot produce a signed-off artifact, so freezing it would stop
    // the operator from reading the very file being confirmed.
    expect((await call(ctx, 'read', agent)).isError).toBe(false)
  })

  it('honours a deployment-supplied guarded-tool list', async () => {
    const { ctx } = await harness('rejected', { guardedTools: ['read'] })
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    expect((await call(ctx, 'read', agent)).isError).toBe(true)
    // The built-in family is replaced, not extended.
    expect((await call(ctx, 'write', agent)).isError).toBe(false)
  })

  it('asks the user with a reason naming the stage, the step, and its title', async () => {
    const { ctx, seen } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')

    await call(ctx, 'write', agent)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolName).toBe('write')
    expect(seen[0]?.reason).toContain('❄')
    expect(seen[0]?.reason).toContain('swe-arch')
    expect(seen[0]?.reason).toContain('映射冻结')
  })
})

describe('disablement and wiring', () => {
  it('reverts to prose-only enforcement when the hook is disabled', async () => {
    const { ctx } = await harness('rejected', { enabled: false })
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    expect((await call(ctx, 'write', agent)).isError).toBe(false)
  })

  it('declares the three seams its hook reads', () => {
    expect(yxspecFreeze.inject).toEqual(['tools', 'yxspec', 'approval'])
    expect(yxspecFreeze.name).toBe('yxspec-freeze')
  })

  it('defaults the guarded family and the enabled flag through its schema', async () => {
    // A bare `z.array` resolves to `[]`, which would make the `??` fallback
    // unreachable and silently exempt every tool; the schema default is what
    // keeps the fail-closed behaviour intact.
    expect(yxspecFreeze.Config).toBeDefined()
    const { ctx } = await harness('rejected')
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    expect((await call(ctx, 'bash', agent)).isError).toBe(true)
  })

  it('falls back to its own defaults when called without a resolved config', async () => {
    // `apply` is exported and may be invoked directly, so every `??` needs a
    // real default rather than relying on schemastery having run.
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-freeze-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('approval', {
      request: async () => 'rejected' as ApprovalOutcome,
    } as never)
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    ctx.tools.register(guardTool('write'))
    yxspecFreeze.apply(ctx)

    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    // The built-in guarded family and `enabled` both apply.
    const decision = await call(ctx, 'write', agent)
    expect(decision.isError).toBe(true)
  })
})
