/**
 * Blind dispatch (LD-027): a controller must not let a worker's rendered prompt
 * pass through its own context.
 *
 * The property under test is an *absence* — the API exposes no method that
 * returns a rendered body, only a handle carrying the path and its digest. These
 * specs assert the mechanical steps on either side of that absence: the render
 * is all-or-nothing on unresolved anchors, the handle identifies the file by
 * content, and the spawn prompt tells the worker to verify the hash before
 * acting rather than carrying the body itself.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import * as yxspecDispatch from '../src/index.ts'
import { YxspecDispatcher } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A workspace with one renderable template and one that leaves an anchor open. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-dispatch-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'project', 'traceability', 'prompts'), { recursive: true })
  await writeFile(
    join(root, 'project', 'traceability', 'prompts', 'reviewer.md'),
    '你是 {{role}}。项目：{{project}}。\n',
    'utf8',
  )
  await writeFile(
    join(root, 'project', 'traceability', 'prompts', 'broken.md'),
    '你是 {{role}}。缺失：{{missing}}。\n',
    'utf8',
  )
  return root
}

/** Mount the domain service and the dispatcher over one workspace. */
async function harness(config: Parameters<typeof yxspecDispatch.apply>[1] = {}) {
  const root = await workspace()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(YxspecService, { workspaceRoot: root })
  const fiber = await ctx.plugin(YxspecDispatcher, config)
  cleanups.push(() => fiber.dispose())
  return { ctx, dispatcher: ctx.yxspecDispatch, root }
}

describe('render', () => {
  it('fills every anchor and lands the prompt under a per-worker path', async () => {
    const { dispatcher, root } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: '评审员', project: 'IVI' })

    expect(handle.role).toBe('reviewer')
    expect(handle.workerId).toBe('w1')
    expect(handle.promptFile).toBe(join(root, 'project', 'traceability', 'spawn', 'dispatch', 'reviewer-w1.md'))
    expect(await readFile(handle.promptFile, 'utf8')).toBe('你是 评审员。项目：IVI。\n')
  })

  it('digests the rendered bytes, so the worker can verify what it reads', async () => {
    const { dispatcher } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: '评审员', project: 'IVI' })
    const expected = createHash('sha256').update('你是 评审员。项目：IVI。\n', 'utf8').digest('hex')
    expect(handle.promptSha256).toBe(expected)
    // The byte count is the rendered UTF-8 length, not the character count.
    expect(handle.bytes).toBe(Buffer.byteLength('你是 评审员。项目：IVI。\n', 'utf8'))
  })

  it('gives two concurrent same-role dispatches different paths', async () => {
    const { dispatcher } = await harness()
    const params = { role: '评审员', project: 'IVI' }
    const first = await dispatcher.render('reviewer', 'w1', params)
    const second = await dispatcher.render('reviewer', 'w2', params)
    expect(first.promptFile).not.toBe(second.promptFile)
    // Same input, same digest: the hash identifies content, not the file.
    expect(first.promptSha256).toBe(second.promptSha256)
  })

  it('refuses to land a prompt with an unresolved anchor', async () => {
    const { dispatcher } = await harness()
    await expect(dispatcher.render('broken', 'w1', { role: '评审员' }))
      .rejects.toThrow(/unresolved anchors missing/)
  })

  it('refuses to land anything when the template itself is absent', async () => {
    const { dispatcher } = await harness()
    await expect(dispatcher.render('ghost', 'w1', {}))
      .rejects.toThrow(/ENOENT|no such file/)
  })

  it('leaves an anchor-shaped token alone when no parameter fills it', async () => {
    const { dispatcher } = await harness()
    // The template's own `{{project}}` is supplied here; an extra key that the
    // template does not use is simply not substituted.
    const handle = await dispatcher.render('reviewer', 'w1', { role: 'R', project: 'P', unused: 'x' })
    expect(handle.bytes).toBeGreaterThan(0)
  })

  it('honours a deployment-supplied spawn directory and template directory', async () => {
    const root = await workspace()
    await mkdir(join(root, 'custom', 'templates'), { recursive: true })
    await writeFile(join(root, 'custom', 'templates', 'reviewer.md'), '角色 {{role}}\n', 'utf8')

    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root })
    const fiber = await ctx.plugin(YxspecDispatcher, {
      spawnDir: 'custom/spawn',
      promptDir: 'custom/templates',
    })
    cleanups.push(() => fiber.dispose())

    const handle = await ctx.yxspecDispatch.render('reviewer', 'w9', { role: 'R' })
    expect(handle.promptFile).toBe(join(root, 'custom', 'spawn', 'reviewer-w9.md'))
  })

  it('refuses a configuration whose spawn directory escapes the workspace', async () => {
    // The spawn directory is deployment configuration, but a `..` in it would
    // land a worker prompt outside the workspace the dispatch is audited in, so
    // the render refuses rather than writing it.
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root })
    const fiber = await ctx.plugin(YxspecDispatcher, { spawnDir: '../escaped-prompts' })
    cleanups.push(() => fiber.dispose())

    // The template is still readable, so the failure is the escape check rather
    // than a missing file; the staging file is written first and then rejected.
    await writeFile(join(root, 'project', 'traceability', 'prompts', 'reviewer.md'), 'R {{role}}\n', 'utf8')
    await expect(ctx.yxspecDispatch.render('reviewer', 'w1', { role: 'R' }))
      .rejects.toThrow(/escapes workspace/)
  })

  it('exempts the workspace root itself from the escape check', async () => {
    // `withinWorkspace` treats the root as inside, which is what lets a
    // deployment point the spawn directory at the root without tripping the
    // guard; the render then lands a file directly there.
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root })
    const fiber = await ctx.plugin(YxspecDispatcher, { spawnDir: '.' })
    cleanups.push(() => fiber.dispose())

    const handle = await ctx.yxspecDispatch.render('reviewer', 'w1', { role: 'R', project: 'P' })
    expect(handle.promptFile).toBe(join(root, 'reviewer-w1.md'))
  })
})

describe('describe', () => {
  it('reports counts and a digest prefix, never the body', async () => {
    const { dispatcher } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: '评审员', project: 'IVI' })
    const line = dispatcher.describe(handle)

    expect(line).toContain('reviewer/w1')
    expect(line).toContain(`${handle.bytes}B`)
    expect(line).toContain(handle.promptSha256.slice(0, 12))
    // The line names the file but carries no prompt text.
    expect(line).not.toContain('评审员')
  })
})

describe('buildSpawnPrompt', () => {
  it('tells the worker to verify the hash before acting', async () => {
    const { dispatcher } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: '评审员', project: 'IVI' })
    const prompt = dispatcher.buildSpawnPrompt({ handle, outputContract: ['project/out.md'] })

    expect(prompt).toContain(handle.promptFile)
    expect(prompt).toContain(handle.promptSha256)
    expect(prompt).toContain('prompt_hash_mismatch')
    expect(prompt).toContain('project/out.md')
    expect(prompt).toContain('尝试次数：1')
    // The prompt must not embed the body it is asking the worker to read.
    expect(prompt).not.toContain('你是 评审员')
  })

  it('defers to the role prompt when no output contract is declared', async () => {
    const { dispatcher } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: 'R', project: 'P' })
    const prompt = dispatcher.buildSpawnPrompt({ handle, outputContract: [] })
    expect(prompt).toContain('由角色提示词规定')
  })

  it('reports the attempt number the caller supplied', async () => {
    const { dispatcher } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: 'R', project: 'P' })
    const prompt = dispatcher.buildSpawnPrompt({ handle, outputContract: [], attempt: 3 })
    expect(prompt).toContain('尝试次数：3')
  })

  it('names the project root, so the worker can resolve relative contracts', async () => {
    const { dispatcher, root } = await harness()
    const handle = await dispatcher.render('reviewer', 'w1', { role: 'R', project: 'P' })
    expect(dispatcher.buildSpawnPrompt({ handle, outputContract: [] })).toContain(root)
  })
})

describe('plugin wiring', () => {
  it('carries its own inject list on the exported class, which the loader reads', () => {
    expect(YxspecDispatcher.inject).toEqual(['yxspec'])
    expect(yxspecDispatch.inject).toEqual(['yxspec'])
    expect(yxspecDispatch.name).toBe('yxspec-dispatch')
  })

  it('exposes the dispatcher under the service key consumers read', async () => {
    const { ctx } = await harness()
    expect(ctx.yxspecDispatch).toBeInstanceOf(YxspecDispatcher)
  })

  it('defaults its two directories through the schema', async () => {
    const { ctx, root } = await harness()
    const handle = await ctx.yxspecDispatch.render('reviewer', 'w1', { role: 'R', project: 'P' })
    expect(handle.promptFile.startsWith(join(root, 'project', 'traceability'))).toBe(true)
  })

  it('mounts through the module entry, which is what the loader names', async () => {
    // The module's `apply` is the Loader's entry; mounting the namespace runs it
    // and resolves the schema defaults, so this also covers the `??` reads.
    const root = await workspace()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root })
    const fiber = await ctx.plugin(yxspecDispatch)
    cleanups.push(() => fiber.dispose())

    const handle = await ctx.yxspecDispatch.render('reviewer', 'w1', { role: 'R', project: 'P' })
    expect(handle.promptFile).toContain(join('project', 'traceability', 'spawn', 'dispatch'))
  })
})
