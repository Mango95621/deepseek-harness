/**
 * The YXSpec stage gate: the two structural checks that decide whether a model
 * tool call may proceed — frozen-artifact protection and the active step's input
 * gate — plus the optional deterministic gate script routed on `rc`.
 *
 * These specs drive a real tool pipeline rather than the hook in isolation: the
 * plugin's own contribution is a `tools/pre-execute` listener, so mounting it
 * beside a real registry and executing a call is the only way to observe the
 * decision the way a session does. Both checks read live state, so the workspace
 * and the artifact ledger are real too.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
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

/** The frozen output the gate protects, and the input the last step needs. */
const FROZEN = 'project/inputs/extracted/swe-arch/baseline-modules.json'
const INPUT = 'project/inputs/extracted/swe-arch/mod-swr-mapping.json'

/**
 * A stage whose middle step is a ❄ point and whose last step gates on `INPUT`,
 * so one stage exercises both the frozen check and the input gate.
 */
const STAGES: YxspecStage[] = [{
  id: 'swe-arch',
  title: '软件架构设计',
  aspice: 'SWE.2',
  group: 'design',
  steps: [
    { id: 'mapping', cell: '01.md', title: 'SWR→模块映射', frozen: false, requiredInputs: [] },
    {
      id: 'freeze',
      cell: '03.md',
      title: '❄ 映射冻结',
      frozen: true,
      requiredInputs: [FROZEN],
      gateScript: 'scripts/gate.py',
    },
    { id: 'docgen', cell: '05.md', title: '架构文档生成', frozen: false, requiredInputs: [INPUT] },
  ],
}]

/** A registered tool that echoes, so a gate decision is the only variable. */
const probe = defineTool({
  name: 'probe',
  description: 'probe',
  parameters: { file_path: { type: 'string' }, path: { type: 'string' } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute() {
    return 'ran'
  },
})

/** A writer tool the frozen check applies to. */
const write = defineTool({
  name: 'write',
  description: 'write',
  parameters: { file_path: { type: 'string' }, path: { type: 'string' } },
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
  return { id: brandString<Agent['id']>(`gate-agent-${agentSeq++}`) } as Agent
}

/**
 * Execute one tool through the real pipeline and report whether the gate let it
 * through. A denied call settles as an error result whose message carries the
 * gate's reason, which is what a session sees.
 */
async function call(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  const result = await executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: brandString<ToolCallId>(`gate-${callSeq++}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return { isError: result.isError, text: JSON.stringify(result.content), result }
}

/** Mount the domain service, the ledger, the tool pipeline, and the gate. */
async function harness(
  config: Parameters<typeof yxspecGate.apply>[1] = {},
  present: readonly string[] = [],
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-gate-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  for (const rel of present) {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), '{}', 'utf8')
  }

  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
  const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
  cleanups.push(() => ledgerFiber.dispose())
  ctx.tools.register(probe)
  ctx.tools.register(write)
  const fiber = await ctx.plugin(yxspecGate, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, root }
}

describe('frozen-artifact protection', () => {
  it('denies a write whose target is a frozen step output', async () => {
    const { ctx } = await harness()
    const { isError, text } = await call(ctx, 'write', { file_path: FROZEN })
    expect(isError).toBe(true)
    expect(text).toContain('产物已冻结')
    // The reason names the escape hatch rather than only the refusal.
    expect(text).toContain('CR')
  })

  it('denies an absolute path that resolves onto the frozen output', async () => {
    const { ctx, root } = await harness()
    expect((await call(ctx, 'write', { path: join(root, FROZEN) })).isError).toBe(true)
  })

  it('checks every argument name a writer may use', async () => {
    const { ctx } = await harness()
    for (const key of ['file_path', 'path', 'filePath', 'target']) {
      expect((await call(ctx, 'write', { [key]: FROZEN })).isError, `argument ${key}`).toBe(true)
    }
  })

  it('allows a write to a path no frozen step owns', async () => {
    const { ctx } = await harness()
    const { isError, result } = await call(ctx, 'write', { file_path: 'src/other.c' })
    expect(isError).toBe(false)
    expect(result.value).toBe('ran')
  })

  it('ignores a tool outside the configured write family', async () => {
    const { ctx } = await harness()
    // `probe` names a frozen path but is not a writer, so the check must not
    // fire; a gate that denied reads would stop the flow dead.
    expect((await call(ctx, 'probe', { file_path: FROZEN })).isError).toBe(false)
  })

  it('honours a deployment-supplied write-tool list', async () => {
    const { ctx } = await harness({ writeTools: ['probe'] })
    expect((await call(ctx, 'probe', { file_path: FROZEN })).isError).toBe(true)
    // The built-in family is replaced, not extended.
    expect((await call(ctx, 'write', { file_path: FROZEN })).isError).toBe(false)
  })

  it('ignores arguments that are absent, empty, or not paths', async () => {
    const { ctx } = await harness()
    for (const args of [{}, { file_path: '' }]) {
      expect((await call(ctx, 'write', args)).isError, JSON.stringify(args)).toBe(false)
    }
  })

  it('treats a target that resolves to the workspace root itself as empty', async () => {
    const { ctx } = await harness()
    // `relativize` answers '' for the root, which matches no frozen entry, so a
    // writer pointed at the root is allowed rather than denied.
    expect((await call(ctx, 'write', { file_path: '.' })).isError).toBe(false)
  })

  it('compares a target outside the workspace by its written spelling', async () => {
    // A target that resolves outside the root is normalized but not rewritten,
    // because the gate can only judge paths it can place under the root. A
    // relative escape therefore matches only a frozen entry spelled the same
    // way, which is what keeps this branch from denying unrelated writes.
    const { ctx } = await harness()
    const { isError } = await call(ctx, 'write', { file_path: '../outside.json' })
    expect(isError).toBe(false)
  })

  it('denies a frozen output spelled with Windows separators', async () => {
    const { ctx } = await harness()
    // The frozen set is normalized to POSIX, so an incoming spelling that only
    // differs by separator must still match rather than slip through.
    expect((await call(ctx, 'write', { file_path: FROZEN.replace(/\//g, '\\') })).isError).toBe(true)
  })
})

describe('input gate', () => {
  it('denies a call while the active step declares inputs that never landed', async () => {
    const { ctx } = await harness()
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'docgen')
    const { isError, text } = await call(ctx, 'probe', {}, agent)
    expect(isError).toBe(true)
    expect(text).toContain(INPUT)
  })

  it('allows the same call once those inputs have landed', async () => {
    const { ctx } = await harness({}, [INPUT])
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'docgen')
    expect((await call(ctx, 'probe', {}, agent)).isError).toBe(false)
  })

  it('exempts a call from an agent with no active step', async () => {
    const { ctx } = await harness()
    expect((await call(ctx, 'probe', {}, fakeAgent())).isError).toBe(false)
    // A call carrying no agent at all is likewise ungated.
    expect((await call(ctx, 'probe', {})).isError).toBe(false)
  })

  it('reports every missing input, not merely the first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-gate-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(YxspecService, {
      workspaceRoot: root,
      stages: [{
        ...STAGES[0]!,
        steps: [{
          id: 'docgen', cell: '05.md', title: '架构文档生成', frozen: false,
          requiredInputs: [INPUT, 'project/inputs/second.json'],
        }],
      }],
    })
    const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
    cleanups.push(() => ledgerFiber.dispose())
    ctx.tools.register(probe)
    const fiber = await ctx.plugin(yxspecGate, {})
    cleanups.push(() => fiber.dispose())

    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'docgen')
    const { text } = await call(ctx, 'probe', {}, agent)
    expect(text).toContain(INPUT)
    expect(text).toContain('second.json')
  })
})

describe('gate scripts', () => {
  it('does not run a declared gate script unless the deployment enables it', async () => {
    const { ctx } = await harness({}, [FROZEN])
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    // The script path does not exist; were it invoked, the spawn would fail and
    // the gate would deny. A pass proves the script was never run.
    expect((await call(ctx, 'probe', {}, agent)).isError).toBe(false)
  })

  it('denies when an enabled gate script exits nonzero', async () => {
    const { ctx } = await harness({ runGateScripts: true }, [FROZEN])
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'probe', {}, agent)
    expect(isError).toBe(true)
    // The script is absent, so the spawn fails and the gate reports rc=127.
    expect(text).toContain('gate.py')
  })

  it('lets a step with no gate script through once its inputs landed', async () => {
    const { ctx } = await harness({ runGateScripts: true }, [INPUT])
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'docgen')
    expect((await call(ctx, 'probe', {}, agent)).isError).toBe(false)
  })

  it('denies when an enabled gate script exits nonzero rather than timing out', async () => {
    // A present script that exits 3 is the ordinary failure; the absent-script
    // case above covers the spawn error, so both `rc` routes are exercised.
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-gate-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await mkdir(join(root, 'project', 'inputs', 'extracted', 'swe-arch'), { recursive: true })
    await writeFile(join(root, FROZEN), '{}', 'utf8')
    await mkdir(join(root, 'scripts'), { recursive: true })
    // Python may be absent on a Windows runner; the script exits nonzero either
    // way, which is the route under test.
    await writeFile(join(root, 'scripts', 'gate.py'), 'import sys\nsys.exit(3)\n', 'utf8')

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
    cleanups.push(() => ledgerFiber.dispose())
    ctx.tools.register(probe)
    const fiber = await ctx.plugin(yxspecGate, { runGateScripts: true })
    cleanups.push(() => fiber.dispose())

    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'probe', {}, agent)
    expect(isError).toBe(true)
    expect(text).toContain('gate.py')
  })
})

describe('plugin wiring', () => {
  it('declares the three seams its hook reads', () => {
    expect(yxspecGate.inject).toEqual(['tools', 'yxspec', 'yxspecArtifacts'])
    expect(yxspecGate.name).toBe('yxspec-gate')
  })

  it('defaults the write family and the script flag through its schema', async () => {
    // The schema defaults are what keep the `??` reads at the hook honest: a
    // bare `z.array` resolves to `[]` and would silently disable the check, and
    // the two remaining fallbacks cover a deployment that configured neither.
    const { ctx } = await harness()
    expect(yxspecGate.Config).toBeDefined()
    expect((await call(ctx, 'write', { file_path: FROZEN })).isError).toBe(true)
    // `runGateScripts` and `gateTimeoutMs` both fall back: with no script route
    // enabled, an active step is decided by its input contract alone — and this
    // step's input never landed, so the input gate is what denies.
    const agent = fakeAgent()
    ctx.yxspec.setActiveStep(agent, 'freeze')
    const { isError, text } = await call(ctx, 'probe', {}, agent)
    expect(isError).toBe(true)
    expect(text).toContain(FROZEN)
  })

  it('falls back to its own defaults when called without a resolved config', async () => {
    // `apply` is exported, so a host may invoke it directly with no schemastery
    // pass behind it. Every `??` therefore has to carry a real default rather
    // than relying on the schema: this drives that path with `apply(ctx)`.
    const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-gate-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    const ledgerFiber = await ctx.plugin(YxspecArtifactLedger)
    cleanups.push(() => ledgerFiber.dispose())
    ctx.tools.register(write)
    yxspecGate.apply(ctx)

    // The built-in write family and the 30s budget are the values in force.
    expect((await call(ctx, 'write', { file_path: FROZEN })).isError).toBe(true)
  })
})
