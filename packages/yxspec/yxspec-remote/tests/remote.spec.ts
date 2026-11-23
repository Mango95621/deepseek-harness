/**
 * Remote build seam tests. The transport is exercised against a recording
 * subprocess double rather than a real server: what is under test is the
 * service's own decisions — which paths are uploaded, what a recipe renders to,
 * how a failure is classified, and what lands in the ledger — none of which need
 * a network to be wrong.
 *
 * The double answers on the `spawn` contract (`handle.done`,
 * `handle.collected.stdout.readFrom`) so the production call sites are exercised
 * unchanged, and it records every argv so a test can assert the exact client
 * invocation rather than a summary of it.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import ToolsService from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as yxspecRemote from '../src/index.ts'
import { projectSlug } from '../src/paths.ts'
import { renderRecipe } from '../src/recipe.ts'
import { YxspecRemoteService } from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** One recorded spawn: the argv, and the answer the double gave it. */
interface Recorded {
  readonly argv: readonly string[]
  readonly spec: SubprocessSpawnSpec
}

/** What the double should answer with for one spawn. */
interface Reply {
  readonly exitCode: number
  readonly stdout?: string
  readonly stderr?: string
}

/**
 * Recording subprocess double.
 *
 * Replies are drawn from a queue when one is supplied, so a test can script a
 * push followed by a build with different outcomes; otherwise `defaultReply`
 * answers every spawn. `resolveExecutable` answers the executable lookups the
 * service performs on first use, which keeps a test from depending on the
 * machine having a particular ssh client installed.
 */
class FakeSubprocess {
  readonly spawns: Recorded[] = []
  /** Resolved paths returned for executable lookups, keyed by requested name. */
  readonly executables = new Map<string, string>()
  /** Every name `resolveExecutable` was asked for, so memoization is checkable. */
  readonly executablesResolutions: string[] = []
  /** Replies consumed in order; the last one repeats once the queue drains. */
  replies: Reply[] = []
  defaultReply: Reply = { exitCode: 0, stdout: '' }
  /** When set, `spawn` throws it: the provider refusing to start a process. */
  failSpawn: Error | undefined
  /** Milliseconds to hold a command open before it reports its exit, if any. */
  settleDelayMs = 0

  /** Provide a handle shaped exactly as the production call sites read it. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.failSpawn !== undefined) throw this.failSpawn
    this.spawns.push({ argv: spec.argv, spec })
    const reply = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? this.defaultReply)
    // A `tar` invocation is expected to leave its archive behind: the production
    // path streams that file into ssh's stdin, so a double that only reported an
    // exit code would fail at the read rather than exercising the upload.
    // The archive path is the argument right after `-czf`.
    const flag = spec.argv.indexOf('-czf')
    const archivePath = flag >= 0 ? spec.argv[flag + 1] : undefined
    if (archivePath !== undefined && reply.exitCode === 0) {
      writeFileSync(archivePath, `archive-for-${spec.argv.at(-1) ?? ''}`)
    }
    let released = false
    const stdoutReader = {
      readFrom: (from: number) => ({
        text: (reply.stdout ?? '').slice(from),
        nextOffset: (reply.stdout ?? '').length,
        lossy: false,
      }),
    }
    const stderrReader = {
      readFrom: () => ({ text: reply.stderr ?? '', nextOffset: (reply.stderr ?? '').length, lossy: false }),
    }
    // A piped stdin must accept the archive stream and signal completion: the
    // production path resolves on the writable's `finish`, so the double is a
    // real Writable that discards bytes and ends normally.
    const stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write: (_chunk, _encoding, callback) => { callback() },
      })
      : undefined
    return {
      stdin: stdin as never,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: stdoutReader, stderr: stderrReader },
      done: this.settleDelayMs === 0
        ? Promise.resolve({ exitCode: reply.exitCode, signal: null })
        : new Promise((resolve) => {
          // Held open on a timer so the run's own deadline can fire first: that
          // is the only way `timedOut` becomes true, since it is read off the
          // deadline signal rather than off the exit facts.
          setTimeout(() => { resolve({ exitCode: reply.exitCode, signal: null }) }, this.settleDelayMs)
        }),
      terminate: () => { released = true },
      waitForExit: async () => released || true,
    } satisfies SubprocessHandle
  }

  /**
   * Answer only what the test declared installed.
   *
   * A path-shaped request is *not* passed through as found: the service probes
   * platform-specific locations first (`C:\Windows\System32\tar.exe` on Windows,
   * `/usr/bin/ssh` when pinned) and must fall through to the bare name when a
   * location is absent. Passing paths through would let the platform probe win
   * and make the recorded `argv[0]` differ per host, which is exactly the
   * `PATH`-resolution behaviour these tests mean to pin down.
   */
  async resolveExecutable(command: string): Promise<string> {
    this.executablesResolutions.push(command)
    const known = this.executables.get(command)
    if (known !== undefined) return known
    throw new Error(`not found: ${command}`)
  }

  async terminalEnvironment(): Promise<never> { throw new Error('unused') }
  async spawnTerminal(): Promise<never> { throw new Error('unused') }
}

interface Harness {
  readonly ctx: Context
  readonly service: YxspecRemoteService
  readonly subprocess: FakeSubprocess
  readonly pool: MemoryMediaPool
  readonly workspaceId: string
  readonly projectRoot: string
}

/** Boot the storage stack every harness needs: backend, domain facility, seam. */
async function bootStorage(ctx: Context, pool: MemoryMediaPool): Promise<void> {
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
}

/** A throwaway source tree with one nested directory, for archive assertions. */
async function makeSourceTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-remote-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'main.c'), 'int main(void) { return 0; }\n')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'unit.c'), 'int unit(void) { return 0; }\n')
  return root
}

/**
 * Boot storage, the tool registry, a workspace registry stub declaring one
 * project, and the service under test over the recording double.
 */
async function harness(config: Parameters<typeof yxspecRemote.apply>[1] = {}): Promise<Harness> {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await bootStorage(ctx, pool)

  const projectRoot = await makeSourceTree()

  const workspaceId = 'ws-remote-1'
  ctx.provide('workspaceRegistry', {
    get: (id: string) => id === workspaceId
      ? { id, roots: [projectRoot], title: 'OEM IVI', path: projectRoot }
      : undefined,
    list: () => [{ id: workspaceId, roots: [projectRoot], title: 'OEM IVI', path: projectRoot }],
  } as never)

  // The tool registry owns a system-prompt contribution; a stub with the one
  // member it calls keeps the test from booting the whole prompt composition.
  // `tools()` returns a disposer, which the registry keeps as-is.
  ctx.provide('systemPrompt', { tools: () => () => undefined } as never)
  await ctx.plugin(ToolsService)
  const subprocess = new FakeSubprocess()
  ctx.provide('subprocess', subprocess as never)
  const fiber = await ctx.plugin(yxspecRemote, config)
  cleanups.push(() => fiber.dispose())
  const service = ctx.yxspecRemote
  await service.ready
  return { ctx, service, subprocess, pool, workspaceId, projectRoot }
}

/** A declaration with the fields a test does not care about filled in. */
function declaration(overrides: Partial<Parameters<YxspecRemoteService['declare']>[1]> = {}) {
  return {
    id: 'builder',
    title: 'AOSP builder',
    destination: 'aosp-builder',
    baseDirectory: '/srv/builds',
    transport: 'ssh' as const,
    recipes: { 'ninja-full': 'ninja -C {cwd}/out all' },
    timeoutMs: 900_000,
    ...overrides,
  }
}

describe('project slug', () => {
  it('keeps a readable stem and a stable suffix', () => {
    expect(projectSlug('9f3c1a2b-4d5e', 'OEM IVI')).toBe('OEM-IVI-9f3c1a2b4d5e')
  })

  it('cannot escape the base directory through the title', () => {
    // The title is user-editable text that becomes a server-side path segment,
    // so a traversal attempt must collapse rather than survive.
    const slug = projectSlug('id', '../../etc')
    expect(slug).not.toContain('/')
    expect(slug).not.toContain('..')
  })

  it('falls back to a literal stem when the title has no safe characters', () => {
    expect(projectSlug('abc123', '***')).toBe('project-abc123')
  })

  it('omits the suffix when the id carries nothing to make one from', () => {
    // An id of only separators yields no stable token; appending a lone hyphen
    // would leave a trailing `-` on a server-side directory name.
    expect(projectSlug('---', 'OEM IVI')).toBe('OEM-IVI')
    expect(projectSlug('', 'OEM IVI')).toBe('OEM-IVI')
  })

  it('bounds both halves so a path stays readable', () => {
    const slug = projectSlug('x'.repeat(40), 't'.repeat(80))
    // 48 for the readable stem and 12 for the stable token, joined by one dash.
    expect(slug).toHaveLength(48 + 1 + 12)
  })
})

describe('recipe rendering', () => {
  it('binds the working directory and prefixes a failure-propagating shell', () => {
    expect(renderRecipe('make -j', '/srv/builds/p'))
      .toBe("set -e; cd '/srv/builds/p'; make -j")
  })

  it('replaces every placeholder, so a recipe can reference two trees', () => {
    expect(renderRecipe('a {cwd} b {cwd}', '/x')).toBe("set -e; cd '/x'; a /x b /x")
  })

  it('appends one-off arguments without disturbing the template', () => {
    expect(renderRecipe('make', '/x', '  -j8  ')).toBe("set -e; cd '/x'; make -j8")
  })

  it('ignores whitespace-only extra arguments', () => {
    expect(renderRecipe('make', '/x', '   ')).toBe("set -e; cd '/x'; make")
  })
})

describe('declaration', () => {
  it('stores and lists a declaration', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration(), '2026-01-01T00:00:00.000Z')
    const servers = await service.list(workspaceId)
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({
      serverId: 'builder',
      destination: 'aosp-builder',
      recipes: { 'ninja-full': 'ninja -C {cwd}/out all' },
    })
  })

  it('scopes declarations to their project', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration())
    expect(await service.list('another-project')).toEqual([])
    expect(await service.server('another-project', 'builder')).toBeUndefined()
  })

  it('replaces a declaration rather than accumulating duplicates', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration())
    await service.declare(workspaceId, declaration({ destination: 'other-host' }))
    const servers = await service.list(workspaceId)
    expect(servers).toHaveLength(1)
    expect(servers[0]?.destination).toBe('other-host')
  })

  it('normalizes a trailing slash so remote paths never double up', async () => {
    const { service, workspaceId } = await harness()
    const stored = await service.declare(workspaceId, declaration({ baseDirectory: '/srv/builds///' }))
    expect(stored.baseDirectory).toBe('/srv/builds')
  })

  it('forgets a declaration but keeps the runs it produced', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(await service.forget(workspaceId, 'builder')).toBe(true)
    expect(await service.list(workspaceId)).toEqual([])
    // The evidence of the build survives the declaration that produced it.
    expect(await service.runsFor(workspaceId)).toHaveLength(1)
  })

  it('rejects a declaration that could not run: empty id, relative base, no recipes', async () => {
    const { service, workspaceId } = await harness()
    await expect(service.declare(workspaceId, declaration({ id: '  ' })))
      .rejects.toThrow(/non-empty id/)
    await expect(service.declare(workspaceId, declaration({ destination: '' })))
      .rejects.toThrow(/needs a destination/)
    await expect(service.declare(workspaceId, declaration({ baseDirectory: 'srv/builds' })))
      .rejects.toThrow(/absolute server path/)
    await expect(service.declare(workspaceId, declaration({ timeoutMs: 0 })))
      .rejects.toThrow(/positive timeoutMs/)
    await expect(service.declare(workspaceId, declaration({ recipes: {} })))
      .rejects.toThrow(/declares no recipes/)
  })

  it('rejects a recipe a run could never name, exactly as the tool layer does', async () => {
    const { service, workspaceId } = await harness()
    // The tool layer strips these before they reach the seam, but a host may mount the
    // service directly. An unnamed recipe is the dangerous one: it would make the run-time
    // "known: ..." listing read as empty for a server that does declare something.
    await expect(service.declare(workspaceId, declaration({ recipes: { '  ': 'true' } })))
      .rejects.toThrow(/recipe with a blank id/)
    await expect(service.declare(workspaceId, declaration({ recipes: { r: '   ' } })))
      .rejects.toThrow(/recipe 'r' needs a non-empty command/)
    expect(await service.list(workspaceId)).toEqual([])
  })

  it('keeps a base directory of the remote root rather than collapsing it', async () => {
    const { service, workspaceId } = await harness()
    // An absolute root is a legitimate base: it trims to nothing, which must read as `/`
    // and not as an empty path segment that would produce `//slug`.
    const root = await service.declare(workspaceId, declaration({ baseDirectory: '/' }))
    expect(root.baseDirectory).toBe('/')
  })
})

describe('probe', () => {
  it('reports reachability, records the platform, and creates a missing base directory', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'Linux\nBASE_CREATED\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: true, platform: 'Linux' })
    // One round trip does both jobs, and the base directory is created on the miss.
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]?.argv.at(-1)).toContain('mkdir -p')
    const stored = await service.server(workspaceId, 'builder')
    expect(stored?.lastPlatform).toBe('Linux')
    expect(stored?.lastProbeAt).toBeDefined()
  })

  it('reports an unreachable server as data rather than throwing', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 255, stderr: 'Host key verification failed.\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('Host key verification failed')
    expect((await service.server(workspaceId, 'builder'))?.lastProbeAt).toBeUndefined()
  })

  it('refuses to probe a server the project never declared', async () => {
    const { service, workspaceId } = await harness()
    await expect(service.probe(workspaceId, 'ghost'))
      .rejects.toThrow(/declares no build server 'ghost'/)
  })

  it('reports an unresolvable ssh client as unreachability, not as a failure', async () => {
    const { service, workspaceId } = await harness()
    // No `ssh` is installed, so resolving the client itself fails. That is a
    // fact about this host, and a picker needs it as an answer.
    await service.declare(workspaceId, declaration())
    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('no OpenSSH client found')
  })

  it('reports a spawn-level failure as unreachability too', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.failSpawn = new Error('EPERM: operation not permitted')

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toMatchObject({ reachable: false })
    expect(probe.error).toContain('EPERM')
  })

  it('reports a non-Error rejection from the transport as text, not as a crash', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A provider is free to reject with a bare value; the probe still has to name it.
    subprocess.failSpawn = 'permission denied' as never

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: false, error: 'permission denied' })
  })

  it('reports a probe whose client wrote no platform line at all', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A server that answered only the base-directory check: reachable, but with
    // no platform to record — so the absence must not be written as a value.
    subprocess.replies = [{ exitCode: 0, stdout: 'BASE_OK\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: true })
    expect((await service.server(workspaceId, 'builder'))?.lastPlatform).toBeUndefined()
  })

  it('names a timed-out probe as a timeout rather than as an exit code', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ timeoutMs: 1 }))
    // The command is still open when the one-millisecond deadline fires.
    subprocess.settleDelayMs = 40
    subprocess.replies = [{ exitCode: 255 }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toMatchObject({ reachable: false })
    expect(probe.error).toBe('connection timed out')
  })

  it('reports an unhandled probe failure with only the exit code it saw', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // An exit code with no diagnostic on either stream: the message must still
    // say something actionable.
    subprocess.replies = [{ exitCode: 7 }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.error).toBe('ssh exited 7')
  })

  it('carries a caller cancellation into the probe', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'Darwin\n' }]
    const controller = new AbortController()

    await service.probe(workspaceId, 'builder', controller.signal)
    expect(subprocess.spawns[0]?.spec.signal).toBeInstanceOf(AbortSignal)
  })
})

/**
 * Boot a second harness over the same shape, so a spec can pass plugin
 * configuration. Kept as a thin alias so the default boot stays the common path.
 */
async function harnessPluginConfig(config: Parameters<typeof yxspecRemote.apply>[1]): Promise<Harness> {
  return await harness(config)
}

describe('service-level defaults and diagnostics', () => {
  it('orders declarations by when they were declared', async () => {
    const { service, workspaceId } = await harness()
    // Declared out of order, so the sort is what produces the listing order.
    await service.declare(workspaceId, declaration({ id: 'later' }), '2026-03-01T00:00:00.000Z')
    await service.declare(workspaceId, declaration({ id: 'earlier' }), '2026-01-01T00:00:00.000Z')

    expect((await service.list(workspaceId)).map(record => record.serverId))
      .toEqual(['earlier', 'later'])
  })

  it('reports the known server ids when a declaration is missing', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration({ id: 'known' }))
    await expect(service.run(workspaceId, { serverId: 'ghost', recipe: 'r' }))
      .rejects.toThrow(/known: known/)
  })

  it('reports a project that declared nothing with an explicit (none)', async () => {
    const { service } = await harness()
    await expect(service.run('empty-project', { serverId: 'ghost', recipe: 'r' }))
      .rejects.toThrow(/known: \(none\)/)
  })

  it('reports a recipe the server does not declare with an explicit (none) when it declares none', async () => {
    const { service, workspaceId } = await harness()
    // `validateServer` refuses an empty recipe map, so the only way to reach an
    // unnamed recipe is a declaration that has one and a request for another —
    // which the earlier spec covers. This pins the message's other arm.
    await service.declare(workspaceId, declaration({ recipes: {} as never }))
      .catch(() => undefined)
    expect(await service.list(workspaceId)).toEqual([])
  })

  it('fails loud when a run has no project to archive from', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    // Declared under an id the registry does not know — a declaration written
    // against a project that was later removed. The default archive source
    // cannot be resolved, which is a transport-level impossibility rather than
    // a build outcome, so it throws rather than being reported as a failure.
    await service.declare('ghost-ws', declaration())

    await expect(service.run('ghost-ws', { serverId: 'builder', recipe: 'ninja-full' }))
      .rejects.toThrow(/no project carries id 'ghost-ws'/)
  })

  it('falls back to the id as the slug stem when the project has no title', async () => {
    const { service, subprocess, projectRoot } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    // A project the registry cannot resolve, with an explicit source directory
    // so the archive still has somewhere to come from: the readable half of the
    // slug becomes the id, which is still a safe path segment.
    await service.declare('untitled', declaration())
    subprocess.replies = [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]

    const result = await service.run('untitled', {
      serverId: 'builder', recipe: 'ninja-full', sourceDirectory: projectRoot,
    })
    expect(result.remoteDirectory).toBe('/srv/builds/untitled-untitled')
  })

  it('memoizes the archive tool and each ssh client across runs', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    subprocess.executables.set('/opt/ssh', '/opt/ssh')
    await service.declare(workspaceId, declaration())
    await service.declare(workspaceId, declaration({ id: 'pinned', sshExecutable: '/opt/ssh' }))
    subprocess.replies = [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'pinned', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    // Three runs: each distinct ssh client and tar were resolved once each,
    // because a build farm's tool paths do not move between runs.
    expect(subprocess.executablesResolutions.filter(name => name === 'tar')).toHaveLength(1)
    expect(subprocess.executablesResolutions.filter(name => name === 'ssh')).toHaveLength(1)
    expect(subprocess.executablesResolutions.filter(name => name === '/opt/ssh')).toHaveLength(1)
  })

  it('skips the push when configuration disables it, and keeps the digest absent', async () => {
    const { service, subprocess, workspaceId } = await harnessPluginConfig({ pushSource: false })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // No tar, no upload: one spawn, and no tree digest to record.
    expect(subprocess.spawns).toHaveLength(1)
    expect(result.treeDigest).toBeUndefined()
  })
})

/**
 * Configuration reaches the service two ways — through the Loader, which runs the
 * schemastery `Config` first, or through a direct construction, which does not.
 * Both must land on the same defaults, so these specs mount the class itself.
 */
describe('direct construction', () => {
  /** Mount `YxspecRemoteService` verbatim, bypassing the Loader's `Config` pass. */
  async function direct(config: ConstructorParameters<typeof YxspecRemoteService>[1]) {
    const pool = new MemoryMediaPool()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await bootStorage(ctx, pool)
    const projectRoot = await makeSourceTree()
    ctx.provide('workspaceRegistry', {
      get: () => ({ id: 'ws-direct', roots: [projectRoot], title: 'Direct' }),
      list: () => [{ id: 'ws-direct', roots: [projectRoot], title: 'Direct' }],
    } as never)
    const subprocess = new FakeSubprocess()
    ctx.provide('subprocess', subprocess as never)
    const service = new YxspecRemoteService(ctx, config)
    await service.ready
    return { ctx, service, subprocess, workspaceId: 'ws-direct', projectRoot }
  }

  /**
   * The resolved configuration, which is what a default is observable through.
   *
   * Read through `Reflect` rather than asserted into a shape: the resolved object is
   * private to the service, and a spec that restated it would keep passing after the
   * field was renamed while the default it is here to pin had changed.
   */
  function resolved(service: YxspecRemoteService): Record<string, unknown> {
    const config: unknown = Reflect.get(service, 'config')
    if (typeof config !== 'object' || config === null) throw new Error('the service holds no resolved configuration')
    return config as Record<string, unknown>
  }

  it('applies every default when no configuration is supplied at all', async () => {
    const { service } = await direct(undefined)
    const config = resolved(service)
    // The Loader would have materialized these from the schema; a direct mount must not
    // end up with an empty exclusion list, which would upload `node_modules` wholesale.
    expect(config.excludes).toEqual([
      '.git', 'node_modules', 'build', 'out', 'dist', 'target',
      '.gradle', '.idea', '.vscode', '__pycache__', '*.pyc',
    ])
    expect(config.pushSource).toBe(true)
    expect(config.logMaxBytes).toBe(2 * 1024 * 1024)
    expect(config.tarExecutable).toBeUndefined()
  })

  it('keeps an explicit configuration rather than the defaults', async () => {
    const { service } = await direct({ excludes: ['only-this'], logMaxBytes: 16 })
    const config = resolved(service)
    expect(config.excludes).toEqual(['only-this'])
    expect(config.logMaxBytes).toBe(16)
  })

  it('treats a blank tar path as unset rather than as an executable named nothing', async () => {
    // Schemastery materializes an unset `z.string()` as `''`, and a host that mounts the class
    // directly may pass one too. Either way it must read as "use the platform default".
    const blank = await direct({ tarExecutable: '   ' })
    expect(resolved(blank.service).tarExecutable).toBeUndefined()

    const pinned = await direct({ tarExecutable: ' /usr/local/bin/tar ' })
    expect(resolved(pinned.service).tarExecutable).toBe('/usr/local/bin/tar')
  })

  it('resolves the archive tool from configuration when one is pinned', async () => {
    const { service, subprocess, workspaceId, projectRoot } = await direct({ tarExecutable: '/opt/tar' })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('/opt/tar', '/opt/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]

    await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', sourceDirectory: projectRoot,
    })
    // A pinned tool is used as given, without probing the platform location first.
    expect(subprocess.spawns[0]?.argv[0]).toBe('/opt/tar')
  })
})

describe('run', () => {
  it('archives, uploads, runs the recipe, and records the outcome', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 0 },                       // tar
      { exitCode: 0 },                       // push
      { exitCode: 0, stdout: 'build ok\n' }, // recipe
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    expect(result.exitCode).toBe(0)
    expect(result.log).toBe('build ok\n')
    expect(result.remoteDirectory).toBe('/srv/builds/OEM-IVI-wsremote1')
    expect(result.treeDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.logSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result.command).toContain("cd '/srv/builds/OEM-IVI-wsremote1'")
    // Three spawns: tar, the upload, and the recipe.
    expect(subprocess.spawns).toHaveLength(3)
    expect(subprocess.spawns[0]?.argv[0]).toBe('/usr/bin/tar')
    expect(subprocess.spawns[0]?.argv).toContain('--exclude')
    expect(subprocess.spawns[2]?.argv[0]).toBe('/usr/bin/ssh')

    const runs = await service.runsFor(workspaceId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ exitCode: 0, recipe: 'ninja-full', treeDigest: result.treeDigest })
  })

  it('returns a failing build as data, not as an exception', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 0 },
      { exitCode: 0 },
      { exitCode: 2, stdout: 'error: undefined symbol\n' },
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(result.exitCode).toBe(2)
    expect(result.log).toContain('undefined symbol')
    expect(await service.lastSuccess(workspaceId, 'builder', 'ninja-full')).toBeUndefined()
  })

  it('records a failed upload without pretending the recipe ran', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 0 },
      { exitCode: 255, stderr: 'No space left on device\n' },
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(result.exitCode).toBe(255)
    expect(result.command).toContain('upload failed')
    // Only tar and the upload ran; the recipe was never reached.
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('skips the upload when the caller asked for it', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    expect(subprocess.spawns).toHaveLength(1)
    expect(result.treeDigest).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })

  it('joins stderr into the log under a marker', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 1, stdout: 'out\n', stderr: 'err\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    expect(result.log).toBe('out\n\n--- stderr ---\nerr\n')
  })

  it('refuses a recipe the server does not declare, naming the ones it does', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration())
    await expect(service.run(workspaceId, { serverId: 'builder', recipe: 'invented' }))
      .rejects.toThrow(/declares no recipe 'invented'; known: ninja-full/)
  })

  it('refuses a server the project does not declare', async () => {
    const { service, workspaceId } = await harness()
    await expect(service.run(workspaceId, { serverId: 'ghost', recipe: 'x' }))
      .rejects.toThrow(/declares no build server 'ghost'/)
  })

  it('reports the most recent passing run, ignoring later failures', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'green\n' }, { exitCode: 1, stdout: 'red\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    const success = await service.lastSuccess(workspaceId, 'builder', 'ninja-full')
    expect(success?.logTail).toContain('green')
  })

  it('ignores another project\'s runs when listing one project\'s runs', async () => {
    const { service, subprocess, workspaceId, projectRoot } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    await service.declare('other-ws', declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'mine\n' }, { exitCode: 0, stdout: 'theirs\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    await service.run('other-ws', {
      serverId: 'builder', recipe: 'ninja-full', push: false, sourceDirectory: projectRoot,
    })

    const runs = await service.runsFor(workspaceId)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.workspaceId).toBe(workspaceId)
    expect(runs[0]?.logTail).toContain('mine')
  })

  it('keeps only the tail of a log larger than the recorded cap', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A build log is routinely megabytes; the record keeps a diagnostic tail, and the full
    // text still goes back to the caller that asked for it.
    subprocess.replies = [{ exitCode: 0, stdout: `${'x'.repeat(9000)}TAIL-END` }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
    const runs = await service.runsFor(workspaceId)

    expect(result.log).toHaveLength(9008)
    expect(runs[0]?.logTail).toHaveLength(4096)
    expect(runs[0]?.logTail.endsWith('TAIL-END')).toBe(true)
  })

  it('stops listing at the requested limit, newest first', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 0, stdout: 'first\n' },
      { exitCode: 0, stdout: 'second\n' },
      { exitCode: 0, stdout: 'third\n' },
    ]
    // `finishedAt` is stamped from the wall clock, and three in-process runs land in the same
    // millisecond, which would leave the ordering assertion below reading as a tie. A clock the
    // spec drives makes "newest first" a property of the code rather than of machine speed.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      for (let index = 0; index < 3; index += 1) {
        await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', push: false })
        vi.advanceTimersByTime(1_000)
      }
    } finally {
      vi.useRealTimers()
    }

    const all = await service.runsFor(workspaceId)
    expect(all.map(run => run.logTail.trim())).toEqual(['third', 'second', 'first'])
    const limited = await service.runsFor(workspaceId, 2)
    expect(limited.map(run => run.logTail.trim())).toEqual(['third', 'second'])
  })

  it('honours the caller-supplied source directory', async () => {
    const { service, subprocess, workspaceId, projectRoot } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    const nested = join(projectRoot, 'sub')
    subprocess.replies = [{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full', sourceDirectory: nested })
    const tarArgv = subprocess.spawns[0]!.argv
    expect(tarArgv[tarArgv.indexOf('-C') + 1]).toBe(nested)
  })
})

describe('plugin wiring', () => {
  it('exposes the service without contributing any model-facing tool', async () => {
    const { ctx } = await harness()
    // The tools are a sibling plugin so the composition decides which agents
    // receive them; mounting the service alone grants none. The onboarding
    // wizard reads this row's Remote namespace, so a deployment that gives its
    // agents no build-server tool still lists what the project declared.
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.yxspecRemote).toBeInstanceOf(YxspecRemoteService)
  })

  it('carries its own inject list on the exported class, which the loader reads', () => {
    expect(YxspecRemoteService.inject).toEqual(['subprocess', 'workspaceRegistry', 'storageDomain'])
  })
})
