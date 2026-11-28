/**
 * Remote build seam tests. The transport is exercised against a recording
 * subprocess double rather than a real server: what is under test is the
 * service's own decisions — what a declaration stores, what a recipe renders
 * to, how a failure is classified, which products may be fetched, and what
 * lands in the ledger — none of which need a network to be wrong.
 *
 * The double answers on the `spawn` contract (`handle.done`,
 * `handle.collected.stdout.readFrom`, and a raw piped stdout for a fetch) so
 * the production call sites are exercised unchanged, and it records every argv
 * so a test can assert the exact client invocation rather than a summary of it.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import ToolsService from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as yxspecRemote from '../src/index.ts'
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
  /** Raw bytes streamed on a piped stdout instead of a collected reply. */
  readonly pipe?: Buffer | string
  /** Files a local extraction (an argv carrying `-C <dir>`) leaves on disk. */
  readonly extracted?: Record<string, string | { dir: true }>
}

/**
 * Recording subprocess double.
 *
 * Replies are drawn from a queue when one is supplied, so a test can script a
 * revision read followed by a build with different outcomes; otherwise
 * `defaultReply` answers every spawn. A reply with `pipe` bytes turns the
 * handle's stdout into a live readable that emits them, which is the shape a
 * fetch's `stdout: 'pipe'` spawn produces. `resolveExecutable` answers the
 * executable lookups the service performs on first use, which keeps a test
 * from depending on the machine having a particular ssh client installed.
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
  failSpawn: Error | string | undefined
  /** How many spawns `failSpawn` applies to before calls succeed again. */
  failSpawnCount = Number.POSITIVE_INFINITY
  /** Milliseconds to hold a command open before it reports its exit, if any. */
  settleDelayMs = 0

  /** Provide a handle shaped exactly as the production call sites read it. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.failSpawn !== undefined && this.failSpawnCount-- > 0) throw this.failSpawn
    this.spawns.push({ argv: spec.argv, spec })
    const reply = this.replies.length > 1 ? this.replies.shift()! : (this.replies[0] ?? this.defaultReply)
    // A local `tar -xzf` invocation is expected to leave its extracted files
    // behind: the service sizes the products by statting them, so a double that
    // only reported an exit would fail at the read. The `-C` argument names the
    // directory the extraction targets; a reply may script what it unpacked.
    const into = spec.argv.indexOf('-C') >= 0 ? spec.argv[spec.argv.indexOf('-C') + 1] : undefined
    if (into !== undefined && reply.exitCode === 0) {
      const extracted = reply.extracted
        ?? { 'system.img': 'system-image-bytes\n', 'sub/app.bin': 'application-bytes\n' }
      for (const [name, body] of Object.entries(extracted)) {
        const path = join(into, ...name.split('/'))
        if (typeof body === 'string') {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, body)
        } else {
          mkdirSync(path, { recursive: true })
        }
      }
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
    // A fetch spawns ssh with `stdout: 'pipe'`; the archive arrives as raw
    // bytes on that stream, so the handle exposes a live readable emitting the
    // scripted bytes rather than a collected reader.
    let stdout: Readable | undefined
    if (spec.stdio.stdout === 'pipe') {
      stdout = new Readable({ read() {} })
      const bytes = reply.pipe ?? ''
      if (bytes !== '') {
        stdout.push(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
      }
      stdout.push(null)
    }
    // A piped stdin must accept a caller's stream and signal completion: the
    // production path resolves on the writable's completion, so the double is a
    // real Writable that discards bytes and ends normally.
    const stdin = spec.stdio.stdin === 'pipe'
      ? new Writable({
        write: (_chunk, _encoding, callback) => { callback() },
      })
      : undefined
    return {
      stdin: stdin as never,
      stdout: stdout as never,
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

/** A throwaway local tree, as a stand-in for any project the registry names. */
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
    projectDirectory: '/srv/checkout',
    transport: 'ssh' as const,
    recipes: { 'ninja-full': { command: 'ninja -C {out} all' } },
    timeoutMs: 900_000,
    ...overrides,
  }
}

describe('recipe rendering', () => {
  it('binds the working directory and prefixes a failure-propagating shell', () => {
    expect(renderRecipe('make -j', { cwd: '/srv/builds/p', out: '/srv/builds/p/out' }))
      .toBe("set -e; cd '/srv/builds/p'; make -j")
  })

  it('replaces both tokens, so a recipe can point the build at its output tree', () => {
    expect(renderRecipe('a {cwd} b {out}', { cwd: '/x', out: '/y' }))
      .toBe("set -e; cd '/x'; a /x b /y")
  })

  it('replaces every occurrence of each token', () => {
    expect(renderRecipe('a {cwd} b {cwd}', { cwd: '/x', out: '/x/out' }))
      .toBe("set -e; cd '/x'; a /x b /x")
  })

  it('appends one-off arguments without disturbing the template', () => {
    expect(renderRecipe('make', { cwd: '/x', out: '/x/out' }, '  -j8  '))
      .toBe("set -e; cd '/x'; make -j8")
  })

  it('ignores whitespace-only extra arguments', () => {
    expect(renderRecipe('make', { cwd: '/x', out: '/x/out' }, '   '))
      .toBe("set -e; cd '/x'; make")
  })
})

describe('declaration', () => {
  it('stores and lists a declaration with its recipes', async () => {
    const { service, workspaceId } = await harness()
    const stored = await service.declare(workspaceId, declaration(), '2026-01-01T00:00:00.000Z')
    expect(stored).toMatchObject({
      serverId: 'builder',
      destination: 'aosp-builder',
      projectDirectory: '/srv/checkout',
      recipes: { 'ninja-full': { command: 'ninja -C {out} all' } },
    })
    const servers = await service.list(workspaceId)
    expect(servers).toHaveLength(1)
    expect(servers[0]).toMatchObject({ serverId: 'builder', projectDirectory: '/srv/checkout' })
  })

  it('normalizes trailing slashes off the project and each recipe directory', async () => {
    const { service, workspaceId } = await harness()
    // A trailing slash would double up inside the rendered `cd` and the fetch
    // paths, so it is trimmed once at the durable edge — per recipe, because
    // each recipe's directory travels separately.
    const stored = await service.declare(workspaceId, declaration({
      projectDirectory: '/srv/checkout///',
      recipes: {
        full: { command: 'ninja', outputDirectory: '/srv/out/full/' },
        module: { command: 'ninja system_module', outputDirectory: '/srv/out/module//' },
      },
    }))
    expect(stored.projectDirectory).toBe('/srv/checkout')
    expect(stored.recipes.full?.outputDirectory).toBe('/srv/out/full')
    expect(stored.recipes.module?.outputDirectory).toBe('/srv/out/module')
  })

  it('keeps a directory of the remote root rather than collapsing it', async () => {
    const { service, workspaceId } = await harness()
    // An absolute root is a legitimate project directory: it trims to nothing,
    // which must read as `/` and not as an empty path segment.
    const root = await service.declare(workspaceId, declaration({
      projectDirectory: '/',
      recipes: { r: { command: 'true', outputDirectory: '/out/' } },
    }))
    expect(root.projectDirectory).toBe('/')
    expect(root.recipes.r?.outputDirectory).toBe('/out')
  })

  it('stores an omitted recipe directory as absent, not as a resolved default', async () => {
    const { service, workspaceId } = await harness()
    // Resolving the default at declaration time would freeze today's convention
    // into every stored row; the record must stay honest so a deployment that
    // moves the default is not contradicted by older recipes.
    const stored = await service.declare(workspaceId, declaration())
    expect(stored.recipes['ninja-full']?.outputDirectory).toBeUndefined()
    expect(Object.keys(stored.recipes['ninja-full'] ?? {}).sort())
      .not.toContain('outputDirectory')
  })

  it('lets two recipes of one server name two different output directories', async () => {
    const { service, workspaceId } = await harness()
    // A whole build and a module build of one tree write their products to
    // different places; the server-level directory this model replaces could
    // only ever describe one of them.
    const stored = await service.declare(workspaceId, declaration({
      recipes: {
        full: { command: 'ninja all', outputDirectory: '/srv/out/full' },
        module: { command: 'ninja system_module', outputDirectory: '/srv/out/module' },
      },
    }))
    expect(stored.recipes.full).toEqual({ command: 'ninja all', outputDirectory: '/srv/out/full' })
    expect(stored.recipes.module).toEqual({ command: 'ninja system_module', outputDirectory: '/srv/out/module' })
  })

  it('keeps captureRevision only when the declaration asked for it', async () => {
    const { service, workspaceId } = await harness()
    const off = await service.declare(workspaceId, declaration())
    expect(off.captureRevision).toBeUndefined()
    const on = await service.declare(workspaceId, declaration({ captureRevision: true }))
    expect(on.captureRevision).toBe(true)
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

  it('forgets a declaration but keeps the runs it produced', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(await service.forget(workspaceId, 'builder')).toBe(true)
    expect(await service.list(workspaceId)).toEqual([])
    // The evidence of the build survives the declaration that produced it.
    expect(await service.runsFor(workspaceId)).toHaveLength(1)
  })

  it('rejects a declaration that could not run: id, destination, directories, timeout, recipes', async () => {
    const { service, workspaceId } = await harness()
    await expect(service.declare(workspaceId, declaration({ id: '  ' })))
      .rejects.toThrow(/non-empty id/)
    await expect(service.declare(workspaceId, declaration({ destination: '' })))
      .rejects.toThrow(/needs a destination/)
    await expect(service.declare(workspaceId, declaration({ projectDirectory: 'srv/checkout' })))
      .rejects.toThrow(/projectDirectory must be an absolute server path/)
    await expect(service.declare(workspaceId, declaration({ timeoutMs: 0 })))
      .rejects.toThrow(/positive timeoutMs/)
    await expect(service.declare(workspaceId, declaration({ timeoutMs: Number.POSITIVE_INFINITY })))
      .rejects.toThrow(/positive timeoutMs/)
    await expect(service.declare(workspaceId, declaration({ recipes: {} })))
      .rejects.toThrow(/declares no recipes/)
  })

  it('rejects a recipe-level output directory that could not resolve, naming the recipe', async () => {
    const { service, workspaceId } = await harness()
    // The recipe id is in the message because a server declares several recipes
    // and the operator must know which one's directory to fix.
    await expect(service.declare(workspaceId, declaration({
      recipes: { 'ninja-full': { command: 'ninja', outputDirectory: 'srv/out' } },
    }))).rejects.toThrow(/recipe 'ninja-full' outputDirectory must be an absolute server path/)
    await expect(service.declare(workspaceId, declaration({
      recipes: { clean: { command: 'true' }, 'ninja-full': { command: 'ninja', outputDirectory: 'out' } },
    }))).rejects.toThrow(/recipe 'ninja-full' outputDirectory must be an absolute server path/)
    expect(await service.list(workspaceId)).toEqual([])
  })

  it('rejects a recipe a run could never name, exactly as the tool layer does', async () => {
    const { service, workspaceId } = await harness()
    // The tool layer strips these before they reach the seam, but a host may mount the
    // service directly. An unnamed recipe is the dangerous one: it would make the run-time
    // "known: ..." listing read as empty for a server that does declare something.
    await expect(service.declare(workspaceId, declaration({ recipes: { '  ': { command: 'true' } } })))
      .rejects.toThrow(/recipe with a blank id/)
    await expect(service.declare(workspaceId, declaration({ recipes: { r: { command: '   ' } } })))
      .rejects.toThrow(/recipe 'r' needs a non-empty command/)
    expect(await service.list(workspaceId)).toEqual([])
  })

  it('orders declarations by when they were declared', async () => {
    const { service, workspaceId } = await harness()
    // Declared out of order, so the sort is what produces the listing order.
    await service.declare(workspaceId, declaration({ id: 'later' }), '2026-03-01T00:00:00.000Z')
    await service.declare(workspaceId, declaration({ id: 'earlier' }), '2026-01-01T00:00:00.000Z')

    expect((await service.list(workspaceId)).map(record => record.serverId))
      .toEqual(['earlier', 'later'])
  })
})

describe('browse', () => {
  it('answers for several levels of one directory in a single round trip', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 0, stdout: '/users/builder\nPARENT=/users\n./projects\n./projects/aosp\n' }]

    const listing = await service.browse({ destination: 'builder@farm' })

    expect(listing).toEqual({
      directory: '/users/builder',
      parent: '/users',
      entries: ['projects', 'projects/aosp'],
      depth: 2,
      truncated: false,
    })
    // One walk, not one `ls` per level: the picker navigates what this answer already covers, and
    // `cd` with no argument is how the login directory is reached — a quoted `~` would be literal.
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]?.argv.at(-1)).toBe(
      'set -e; cd; pwd; echo "PARENT=$(dirname "$PWD")"; '
      + 'find . -mindepth 1 -maxdepth 2 -type d -print | head -n 201 || true',
    )
  })

  it('lists a named directory, quoted so a path with a quote survives the shell', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 0, stdout: "/srv/it's\nPARENT=/srv\n" }]

    const listing = await service.browse({ destination: 'builder@farm', directory: "/srv/it's" })

    expect(listing.directory).toBe("/srv/it's")
    // The quote is closed, escaped, and reopened: the one way a single-quoted shell word carries
    // a quote of its own without letting the path end the quoting.
    expect(subprocess.spawns[0]?.argv.at(-1)).toContain("cd '/srv/it'\\''s'")
  })

  it('bounds the walk by the depth it was asked for, and never past its own ceiling', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 0, stdout: '/srv\nPARENT=/\n' }]

    await service.browse({ destination: 'builder@farm', directory: '/srv', depth: 3 })
    expect(subprocess.spawns[0]?.argv.at(-1)).toContain('-maxdepth 3')

    await service.browse({ destination: 'builder@farm', directory: '/srv', depth: 99 })
    expect(subprocess.spawns[1]?.argv.at(-1)).toContain('-maxdepth 4')

    await service.browse({ destination: 'builder@farm', directory: '/srv', depth: 0 })
    expect(subprocess.spawns[2]?.argv.at(-1)).toContain('-maxdepth 1')
  })

  it('reports the ceiling when the walk stopped at it', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    const many = Array.from({ length: 201 }, (_, index) => `./d${String(index).padStart(3, '0')}`).join('\n')
    subprocess.replies = [{ exitCode: 0, stdout: `/srv\nPARENT=/\n${many}\n` }]

    const listing = await service.browse({ destination: 'builder@farm', directory: '/srv' })

    expect(listing.entries).toHaveLength(200)
    expect(listing.truncated).toBe(true)
  })

  it('offers no way up from the filesystem root', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 0, stdout: '/\nPARENT=/\n' }]

    const listing = await service.browse({ destination: 'builder@farm', directory: '/' })

    // The root is its own parent; a control that walks nowhere is worse than no control.
    expect(listing.parent).toBeUndefined()
  })

  it('reports a directory that is not there with the path named', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 3, stdout: 'NO_SUCH_DIR\n' }]

    const listing = await service.browse({ destination: 'builder@farm', directory: '/nope' })

    expect(listing.error).toBe("no directory '/nope' on builder@farm")
    expect(listing.entries).toEqual([])
    expect(listing.depth).toBe(2)
  })

  it('names the client when the machine refused to answer', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [{ exitCode: 255, stderr: 'Permission denied (publickey).\n' }]

    const listing = await service.browse({ destination: 'builder@farm' })

    expect(listing.error).toBe('ssh exited 255 (client /usr/bin/ssh): Permission denied (publickey).')
  })

  it('reports a listing the client never produced as an error rather than a directory', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.failSpawn = new Error('no such binary')

    const failed = await service.browse({ destination: 'builder@farm' })
    expect(failed.error).toContain('no such binary')

    // An unresolvable client is the same kind of answer: the picker renders it, it does not throw.
    subprocess.failSpawn = undefined
    subprocess.replies = [{ exitCode: 0, stdout: '/srv\nPARENT=/\n' }]
    const unresolved = await service.browse({ destination: 'builder@farm', sshExecutable: '/nowhere/ssh' })
    expect(unresolved.error).toContain('/nowhere/ssh')
  })

  it('reports an empty answer rather than pretending the listing was of nothing', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.replies = [
      { exitCode: 0, stdout: '\n' },
      // A client that printed one line and no newline is a different output shape, read the same
      // way: the directory is on the first line whether or not another line follows it.
      { exitCode: 0, stdout: '/srv' },
    ]

    const listing = await service.browse({ destination: 'builder@farm' })

    expect(listing.error).toBe('the server reported no directory')
    expect((await service.browse({ destination: 'builder@farm' })).directory).toBe('/srv')
  })

  it('reports a listing the deadline cut off as a timeout', async () => {
    const { service, subprocess } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.settleDelayMs = 40
    subprocess.replies = [{ exitCode: 0, stdout: '/srv\nPARENT=/\n' }]

    const listing = await service.browse({ destination: 'builder@farm', timeoutMs: 1 })

    expect(listing.error).toContain('timed out')
  })

  it('refuses a relative directory, which is a caller mistake rather than a host answer', async () => {
    const { service } = await harness()

    await expect(service.browse({ destination: 'builder@farm', directory: 'srv/x' }))
      .rejects.toThrow('browse directory must be an absolute server path')
  })
})

describe('probe', () => {
  it('reports reachability, both directory checks, and records the platform', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'Linux\nOUT_OK\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: true, outputPresent: true, platform: 'Linux' })
    // One round trip answers every question the probe reports: the platform,
    // the project directory (whose absence exits nonzero), and the output one.
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]?.argv.at(-1)).toBe(
      "set -e; uname -s; if [ -d '/srv/checkout' ]; then echo PROJECT_OK; else echo PROJECT_MISSING; "
      + 'echo "HOME=$HOME"; [ -d "$HOME/srv/checkout" ] && echo "ALT=$HOME/srv/checkout" || true; fi; '
      + "[ -d '/srv/checkout/out' ] && echo OUT_OK || echo OUT_MISSING",
    )
    const stored = await service.server(workspaceId, 'builder')
    expect(stored?.lastPlatform).toBe('Linux')
    expect(stored?.lastProbeAt).toBeDefined()
    expect(stored?.lastProbeError).toBeUndefined()
  })

  it('drops the previous failure when a later probe succeeds, keeping the platform', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A machine that answers today and not tomorrow is the same machine: the platform a probe has
    // already observed survives a failure, while the failure itself must not survive a success.
    subprocess.replies = [
      { exitCode: 0, stdout: 'Linux\nOUT_OK\n' },
      { exitCode: 255, stderr: 'Connection refused\n' },
      { exitCode: 0, stdout: 'Linux\nOUT_OK\n' },
    ]

    await service.probe(workspaceId, 'builder')
    await service.probe(workspaceId, 'builder')
    expect((await service.server(workspaceId, 'builder'))?.lastProbeError).toContain('Connection refused')

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.reachable).toBe(true)
    const stored = await service.server(workspaceId, 'builder')
    expect(stored?.lastProbeError).toBeUndefined()
    expect(stored?.lastPlatform).toBe('Linux')
  })

  it('bounds a probe by the probe budget rather than the declaration\'s run budget', async () => {
    // The declaration allows a fifteen-minute compile; a connection test must not inherit it, so
    // this deployment caps probes at a millisecond and the stalled client loses that race.
    const { service, subprocess, workspaceId } = await harness({ probeTimeoutMs: 1 })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ timeoutMs: 900_000 }))
    subprocess.settleDelayMs = 40
    subprocess.replies = [{ exitCode: 0, stdout: 'Linux\nOUT_OK\n' }]

    const probe = await service.probe(workspaceId, 'builder')

    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('timed out')
  })

  it('keeps a declaration\'s own shorter budget when it is below the probe cap', async () => {
    // The other arm of the same choice: a declaration that asked for less than the deployment
    // allows still gets what it asked for.
    const { service, subprocess, workspaceId } = await harness({ probeTimeoutMs: 60_000 })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ timeoutMs: 1 }))
    subprocess.settleDelayMs = 40
    subprocess.replies = [{ exitCode: 0, stdout: 'Linux\nOUT_OK\n' }]

    const probe = await service.probe(workspaceId, 'builder')

    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('timed out')
  })

  it('reports the project directory missing with the path named, and stays reachable:false', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // `set -e` plus the explicit exit keeps a missing tree from reading as a
    // successful probe of a machine that has nothing to build.
    subprocess.replies = [{ exitCode: 3, stdout: 'Linux\nPROJECT_MISSING\nHOME=/users/builder\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.reachable).toBe(false)
    // The login directory travels with the miss: a share path and a server path look alike, and this
    // is what tells the operator which one they typed.
    expect(probe.error).toBe("no directory '/srv/checkout' on aosp-builder; the login directory is '/users/builder'")
    expect(probe.platform).toBeUndefined()
    // The outcome is stored, not just returned: a list rendered after this probe has to describe
    // the attempt, or the row looks like one nobody ever tested.
    const stored = await service.server(workspaceId, 'builder')
    expect(stored?.lastProbeAt).toBeDefined()
    expect(stored?.lastProbeError).toBe("no directory '/srv/checkout' on aosp-builder; the login directory is '/users/builder'")
  })

  it('names the path that exists when the declared one is a share spelling of it', async () => {
    // The mistake this exists to end: `\\host\user\projects\x` browsed from Windows is
    // `/users/<user>/projects/x` on the machine, and the probe finds it in the same round trip.
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{
      exitCode: 3,
      stdout: 'Linux\nPROJECT_MISSING\nHOME=/users/builder\nALT=/users/builder/srv/checkout\n',
    }]

    const probe = await service.probe(workspaceId, 'builder')

    expect(probe.reachable).toBe(false)
    expect(probe.error).toBe(
      "no directory '/srv/checkout' on aosp-builder; it exists at '/users/builder/srv/checkout' — declare that path",
    )
  })

  it('reports the miss alone when the machine answered with neither hint', async () => {
    // A remote shell that printed nothing else still yields a usable message rather than a blank,
    // and so does one that printed the key with nothing after it — an unset variable, in a shell
    // whose login environment differs from the interactive one.
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 3, stdout: 'Linux\nPROJECT_MISSING\n' },
      { exitCode: 3, stdout: 'Linux\nPROJECT_MISSING\nHOME=\n' },
    ]

    expect((await service.probe(workspaceId, 'builder')).error)
      .toBe("no directory '/srv/checkout' on aosp-builder")
    expect((await service.probe(workspaceId, 'builder')).error)
      .toBe("no directory '/srv/checkout' on aosp-builder")
  })

  it('checks the per-recipe default directory, because no recipe ran', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    // The server declares two recipes with two different directories; the probe
    // cannot know which would run, so it reports the directory a recipe that
    // names none would use — the shared default.
    await service.declare(workspaceId, declaration({
      recipes: {
        full: { command: 'ninja all', outputDirectory: '/srv/out/full' },
        module: { command: 'ninja system_module', outputDirectory: '/srv/out/module' },
      },
    }))
    subprocess.replies = [{ exitCode: 0, stdout: 'Linux\nOUT_MISSING\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    // A missing output directory is a fact about the machine — a build creates
    // it — so the probe succeeds while reporting the absence.
    expect(probe).toEqual({ serverId: 'builder', reachable: true, outputPresent: false, platform: 'Linux' })
    expect(subprocess.spawns[0]?.argv.at(-1)).toBe(
      "set -e; uname -s; if [ -d '/srv/checkout' ]; then echo PROJECT_OK; else echo PROJECT_MISSING; "
      + 'echo "HOME=$HOME"; [ -d "$HOME/srv/checkout" ] && echo "ALT=$HOME/srv/checkout" || true; fi; '
      + "[ -d '/srv/checkout/out' ] && echo OUT_OK || echo OUT_MISSING",
    )
  })

  it('reports an unreachable server as data rather than throwing', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 255, stderr: 'Host key verification failed.\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.reachable).toBe(false)
    expect(probe.error).toContain('Host key verification failed')
    expect((await service.server(workspaceId, 'builder'))?.lastProbeError).toContain('Host key verification failed')
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
    subprocess.failSpawn = 'permission denied'

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: false, error: 'permission denied' })
  })

  it('reports a probe whose client wrote no platform line at all', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A server that answered only the directory checks: reachable, but with no
    // platform to record — so the absence must not be written as a value.
    subprocess.replies = [{ exitCode: 0, stdout: 'OUT_OK\n' }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe).toEqual({ serverId: 'builder', reachable: true, outputPresent: true })
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
    expect(probe.error).toBe('connection timed out (client /usr/bin/ssh)')
  })

  it('reports an unhandled probe failure with only the exit code it saw', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // An exit code with no diagnostic on either stream: the message must still
    // say something actionable.
    subprocess.replies = [{ exitCode: 7 }]

    const probe = await service.probe(workspaceId, 'builder')
    expect(probe.error).toBe('ssh exited 7 (client /usr/bin/ssh)')
  })

  it('carries a caller cancellation into the probe', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'Darwin\nOUT_OK\n' }]
    const controller = new AbortController()

    await service.probe(workspaceId, 'builder', controller.signal)
    expect(subprocess.spawns[0]?.spec.signal).toBeInstanceOf(AbortSignal)
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
    // The Loader would have materialized these from the schema; a direct mount
    // must land on the same budgets, because a run's caps must not depend on
    // which of the two mounting paths a deployment used.
    expect(config.logMaxBytes).toBe(2 * 1024 * 1024)
    expect(config.fetchMaxBytes).toBe(512 * 1024 * 1024)
    expect(config.tarExecutable).toBeUndefined()
  })

  it('keeps an explicit configuration rather than the defaults', async () => {
    const { service } = await direct({ logMaxBytes: 16, fetchMaxBytes: 32 })
    const config = resolved(service)
    expect(config.logMaxBytes).toBe(16)
    expect(config.fetchMaxBytes).toBe(32)
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
    const { service, subprocess, workspaceId } = await direct({ tarExecutable: '/opt/tar' })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('/opt/tar', '/opt/tar')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [
      { exitCode: 0, stdout: 'abc123\n' },                       // revision
      { exitCode: 0, stdout: 'build ok\n' },                     // recipe
      { exitCode: 0, pipe: 'archive\n' },                        // fetch tar
    ]

    await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'], fetchInto: '/tmp/fetch',
    })
    // A pinned tool is used as given, without probing the platform location first.
    expect(subprocess.spawns.at(-1)?.argv[0]).toBe('/opt/tar')
  })
})

describe('run', () => {
  it('runs the recipe inside the project directory and records the outcome', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'build ok\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    expect(result.exitCode).toBe(0)
    expect(result.log).toBe('build ok\n')
    // The output directory was never declared, so the per-run default resolved
    // it: the recipe's `{out}` token and the record name the same directory.
    expect(result.outputDirectory).toBe('/srv/checkout/out')
    expect(result.projectDirectory).toBe('/srv/checkout')
    expect(result.command).toBe("set -e; cd '/srv/checkout'; ninja -C /srv/checkout/out all")
    expect(result.logSha256).toMatch(/^[0-9a-f]{64}$/)
    // One spawn: the recipe. Nothing is uploaded, so there is no tar step.
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]?.argv[0]).toBe('/usr/bin/ssh')

    const runs = await service.runsFor(workspaceId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      exitCode: 0,
      recipe: 'ninja-full',
      projectDirectory: '/srv/checkout',
      outputDirectory: '/srv/checkout/out',
      command: result.command,
    })
  })

  it('resolves the output directory from the recipe that ran, per run', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({
      recipes: {
        full: { command: 'ninja all {out}', outputDirectory: '/srv/out/full/' },
        module: { command: 'ninja system_module && cp -r {out} {cwd}/staging' },
      },
    }))
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }, { exitCode: 0, stdout: 'ok\n' }]

    const full = await service.run(workspaceId, { serverId: 'builder', recipe: 'full' })
    // The recipe's own directory wins, normalized, and feeds both the record
    // and the `{out}` token the command was rendered with.
    expect(full.outputDirectory).toBe('/srv/out/full')
    expect(full.command).toBe("set -e; cd '/srv/checkout'; ninja all /srv/out/full")

    const module = await service.run(workspaceId, { serverId: 'builder', recipe: 'module' })
    // The recipe that named none resolved the shared default; each run's ledger
    // entry records the directory its own recipe resolved to, so two recipes of
    // one server produce two honest records.
    expect(module.outputDirectory).toBe('/srv/checkout/out')
    expect(module.command).toContain('cp -r /srv/checkout/out')
    const runs = await service.runsFor(workspaceId)
    const byRecipe = new Map(runs.map(run => [run.recipe, run.outputDirectory]))
    expect(byRecipe.get('full')).toBe('/srv/out/full')
    expect(byRecipe.get('module')).toBe('/srv/checkout/out')
  })

  it('fetches products relative to the directory of the recipe that ran', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    const into = await mkdtemp(join(tmpdir(), 'dsh-yxspec-into-'))
    cleanups.push(() => rm(into, { recursive: true, force: true }))
    await service.declare(workspaceId, declaration({
      recipes: { module: { command: 'ninja system_module', outputDirectory: '/srv/out/module' } },
    }))
    subprocess.replies = [
      { exitCode: 0, stdout: 'ok\n' },
      { exitCode: 0, pipe: 'TAR\n' },
      { exitCode: 0 },
    ]

    const result = await service.run(workspaceId, {
      serverId: 'builder', recipe: 'module', fetch: ['system.img'], fetchInto: into,
    })
    // The fetch runs inside the recipe's directory, not the shared default: a
    // product path is meaningless outside the tree the recipe itself wrote to.
    expect(subprocess.spawns[1]?.argv.at(-1)).toBe(
      "set -e; cd '/srv/out/module'; tar -czf - -- 'system.img'",
    )
    expect(result.outputDirectory).toBe('/srv/out/module')
  })

  it('returns a failing build as data, not as an exception', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 2, stdout: 'error: undefined symbol\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(result.exitCode).toBe(2)
    expect(result.log).toContain('undefined symbol')
    expect(await service.lastSuccess(workspaceId, 'builder', 'ninja-full')).toBeUndefined()
  })

  it('joins stderr into the log under a marker', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 1, stdout: 'out\n', stderr: 'err\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
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

  it('reports the known server ids when a declaration is missing', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration({ id: 'known' }))
    await expect(service.run(workspaceId, { serverId: 'ghost', recipe: 'r' }))
      .rejects.toThrow(/known: known/)
  })

  it('reports a project that declared nothing with an explicit (none)', async () => {
    const { service } = await harness()
    // A declaration written against a removed project must say "no server
    // exists there" rather than an empty "known:", which would read as a
    // formatting accident instead of an answer.
    await expect(service.run('empty-project', { serverId: 'ghost', recipe: 'r' }))
      .rejects.toThrow(/known: \(none\)/)
  })

  it('reports the most recent passing run, ignoring later failures', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'green\n' }, { exitCode: 1, stdout: 'red\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    const success = await service.lastSuccess(workspaceId, 'builder', 'ninja-full')
    expect(success?.logTail).toContain('green')
  })

  it('ignores another project\'s runs when listing one project\'s runs', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    await service.declare('other-ws', declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'mine\n' }, { exitCode: 0, stdout: 'theirs\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    await service.run('other-ws', { serverId: 'builder', recipe: 'ninja-full' })

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

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
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
        await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
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

  it('carries a caller cancellation into the run', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]
    const controller = new AbortController()

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' }, controller.signal)
    expect(subprocess.spawns[0]?.spec.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports a run the deadline cut off as timed out with its exit facts', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ timeoutMs: 1 }))
    // The command is still open when the deadline fires; `timedOut` is read off
    // the deadline's own signal, so it holds even though a reply eventually lands.
    subprocess.settleDelayMs = 40
    subprocess.replies = [{ exitCode: 0, stdout: 'late\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(result.timedOut).toBe(true)
  })

  it('memoizes each ssh client across runs', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('/opt/ssh', '/opt/ssh')
    await service.declare(workspaceId, declaration())
    await service.declare(workspaceId, declaration({ id: 'pinned', sshExecutable: '/opt/ssh' }))
    subprocess.replies = [
      { exitCode: 0, stdout: 'a\n' },
      { exitCode: 0, stdout: 'b\n' },
      { exitCode: 0, stdout: 'c\n' },
    ]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'pinned', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    // Three runs resolved each distinct client exactly once, because a build
    // farm's tool paths do not move between runs.
    expect(subprocess.executablesResolutions.filter(name => name === 'ssh')).toHaveLength(1)
    expect(subprocess.executablesResolutions.filter(name => name === '/opt/ssh')).toHaveLength(1)
  })

  it('falls back to the deployment\'s configured client when a declaration names none', async () => {
    // A password-only build host is reached through a wrapper the deployment pins once, so the
    // operator does not repeat the path in every declaration.
    const { service, subprocess, workspaceId } = await harness({ sshExecutable: '/opt/wrapped-ssh' })
    subprocess.executables.set('/opt/wrapped-ssh', '/opt/wrapped-ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    expect(subprocess.executablesResolutions).toContain('/opt/wrapped-ssh')
    expect(subprocess.executablesResolutions).not.toContain('ssh')
  })

  it('lets a declaration pin its own client over the configured one', async () => {
    const { service, subprocess, workspaceId } = await harness({ sshExecutable: '/opt/wrapped-ssh' })
    subprocess.executables.set('/opt/wrapped-ssh', '/opt/wrapped-ssh')
    subprocess.executables.set('/opt/ssh', '/opt/ssh')
    await service.declare(workspaceId, declaration({ sshExecutable: '/opt/ssh' }))
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })

    expect(subprocess.executablesResolutions).toContain('/opt/ssh')
    expect(subprocess.executablesResolutions).not.toContain('/opt/wrapped-ssh')
  })

  it('memoizes one inherited client across declarations that both inherit it', async () => {
    const { service, subprocess, workspaceId } = await harness({ sshExecutable: '/opt/wrapped-ssh' })
    subprocess.executables.set('/opt/wrapped-ssh', '/opt/wrapped-ssh')
    await service.declare(workspaceId, declaration())
    await service.declare(workspaceId, declaration({ id: 'second' }))
    subprocess.replies = [{ exitCode: 0, stdout: 'a\n' }, { exitCode: 0, stdout: 'b\n' }]

    await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    await service.run(workspaceId, { serverId: 'second', recipe: 'ninja-full' })

    // Two declarations, one configured client, one lookup: the cache keys on the resolved value
    // rather than on the row that happened to inherit it.
    expect(subprocess.executablesResolutions.filter(name => name === '/opt/wrapped-ssh')).toHaveLength(1)
  })
})

describe('revision capture', () => {
  it('reads the revision before the build when the declaration asks for one', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    subprocess.replies = [
      { exitCode: 0, stdout: '9f3c1a2b4d5e\n' },   // revision
      { exitCode: 0, stdout: 'build ok\n' },       // recipe
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // Two spawns: the revision read, then the recipe.
    expect(subprocess.spawns).toHaveLength(2)
    // The read runs from the declared project directory: `repo` trees answer
    // with a manifest, plain git trees with the commit.
    expect(subprocess.spawns[0]?.argv.at(-1)).toBe(
      "set -e; cd '/srv/checkout'; if [ -d .repo ]; then repo manifest -r; else git rev-parse HEAD; fi",
    )
    expect(result.revision).toBe('9f3c1a2b4d5e')
    expect(result.revisionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.revisionError).toBeUndefined()

    const runs = await service.runsFor(workspaceId)
    expect(runs[0]).toMatchObject({ revision: '9f3c1a2b4d5e' })
    expect(runs[0]?.revisionDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips the revision read by default', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // One spawn only: a repo walk costs minutes on an automotive tree, so the
    // capture is strictly opt-in.
    expect(subprocess.spawns).toHaveLength(1)
    expect(result.revision).toBeUndefined()
    expect(result.revisionDigest).toBeUndefined()
  })

  it('records a failed revision read without failing the build', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    subprocess.replies = [
      { exitCode: 128, stderr: 'fatal: not a git repository\n' },  // revision
      { exitCode: 0, stdout: 'build ok\n' },                       // recipe
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // The revision is evidence about the run, not the run itself: a run that
    // compiled is worth more than an unreadable label.
    expect(result.exitCode).toBe(0)
    expect(result.revision).toBeUndefined()
    expect(result.revisionDigest).toBeUndefined()
    // The client is named in the report: two OpenSSH installations on one machine read different
    // key stores, and which one refused is what the operator needs to know.
    expect(result.revisionError).toBe('ssh exited 128 (client /usr/bin/ssh): fatal: not a git repository')
  })

  it('records a revision read the provider refused to start without failing the build', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    // The first spawn (the revision read) is refused by the provider itself —
    // the failure mode where no client process ever exists.
    subprocess.failSpawn = new Error('spawn EACCES')
    subprocess.failSpawnCount = 1
    const refused = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // The refused read does not sink the run: the provider recovered for the
    // recipe spawn, which the recorded second spawn proves.
    expect(refused.revisionError).toBe('spawn EACCES')
    expect(refused.revision).toBeUndefined()
    expect(refused.exitCode).toBe(0)
    expect(subprocess.spawns).toHaveLength(1)
  })

  it('records an empty revision output as an error rather than as an identity', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    subprocess.replies = [
      { exitCode: 0, stdout: '\n' },         // revision: printed nothing usable
      { exitCode: 0, stdout: 'build ok\n' },
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(result.revisionError).toBe('the revision command printed nothing')
    expect(result.revision).toBeUndefined()
  })

  it('stores a multi-line manifest as a digest only, with no revision label', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    subprocess.replies = [
      { exitCode: 0, stdout: '<?xml version="1.0"?>\n<manifest>\n</manifest>\n' },  // repo manifest
      { exitCode: 0, stdout: 'build ok\n' },
    ]

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // A manifest is a document, not a label: its digest identifies the input,
    // and keeping a first line as the revision would misname it.
    expect(result.revision).toBeUndefined()
    expect(result.revisionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(result.revisionError).toBeUndefined()
  })

  it('keeps a revision label only within the readable-line budget', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration({ captureRevision: true }))
    // A one-line answer at exactly 200 characters stays a label; a longer one
    // is a document, recorded by digest alone.
    const exact = 'a'.repeat(200)
    subprocess.replies = [
      { exitCode: 0, stdout: `${exact}\n` },
      { exitCode: 0, stdout: 'ok\n' },
    ]
    const within = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(within.revision).toBe(exact)
    expect(within.revisionDigest).toMatch(/^[0-9a-f]{64}$/)

    subprocess.replies = [
      { exitCode: 0, stdout: `${'a'.repeat(201)}\n` },
      { exitCode: 0, stdout: 'ok\n' },
    ]
    const over = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    expect(over.revision).toBeUndefined()
    expect(over.revisionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(over.revisionError).toBeUndefined()
  })
})

describe('fetch', () => {
  /** A local directory a fetch expands into, registered for cleanup. */
  async function fetchInto(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-yxspec-into-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  it('refuses paths that could leave the output directory, before anything runs', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    // A path that climbs out, names an absolute location, or hides behind a
    // tilde would turn a build tool into a file-copy tool wearing its name.
    for (const path of ['../etc/passwd', '/etc/passwd', '~/keys', ' passwd ']) {
      await expect(service.run(workspaceId, {
        serverId: 'builder', recipe: 'ninja-full', fetch: [path], fetchInto: '/tmp/into',
      })).rejects.toThrow(new RegExp(`fetch path '${path.replaceAll(' ', '\\s')}' must be relative`))
    }
    // Refusal happens before the build: no client was resolved, no spawn ran.
    expect(subprocess.spawns).toEqual([])
  })

  it('refuses an empty fetch path', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration())
    await expect(service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: [''], fetchInto: '/tmp/into',
    })).rejects.toThrow(/fetch path '' must be relative/)
  })

  it('refuses a fetch that names no local destination', async () => {
    const { service, workspaceId } = await harness()
    await service.declare(workspaceId, declaration())
    // Products with nowhere defined to land would silently pick a directory
    // the caller never asked about.
    await expect(service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'],
    })).rejects.toThrow(/fetching products needs fetchInto/)
  })

  it('brings named products back under a per-run directory, with sizes', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration({
      recipes: { 'ninja-full': { command: 'ninja -C {out} all', outputDirectory: '/srv/out' } },
    }))
    const into = await fetchInto()
    subprocess.replies = [
      { exitCode: 0, stdout: 'build ok\n' },   // recipe
      { exitCode: 0, pipe: 'TAR-ARCHIVE\n' },  // fetch tar stream
      { exitCode: 0, extracted: { 'system.img': 'system-image-bytes\n' } },  // local extraction
    ]

    const result = await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img', 'sub/app.bin'], fetchInto: into,
    })
    expect(result.exitCode).toBe(0)
    // The fetch streams `tar -czf -` from inside the output directory.
    expect(subprocess.spawns).toHaveLength(3)
    expect(subprocess.spawns[1]?.argv.at(-1)).toBe("set -e; cd '/srv/out'; tar -czf - -- 'system.img' 'sub/app.bin'")
    // The extraction expanded into a run-<timestamp> directory of the destination.
    const extractArgv = subprocess.spawns[2]?.argv ?? []
    expect(extractArgv[0]).toBe('/usr/bin/tar')
    const runDirectory = extractArgv[extractArgv.indexOf('-C') + 1] ?? ''
    expect(runDirectory.startsWith(into)).toBe(true)
    expect(runDirectory).toContain('run-')

    // One entry per requested path, in request order, sized from disk — and a
    // product the archive did not carry reads as zero bytes rather than as a
    // failed transfer, which is the archive's answer, not the build's.
    expect(result.fetched).toHaveLength(2)
    expect(result.fetched?.[0]).toMatchObject({
      path: 'system.img',
      localPath: join(runDirectory, 'system.img'),
      bytes: 'system-image-bytes\n'.length,
    })
    expect(result.fetched?.[0]?.error).toBeUndefined()
    expect(result.fetched?.[1]).toEqual({
      path: 'sub/app.bin',
      localPath: join(runDirectory, 'sub', 'app.bin'),
      bytes: 0,
    })
  })

  it('reports a failed transfer per requested path while the build verdict stands', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    const into = await fetchInto()
    subprocess.replies = [
      { exitCode: 0, stdout: 'build ok\n' },                    // recipe
      { exitCode: 255, stderr: 'tar: system.img: Cannot open\n', pipe: '' },  // fetch
    ]

    const result = await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img', 'other.bin'], fetchInto: into,
    })
    // The build already happened; the products are an extra. The failure is
    // per-path data, never an exception hiding the exit code.
    expect(result.exitCode).toBe(0)
    expect(result.fetched).toEqual([
      { path: 'system.img', localPath: '', bytes: 0, error: 'tar: system.img: Cannot open' },
      { path: 'other.bin', localPath: '', bytes: 0, error: 'tar: system.img: Cannot open' },
    ])
  })

  it('aborts a fetch past the byte ceiling and reports it per path', async () => {
    const { service, subprocess, workspaceId } = await harness({ fetchMaxBytes: 8 })
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    const into = await fetchInto()
    subprocess.replies = [
      { exitCode: 0, stdout: 'build ok\n' },
      { exitCode: 0, pipe: 'x'.repeat(64) },  // exceeds the 8-byte ceiling
    ]

    const result = await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'], fetchInto: into,
    })
    expect(result.exitCode).toBe(0)
    // The ceiling is a deliberate deployment budget, so its message says both
    // the number and the way out.
    expect(result.fetched?.[0]?.error).toBe('the products exceed the 8-byte fetch ceiling; name fewer or smaller paths')
    expect(result.fetched?.[0]?.bytes).toBe(0)
  })

  it('reports a fetched path that unpacked as a directory as zero bytes, not a failure', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    const into = await fetchInto()
    subprocess.replies = [
      { exitCode: 0, stdout: 'ok\n' },
      { exitCode: 0, pipe: 'TAR\n' },
      // The archive held a directory where a product was expected; a `stat`
      // answers, but not with a file.
      { exitCode: 0, extracted: { 'system.img': { dir: true } } },
    ]

    const result = await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'], fetchInto: into,
    })
    expect(result.exitCode).toBe(0)
    expect(result.fetched).toEqual([
      { path: 'system.img', localPath: expect.stringContaining('system.img'), bytes: 0 },
    ])
  })

  it('memoizes the archive tool across fetches', async () => {
    const { service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    subprocess.executables.set('tar', '/usr/bin/tar')
    await service.declare(workspaceId, declaration())
    const into = await fetchInto()
    subprocess.replies = [
      { exitCode: 0, stdout: 'one\n' },
      { exitCode: 0, pipe: 'TAR\n' },
      { exitCode: 0 },
      { exitCode: 0, stdout: 'two\n' },
      { exitCode: 0, pipe: 'TAR\n' },
      { exitCode: 0 },
    ]

    await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'], fetchInto: into,
    })
    await service.run(workspaceId, {
      serverId: 'builder', recipe: 'ninja-full', fetch: ['system.img'], fetchInto: into,
    })
    // Two fetches resolved the archive tool exactly once: the platform probe
    // is a per-deployment answer, not a per-run one.
    expect(subprocess.executablesResolutions.filter(name => name === 'tar')).toHaveLength(1)
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
    // The service reads subprocesses and durable storage only; the workspace
    // registry is not a dependency any more, because nothing derives a remote
    // path from a project title.
    expect(YxspecRemoteService.inject).toEqual(['subprocess', 'storageDomain'])
  })

  it('emits the settled run after the ledger write', async () => {
    const { ctx, service, subprocess, workspaceId } = await harness()
    subprocess.executables.set('ssh', '/usr/bin/ssh')
    await service.declare(workspaceId, declaration())
    subprocess.replies = [{ exitCode: 0, stdout: 'ok\n' }]
    // `null` is in the type because a signal-killed client reports one; this run exits zero.
    const seen: Array<{ exitCode: number | null; workspaceId: string }> = []
    ctx.on('yxspec/remote-run', (result, workspace) => {
      seen.push({ exitCode: result.exitCode, workspaceId: workspace })
    })

    const result = await service.run(workspaceId, { serverId: 'builder', recipe: 'ninja-full' })
    // A listener reading `runsFor` inside the event must see the run it was
    // told about, so the write strictly precedes the emit.
    expect(seen).toEqual([{ exitCode: 0, workspaceId }])
    expect((await service.runsFor(workspaceId)).map(run => run.runId)).toContain(result.runId)
  })
})
