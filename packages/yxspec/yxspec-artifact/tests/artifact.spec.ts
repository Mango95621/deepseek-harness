/**
 * The artifact ledger: the YXSpec rule that a step is finished when its files
 * have landed, never when the agent says so.
 *
 * The load-bearing property is that every query re-stats the filesystem rather
 * than trusting a set accumulated from writes. These specs pin that by removing
 * a file out of band and re-asking, which is the only way the difference between
 * "the ledger remembers" and "the ledger checks" is observable.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import * as yxspecArtifact from '../src/index.ts'
import { YxspecArtifactLedger } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A throwaway workspace root with two declared artifacts on disk. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-artifact-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project', 'inputs'), { recursive: true })
  await writeFile(join(root, 'project', 'inputs', 'landed.json'), '{"ok":true}', 'utf8')
  await mkdir(join(root, 'project', 'inputs', 'nested'), { recursive: true })
  return root
}

/** Mount the domain service and the ledger over one workspace. */
async function harness(config: { emitIntervalMs?: number } = {}) {
  const root = await workspace()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(YxspecService, { workspaceRoot: root })
  const fiber = await ctx.plugin(YxspecArtifactLedger, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, ledger: ctx.yxspecArtifacts, root }
}

describe('landed', () => {
  it('reports a file that exists and one that does not', async () => {
    const { ledger } = await harness()
    expect(await ledger.landed('project/inputs/landed.json')).toBe(true)
    expect(await ledger.landed('project/inputs/absent.json')).toBe(false)
  })

  it('reports a directory as not landed, because only files count', async () => {
    const { ledger } = await harness()
    expect(await ledger.landed('project/inputs')).toBe(false)
  })

  it('re-stats on every query, so a file removed out of band reads as gone', async () => {
    const { ledger, root } = await harness()
    const rel = 'project/inputs/landed.json'
    expect(await ledger.landed(rel)).toBe(true)
    await rm(join(root, rel))
    // The whole point of the ledger: a path that vanished must not be remembered.
    expect(await ledger.landed(rel)).toBe(false)
  })

  it('resolves relative to the domain service root, not to the process cwd', async () => {
    const { ledger, root } = await harness()
    expect(ledger.base).toBe(root)
  })

  it('reads a Windows-spelled relative path the same way as a POSIX one', async () => {
    const { ledger } = await harness()
    expect(await ledger.landed('project\\inputs\\landed.json')).toBe(true)
  })
})

describe('landedOf and missingOf', () => {
  it('partitions a list into the paths present and the paths absent, in input order', async () => {
    const { ledger } = await harness()
    const rels = [
      'project/inputs/landed.json',
      'project/inputs/absent.json',
      'project/inputs/nested',
    ]
    expect(await ledger.landedOf(rels)).toEqual(['project/inputs/landed.json'])
    expect(await ledger.missingOf(rels)).toEqual([
      'project/inputs/absent.json',
      'project/inputs/nested',
    ])
  })

  it('reports an empty list when nothing is declared', async () => {
    const { ledger } = await harness()
    expect(await ledger.landedOf([])).toEqual([])
    expect(await ledger.missingOf([])).toEqual([])
  })
})

describe('isDeclared', () => {
  /** A stage whose one step gates on the artifact under test. */
  const stages = [{
    id: 'swe-arch',
    title: '软件架构设计',
    aspice: 'SWE.2',
    group: 'design',
    steps: [{
      id: 'impl-judge',
      cell: '02.md',
      title: '实现度精判',
      frozen: false,
      requiredInputs: ['project/inputs/landed.json'],
    }],
  }]

  it('recognizes a path some step gates on, and rejects one no step names', async () => {
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages })
    const fiber = await ctx.plugin(YxspecArtifactLedger, {})
    cleanups.push(() => fiber.dispose())

    expect(ctx.yxspecArtifacts.isDeclared('project/inputs/landed.json')).toBe(true)
    expect(ctx.yxspecArtifacts.isDeclared('project/inputs/other.json')).toBe(false)
  })

  it('matches a declared path regardless of separator spelling', async () => {
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages })
    const fiber = await ctx.plugin(YxspecArtifactLedger, {})
    cleanups.push(() => fiber.dispose())

    expect(ctx.yxspecArtifacts.isDeclared('project\\inputs\\landed.json')).toBe(true)
  })
})

describe('observe', () => {
  it('records the size and declared-ness of a written file', async () => {
    const { ledger } = await harness()
    const write = await ledger.observe('project/inputs/landed.json')
    expect(write).toEqual({
      path: 'project/inputs/landed.json',
      bytes: '{"ok":true}'.length,
      declared: false,
    })
  })

  it('normalizes a Windows-spelled path on the way out', async () => {
    const { ledger } = await harness()
    expect((await ledger.observe('project\\inputs\\landed.json'))?.path)
      .toBe('project/inputs/landed.json')
  })

  it('returns undefined for a path that is not a file', async () => {
    const { ledger } = await harness()
    expect(await ledger.observe('project/inputs/absent.json')).toBeUndefined()
    expect(await ledger.observe('project/inputs')).toBeUndefined()
  })

  it('emits an observation event only when emission is enabled', async () => {
    const silent = await harness()
    const listener = vi.fn()
    silent.ctx.on('yxspec/artifact-write', listener)
    await silent.ledger.observe('project/inputs/landed.json')
    expect(listener).not.toHaveBeenCalled()

    const emitting = await harness({ emitIntervalMs: 1 })
    const heard = vi.fn()
    emitting.ctx.on('yxspec/artifact-write', heard)
    const write = await emitting.ledger.observe('project/inputs/landed.json')
    expect(heard).toHaveBeenCalledWith(write)
  })

  it('observes nothing, and emits nothing, for a path outside the workspace root', async () => {
    const { ledger, ctx } = await harness({ emitIntervalMs: 1 })
    const heard = vi.fn()
    ctx.on('yxspec/artifact-write', heard)
    // `resolve` climbs out of the root; the stat then fails on a path that does
    // not exist, which is the same answer as any other absent file.
    expect(await ledger.observe('../outside-the-workspace.json')).toBeUndefined()
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('plugin wiring', () => {
  it('carries its own inject list on the exported class, which the loader reads', () => {
    // The loader prefers `export default` when unwrapping, so it reads the class
    // metadata; a module-level list alone would leave the constructor running
    // before `yxspec` exists.
    expect(YxspecArtifactLedger.inject).toEqual(['yxspec'])
  })

  it('exposes the ledger under the service key consumers read', async () => {
    const { ctx } = await harness()
    expect(ctx.yxspecArtifacts).toBeInstanceOf(YxspecArtifactLedger)
  })

  it('takes its emission interval from the deployment configuration', async () => {
    const { ctx, ledger } = await harness({ emitIntervalMs: 5 })
    const heard = vi.fn()
    ctx.on('yxspec/artifact-write', heard)
    await ledger.observe('project/inputs/landed.json')
    expect(heard).toHaveBeenCalledOnce()
  })

  it('defaults the emission interval to silent when configuration omits it', async () => {
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root })
    // Mounting the module runs its `apply`, which is the entry the loader takes.
    const fiber = await ctx.plugin(yxspecArtifact)
    cleanups.push(() => fiber.dispose())
    const heard = vi.fn()
    ctx.on('yxspec/artifact-write', heard)
    await ctx.yxspecArtifacts.observe('project/inputs/landed.json')
    expect(heard).not.toHaveBeenCalled()
  })
})
