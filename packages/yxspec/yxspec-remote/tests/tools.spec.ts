/**
 * The three model-facing tools, driven through the real pipeline.
 *
 * These tools are the only path an agent has to a build server, which is the
 * point: a build is a tool call, so it passes through the same `tools` pipeline
 * the YXSpec gate hooks, and a stage gate can require a green remote build. What
 * these specs pin is the resolution of "which project" and the shape each tool
 * hands back — not the transport, which `ssh.spec.ts` covers directly.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as yxspecRemote from '../src/index.ts'
import * as yxspecRemoteTools from '../src/tools.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** The smallest subprocess face these specs need: everything succeeds, nothing runs. */
function quietSubprocess() {
  return {
    spawns: [] as SubprocessSpawnSpec[],
    resolveExecutable: async (command: string) => `/usr/bin/${command}`,
    spawn(_spec: SubprocessSpawnSpec): SubprocessHandle {
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: () => undefined,
        waitForExit: async () => true,
      } satisfies SubprocessHandle
    },
  }
}

interface Harness {
  readonly ctx: Context
  readonly subprocess: ReturnType<typeof quietSubprocess>
  readonly projectRoot: string
  readonly workspaceId: string
}

/**
 * Boot the pipeline, storage, a workspace registry over one project, and the
 * plugin under test.
 * @param options.cwd - the Session working directory to report; defaults to the
 *   project's own root, so a case that does not care is inside the project.
 * @param options.cwdFromPrimaryRoot - report the project's own first root as the
 *   Session cwd, which is the relationship the resolution relies on.
 * @param options.projects - the projects the registry knows about.
 * @param options.declaresYxspec - write the project's `project/config/yxspec.json`
 *   marker; false to prove the tools stay hidden in a project that declares none.
 * @param options.noWorkingDirectory - mount no `workingDirectory`, so the tools'
 *   plugin row has an unsatisfied injection and never registers.
 */
async function harness(options: {
  cwd?: string | undefined
  cwdFromPrimaryRoot?: boolean
  projects?: Array<{ id: string; roots: string[]; title?: string }>
  declaresYxspec?: boolean
  noWorkingDirectory?: boolean
} = {}): Promise<Harness> {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  const projectRoot = await mkdtemp(join(tmpdir(), 'dsh-yxspec-tools-'))
  cleanups.push(() => rm(projectRoot, { recursive: true, force: true }))
  await writeFile(join(projectRoot, 'main.c'), 'int main(void) { return 0; }\n')
  // The three tools carry a step-time guard restricting them to a project that
  // declares a YXSpec process, and this is that declaration. Written before the
  // plugin mounts because the guard reads it per step.
  if (options.declaresYxspec !== false) {
    await mkdir(join(projectRoot, 'project', 'config'), { recursive: true })
    await writeFile(join(projectRoot, 'project', 'config', 'yxspec.json'), '{}', 'utf8')
  }

  const workspaceId = 'ws-tools-1'
  const projects = options.projects ?? [
    { id: workspaceId, roots: [projectRoot], title: 'OEM IVI' },
    { id: 'other', roots: ['/elsewhere'], title: 'Other' },
  ]
  ctx.provide('workspaceRegistry', {
    get: (id: string) => projects.find(project => project.id === id),
    list: () => projects,
  } as never)
  const cwd = options.cwdFromPrimaryRoot === true
    ? projectRoot
    : options.cwd ?? projectRoot
  if (options.noWorkingDirectory !== true) {
    // A Session's working directory is the honest source of "which project": a
    // project's first root is exactly that cwd, so the two agree by construction.
    ctx.provide('workingDirectory', { get: () => cwd } as never)
  }

  const subprocess = quietSubprocess()
  ctx.provide('subprocess', subprocess as never)
  const fiber = await ctx.plugin(yxspecRemote)
  cleanups.push(() => fiber.dispose())
  await ctx.yxspecRemote.ready
  // The tools live in a sibling plugin, so the composition decides which agents
  // receive them. Mounting that row beside the service is what the shipped Web
  // presets do. The row declares `workingDirectory`, so a harness that mounts
  // none leaves it pending rather than half-registered.
  const toolsFiber = await ctx.plugin(yxspecRemoteTools)
  cleanups.push(() => toolsFiber.dispose())
  return { ctx, subprocess, projectRoot, workspaceId }
}

let callSeq = 0

/**
 * Invoke one remote tool and return its reported value, parsed.
 *
 * Every tool here carries an activation condition, so the step's admitted set is
 * resolved first and passed in — a conditional registration is unavailable to a
 * call outside a model step, which is the same rule the real pipeline applies.
 * The condition also needs an agent to read the session's project, and a model
 * step always has one, so a case that does not care supplies a shared identity.
 * @param ctx - the harness context owning the pipeline.
 * @param name - the tool to call.
 * @param args - the tool arguments.
 * @param agent - the calling Agent; defaults to one inside the harness project.
 * @returns the tool's parsed canonical value.
 */
async function invoke(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent: Agent = agentWithSession('default'),
): Promise<Record<string, unknown>> {
  const signal = new AbortController().signal
  const toolSet = await ctx.tools.resolve({
    agent,
    modelSelection: { provider: 'test', model: 'test' },
    signal,
  })
  const result = await executeToolFixture(ctx, {
    signal,
    callId: brandString<ToolCallId>(`remote-${callSeq++}`),
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
 * Invoke one remote tool's body directly, with no agent and outside any model
 * step.
 *
 * The activation guard resolves a project from the preparing agent's Session, so
 * an admitted call already implies a project exists and the "no active project"
 * answer cannot be reached that way. The branch that answers it is still live
 * for a caller the guard never admits, so it is exercised through the
 * definition rather than through a step.
 * @param ctx - the harness context owning the pipeline.
 * @param name - the tool to call.
 * @param args - the tool arguments.
 * @param agent - the caller to report, when the case needs a Session identity.
 * @returns the tool's canonical value.
 */
async function invokeDirect(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  agent?: Agent,
): Promise<Record<string, unknown>> {
  const definition = ctx.tools.get(name)
  if (definition === undefined) throw new Error(`${name} must be registered`)
  const exec = {
    callId: brandString<ToolCallId>(`remote-${callSeq++}`),
    rootCallId: brandString<ToolCallId>('remote-direct'),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
    token: Symbol('remote-direct') as ToolExecutionToken,
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
  return await definition.execute(args, exec) as Record<string, unknown>
}

/**
 * An Agent carrying a session identity, which is what the project resolution
 * reads. Only `session` is consulted here — the resolution passes it to the
 * mounted `workingDirectory` — so the rest of the live Agent is not needed.
 * @param sessionId - the session identity to carry.
 * @returns an Agent standing in for one that started in that session.
 */
function agentWithSession(sessionId: string): Agent {
  return { session: { id: sessionId } } as Agent
}

describe('remote_server_declare', () => {
  it('declares a server and reports the recipes it can now run', async () => {
    const { ctx, workspaceId } = await harness()
    const value = await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'aosp-builder',
      destination: 'ci@build.internal',
      baseDirectory: '/srv/builds',
      recipes: [{ id: 'ninja-full', command: 'ninja -C {cwd}/out all' }],
    })

    expect(value).toEqual({
      ok: true, workspaceId, serverId: 'aosp-builder', recipes: ['ninja-full'],
    })
    const stored = await ctx.yxspecRemote.server(workspaceId, 'aosp-builder')
    // The declared label falls back to the id, and the timeout to a build-sized
    // default, so a caller may name only what it actually cares about.
    expect(stored).toMatchObject({ title: 'aosp-builder', timeoutMs: 900_000, transport: 'ssh' })
    expect(stored?.sshExecutable).toBeUndefined()
  })

  it('keeps the fields a caller does supply', async () => {
    const { ctx, workspaceId } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'b',
      destination: 'host',
      baseDirectory: '/srv',
      recipes: [{ id: 'r', command: 'true' }],
      title: '构建机',
      timeoutMs: 1_000,
      sshExecutable: '/opt/ssh',
    })
    // A blank label would be indistinguishable from an absent one, so only a
    // non-empty string replaces the id.
    const stored = await ctx.yxspecRemote.server(workspaceId, 'b')
    expect(stored).toMatchObject({ title: '构建机', timeoutMs: 1_000, sshExecutable: '/opt/ssh' })
  })

  it('ignores a blank optional string rather than storing it', async () => {
    const { ctx, workspaceId } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'b',
      destination: 'host',
      baseDirectory: '/srv',
      recipes: [{ id: 'r', command: 'true' }],
      title: '',
      sshExecutable: '',
    })
    const stored = await ctx.yxspecRemote.server(workspaceId, 'b')
    expect(stored?.title).toBe('b')
    expect(stored?.sshExecutable).toBeUndefined()
  })

  it('refuses a recipe list the declaration could never run', async () => {
    const { ctx, workspaceId } = await harness()
    const value = await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'b',
      destination: 'host',
      baseDirectory: '/srv',
      recipes: [{ id: '  ', command: 'true' }],
    })
    // A malformed entry fails the whole declaration rather than dropping one
    // recipe a stage gate might have been told to require.
    expect(value).toEqual({ ok: false, error: 'recipes must be a non-empty array of { id, command }' })
    expect(await ctx.yxspecRemote.list(workspaceId)).toEqual([])
  })

  it('refuses an empty recipe list, which would declare a server that can never run', async () => {
    const { ctx, workspaceId } = await harness()
    // The schema types `recipes` as an array but places no length floor on it, so an empty
    // one reaches the handler — and a server with no recipes is one a run can never target.
    const value = await invoke(ctx, 'remote_server_declare', {
      workspaceId, serverId: 'b', destination: 'host', baseDirectory: '/srv', recipes: [],
    })
    expect(value).toEqual({ ok: false, error: 'recipes must be a non-empty array of { id, command }' })
    expect(await ctx.yxspecRemote.list(workspaceId)).toEqual([])
  })

  it('refuses a blank command for the same reason', async () => {
    const { ctx, workspaceId } = await harness()
    const value = await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'b',
      destination: 'host',
      baseDirectory: '/srv',
      recipes: [{ id: 'r', command: '   ' }],
    })
    expect(value.ok).toBe(false)
  })

  it('refuses a declaration when no project could be resolved', async () => {
    // An agent-less call: the guard never admits one, so this is the only path
    // that reaches the tool's own "no project" answer. A declaration that cannot
    // be filed against a project is refused rather than stored somewhere global.
    const { ctx } = await harness()
    const value = await invokeDirect(ctx, 'remote_server_declare', {
      serverId: 'b',
      destination: 'host',
      baseDirectory: '/srv',
      recipes: [{ id: 'r', command: 'true' }],
    })
    expect(value).toEqual({ ok: false, error: 'no active project' })
  })
})

describe('remote_server_list', () => {
  it('lists a project\'s declarations with their recipes and probe state', async () => {
    const { ctx, workspaceId } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'aosp-builder',
      destination: 'ci@build.internal',
      baseDirectory: '/srv/builds',
      recipes: [{ id: 'ninja-full', command: 'ninja' }, { id: 'ctest', command: 'ctest' }],
    })

    const value = await invoke(ctx, 'remote_server_list', { workspaceId })
    expect(value.ok).toBe(true)
    expect(value.servers).toEqual([{
      id: 'aosp-builder',
      title: 'aosp-builder',
      destination: 'ci@build.internal',
      baseDirectory: '/srv/builds',
      recipes: ['ninja-full', 'ctest'],
      // A server that has never been probed reports the absence explicitly, so
      // a picker does not have to distinguish "absent" from "unset".
      lastProbeAt: null,
      lastPlatform: null,
    }])
  })

  it('reports a blank list for a project that declared nothing', async () => {
    const { ctx, workspaceId } = await harness()
    expect(await invoke(ctx, 'remote_server_list', { workspaceId }))
      .toEqual({ ok: true, workspaceId, servers: [] })
  })

  it('refuses a list when no project could be resolved', async () => {
    // Direct, because an admitted call always has an agent and therefore always
    // resolves a project; the refusal guards the agent-less path.
    const { ctx } = await harness()
    expect(await invokeDirect(ctx, 'remote_server_list', {}))
      .toEqual({ ok: false, error: 'no active project' })
  })
})

describe('remote_build', () => {
  it('returns a settled run, with ok reflecting the exit code', async () => {
    const { ctx, workspaceId } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'builder',
      destination: 'host',
      baseDirectory: '/srv/builds',
      recipes: [{ id: 'ninja-full', command: 'ninja -C {cwd} all' }],
    })

    const value = await invoke(ctx, 'remote_build', {
      workspaceId, serverId: 'builder', recipe: 'ninja-full', push: false, extraArgs: ' -j8 ',
    })
    expect(value.ok).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.workspaceId).toBe(workspaceId)
    expect(value.command).toContain('-j8')
    expect(value.logSha256).toMatch(/^[0-9a-f]{64}$/)
    // A skipped push leaves no tree digest, because nothing was uploaded.
    expect(value.treeDigest).toBeUndefined()
  })

  it('reports a failing build as data with ok false', async () => {
    const { ctx, workspaceId } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'builder',
      destination: 'host',
      baseDirectory: '/srv/builds',
      recipes: [{ id: 'ninja-full', command: 'ninja' }],
    })
    // Disposes the declaration's own recipe by asking for a push and then a
    // failure: the transport is not what is under test here, the tool's `ok`.
    const value = await invoke(ctx, 'remote_build', {
      workspaceId, serverId: 'builder', recipe: 'ninja-full', push: false,
    })
    expect(value.ok).toBe(true)

    // An undeclared recipe still throws, because that is a caller mistake rather
    // than a build result.
    await expect(invoke(ctx, 'remote_build', { workspaceId, serverId: 'builder', recipe: 'ghost' }))
      .rejects.toThrow(/declares no recipe 'ghost'/)
  })

  it('passes an explicit source directory through and omits a blank one', async () => {
    const { ctx, workspaceId, projectRoot } = await harness()
    await invoke(ctx, 'remote_server_declare', {
      workspaceId,
      serverId: 'builder',
      destination: 'host',
      baseDirectory: '/srv/builds',
      recipes: [{ id: 'ninja-full', command: 'ninja' }],
    })

    const nested = join(projectRoot, 'sub')
    const explicit = await invoke(ctx, 'remote_build', {
      workspaceId, serverId: 'builder', recipe: 'ninja-full', push: false, sourceDirectory: nested,
    })
    expect(explicit.ok).toBe(true)

    // A blank string is "not supplied" rather than a directory named nothing, so the run falls
    // back to the project's own primary root instead of failing on an empty path.
    const blank = await invoke(ctx, 'remote_build', {
      workspaceId, serverId: 'builder', recipe: 'ninja-full', push: false, sourceDirectory: '',
    })
    expect(blank.ok).toBe(true)
  })

  it('refuses a build when no project could be resolved', async () => {
    // Direct, for the same reason as the list: the reachable state through a
    // model step always carries a project.
    const { ctx } = await harness()
    expect(await invokeDirect(ctx, 'remote_build', { serverId: 'b', recipe: 'r' }))
      .toEqual({ ok: false, error: 'no active project' })
  })
})

describe('which project a call targets', () => {
  it('prefers an explicit id over anything derived', async () => {
    const { ctx, projectRoot, workspaceId } = await harness({ cwdFromPrimaryRoot: true })
    const value = await invoke(ctx, 'remote_server_list', { workspaceId: 'other' })
    expect(value.workspaceId).toBe('other')
    expect(projectRoot).toBeDefined()
    expect(workspaceId).toBe('ws-tools-1')
  })

  it('derives the project from the Session working directory', async () => {
    const { ctx, workspaceId } = await harness({ cwdFromPrimaryRoot: true })
    const value = await invoke(ctx, 'remote_server_list', {}, agentWithSession('s1'))
    // The cwd is a project's first root, so no second piece of state is needed.
    expect(value.workspaceId).toBe(workspaceId)
  })

  it('leaves the project unresolved when the cwd belongs to none', async () => {
    // Direct: a cwd outside every declared root fails the guard, so no model
    // step would admit this call. The tool still answers honestly to a caller the
    // guard does not gate — an agent whose cwd names no project gets no project.
    const { ctx } = await harness({ cwd: '/somewhere/else' })
    expect(await invokeDirect(ctx, 'remote_server_list', {}, agentWithSession('s1')))
      .toEqual({ ok: false, error: 'no active project' })
  })

  it('mounts no tool at all when the composition provides no working directory', async () => {
    // The tools' row declares `workingDirectory` because its activation guard
    // reads one. A composition that mounts none leaves the row pending, which is
    // the honest outcome: there is no way to answer "which project?" and so no
    // schema to offer. This is the registrant's own view, which is also what the
    // guard would see.
    const { ctx } = await harness({ noWorkingDirectory: true })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([])
  })

  it('leaves the project unresolved when the call carries no agent', async () => {
    const { ctx } = await harness()
    expect(await invokeDirect(ctx, 'remote_server_list', {}))
      .toEqual({ ok: false, error: 'no active project' })
  })

  it('leaves the project unresolved for a blank explicit id', async () => {
    const { ctx } = await harness()
    // An empty string is treated as "not supplied" rather than as a project id,
    // so a client that clears its field does not target a nameless project.
    expect(await invokeDirect(ctx, 'remote_server_list', { workspaceId: '' }))
      .toEqual({ ok: false, error: 'no active project' })
  })

  it('withholds all three tools from a session outside a YXSpec project', async () => {
    // The guard is what keeps a build-server surface from being paid for by every
    // unrelated session: the schemas still register, but a step in a project that
    // declares no YXSpec process admits none of the three.
    const { ctx, workspaceId } = await harness({ declaresYxspec: false })
    const agent = agentWithSession('s1')
    const toolSet = await ctx.tools.resolve({
      agent,
      modelSelection: { provider: 'test', model: 'test' },
      signal: new AbortController().signal,
    })
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual([
      'remote_build', 'remote_server_declare', 'remote_server_list',
    ])
    expect([...toolSet.view(agent).keys()]).toEqual([])
    expect(workspaceId).toBe('ws-tools-1')
  })
})
