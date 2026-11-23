/**
 * The gate-script route of the stage gate, driven through a controlled child
 * process.
 *
 * `runGateScript` owns three ways a script can fail to answer: a spawn error, a
 * deadline, and a signal-killed close with no code. All three must close the
 * gate — a script that cannot answer is a failure, never a pass — and framing
 * them against a real `python3` would make the suite depend on a Python being
 * installed and on a child actually hanging. The spawn is therefore replaced,
 * and what is asserted is the gate's route on each `rc` rather than the child's
 * behaviour.
 * @module
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * One scripted child: the `error`/`close` events it will emit, and the code it
 * closes with. `kill()` is recorded so the deadline route is observable.
 */
class FakeChild extends EventEmitter {
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

const children: FakeChild[] = []
/** How the next spawned child should settle. */
let scripted: 'error' | 'timeout' | 'signal' | 'zero' = 'zero'

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new FakeChild()
    children.push(child)
    // Emitted on a later turn so the listener registrations in `runGateScript`
    // are in place, exactly as a real child would be.
    queueMicrotask(() => {
      if (scripted === 'error') child.emit('error', new Error('spawn python3 ENOENT'))
      else if (scripted === 'signal') child.emit('close', null)
      else if (scripted === 'zero') child.emit('close', 0)
      // 'timeout' emits nothing: the deadline in `runGateScript` must fire.
    })
    return child
  },
}))

import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import type { YxspecStage } from '@deepseek-ai/dsh-yxspec'
import { YxspecArtifactLedger } from '@deepseek-ai/dsh-yxspec-artifact'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as yxspecGate from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

beforeEach(() => {
  children.length = 0
  scripted = 'zero'
})

/** The frozen input a gated step needs, so the script route is what decides. */
const FROZEN = 'project/inputs/extracted/swe-arch/baseline-modules.json'

/** One step that is a ❄ point and declares a gate script. */
const STAGES: YxspecStage[] = [{
  id: 'swe-arch',
  title: '软件架构设计',
  aspice: 'SWE.2',
  group: 'design',
  steps: [{
    id: 'freeze', cell: '03.md', title: '❄ 映射冻结', frozen: true,
    requiredInputs: [FROZEN], gateScript: 'scripts/gate.py',
  }],
}]

const probe = defineTool({
  name: 'probe',
  description: 'probe',
  parameters: {},
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    return 'ran'
  },
})

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

/** Mount the pipeline over a workspace whose one gated input has landed. */
async function harness(gateTimeoutMs?: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-gate-script-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project', 'inputs', 'extracted', 'swe-arch'), { recursive: true })
  await writeFile(join(root, FROZEN), '{}', 'utf8')
  await mkdir(join(root, 'scripts'), { recursive: true })
  await writeFile(join(root, 'scripts', 'gate.py'), 'print("gate")\n', 'utf8')

  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
  const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
  cleanups.push(() => ledgerFiber.dispose())
  ctx.tools.register(probe)
  const fiber = await ctx.plugin(yxspecGate, {
    runGateScripts: true,
    ...gateTimeoutMs === undefined ? {} : { gateTimeoutMs },
  })
  cleanups.push(() => fiber.dispose())

  const agent = fakeAgent()
  ctx.yxspec.setActiveStep(agent, 'freeze')
  return { ctx, agent }
}

/** Drive one call through the real pipeline and report the gate's decision. */
async function call(ctx: Context, agent: Agent) {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: brandString<ToolCallId>(`script-${callSeq++}`),
    name: 'probe',
    arguments: {},
    agent,
  })
  return { isError: result.isError, text: JSON.stringify(result.content) }
}

describe('gate script verdicts', () => {
  it('passes when the script exits zero', async () => {
    scripted = 'zero'
    const { ctx, agent } = await harness()
    expect((await call(ctx, agent)).isError).toBe(false)
  })

  it('closes the gate when the script cannot be spawned', async () => {
    scripted = 'error'
    const { ctx, agent } = await harness()
    const { isError, text } = await call(ctx, agent)
    expect(isError).toBe(true)
    // A spawn failure reports rc=127, which is what the reason carries.
    expect(text).toContain('127')
  })

  it('closes the gate when the script is killed by a signal, leaving no code', async () => {
    scripted = 'signal'
    const { ctx, agent } = await harness()
    const { isError, text } = await call(ctx, agent)
    expect(isError).toBe(true)
    expect(text).toContain('rc=1')
  })

  it('closes the gate when the script exceeds its deadline, and kills it', async () => {
    scripted = 'timeout'
    const { ctx, agent } = await harness(1)
    const { isError, text } = await call(ctx, agent)
    expect(isError).toBe(true)
    // A gate that cannot answer in budget reports 124 rather than hanging.
    expect(text).toContain('124')
    expect(children).toHaveLength(1)
    expect(children[0]?.killed).toBe(true)
  })

  it('runs the script with the workspace root as its working directory', async () => {
    scripted = 'zero'
    const { ctx, agent } = await harness()
    await call(ctx, agent)
    expect(children).toHaveLength(1)
  })
})
