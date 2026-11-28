/**
 * The `yxspec` Remote namespace: the process state the desktop client renders.
 *
 * The controller is a projection and owns no rules — every value it returns
 * comes from `ctx.yxspec` and `ctx.yxspecArtifacts`, the same seams the gate and
 * freeze plugins consume. These specs pin that: the projection's shape, the
 * re-stat on every query, and the actionable failure when a seam is not mounted.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import YxspecService from '@deepseek-ai/dsh-yxspec'
import type { YxspecStage } from '@deepseek-ai/dsh-yxspec'
import { YxspecArtifactLedger } from '@deepseek-ai/dsh-yxspec-artifact'
import YxspecController from '../src/index.ts'
// Type-only: `remote.ts` carries the `ctx.yxspecRemoteController` Context merge.
import type {} from '../src/remote.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const MAPPING = 'project/inputs/extracted/swe-arch/mod-swr-mapping.json'
const SYMBOLS = 'project\\inputs\\extracted\\swe-arch\\swr-impl-symbols.json'

/** One two-step stage: `mapping` declares nothing, `freeze` declares both inputs. */
const STAGES: YxspecStage[] = [{
  id: 'swe-arch',
  title: '软件架构设计',
  aspice: 'SWE.2',
  group: 'design',
  steps: [
    { id: 'mapping', cell: '01-mapping.md', title: 'SWR→模块映射', frozen: false, requiredInputs: [] },
    {
      id: 'freeze', cell: '02-freeze.md', title: '❄ 映射冻结', frozen: true,
      requiredInputs: [MAPPING, SYMBOLS],
      gateScript: 'scripts/freeze-user-confirm.py',
    },
  ],
}]

/** A fresh scratch workspace, removed after the test. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-api-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Write one file under `root`, creating parents. */
async function seed(root: string, rel: string, body = '{}'): Promise<void> {
  const absolute = join(root, ...rel.split('/'))
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, body, 'utf8')
}

/**
 * Mount the domain service, the ledger, and the controller the deployment names.
 * @param root - workspace root.
 * @param present - workspace-relative files to seed before mounting.
 */
async function boot(root: string, present: readonly string[] = []) {
  for (const rel of present) await seed(root, rel)
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
  const ledger = await ctx.plugin(YxspecArtifactLedger)
  cleanups.push(() => ledger.dispose())
  const fiber = await ctx.plugin(YxspecController)
  cleanups.push(() => fiber.dispose())
  return { ctx, controller: ctx.yxspecController }
}

describe('the yxspec Remote namespace', () => {
  it('publishes the process namespace from its own service key', async () => {
    const { ctx, controller } = await boot(await scratch())
    expect(controller.typertRemote.serviceKey).toBe('yxspecController')
    expect(controller.typertRemote.namespace).toBe('yxspec')
    expect(remoteMethods(controller).map(marker => marker.method)).toEqual([
      'status',
      'documents',
      'declaredArtifacts',
      'declaredArtifactsOf',
    ])
    // The remote surface mounts alongside it, unconditionally; its own data
    // source is the optional half.
    expect(ctx.yxspecRemoteController.typertRemote.namespace).toBe('yxspecRemote')
  })

  it('projects the identity, stage model, and track map in one call', async () => {
    const root = await scratch()
    await seed(root, 'yxspec.json', JSON.stringify({
      spec_id: 'YX-IVI-1',
      project_name: '车载座舱',
      customer: '雅迅',
      product_type: 'IVI',
    }))
    await seed(root, 'project/config/swe-track-map.json', JSON.stringify({
      tracks: ['mcu', 'mpu'],
      domain_targets: { telemetry: 'mcu', media: 'mpu', ghost: 'nope', bad: 7 },
      domain_targets_evidence: { telemetry: 'CAN 总线' },
    }))
    const { controller } = await boot(root)

    const value = await controller.status()
    expect(value.identity).toEqual({
      specId: 'YX-IVI-1',
      projectName: '车载座舱',
      customer: '雅迅',
      productType: 'IVI',
    })
    expect(value.root).toBe(root)
    expect(value.tracks).toEqual(['mcu', 'mpu'])
    expect(value.domains).toEqual([
      { domain: 'telemetry', track: 'mcu', hasEvidence: true },
      { domain: 'media', track: 'mpu', hasEvidence: false },
    ])
  })

  it('reports each stage with its declared inputs still missing', async () => {
    const root = await scratch()
    const { controller } = await boot(root)

    const unlanded = await controller.status()
    // `status` names its parameter as the *stages* to compute landing for, not
    // the artifacts; nothing landed yet, so both inputs are reported missing.
    expect(unlanded.stages[0]).toMatchObject({ id: 'swe-arch', landed: false })
    expect(unlanded.stages[0]?.missing).toEqual([MAPPING, SYMBOLS])
    expect(unlanded.stages[0]?.steps).toEqual([
      {
        id: 'mapping', cell: '01-mapping.md', title: 'SWR→模块映射', frozen: false,
        requiredInputs: [], hasGateScript: false,
      },
      {
        id: 'freeze', cell: '02-freeze.md', title: '❄ 映射冻结', frozen: true,
        requiredInputs: [MAPPING, SYMBOLS], hasGateScript: true,
      },
    ])
  })

  it('re-stats on every query, so a file landing between calls is seen', async () => {
    const root = await scratch()
    const { controller } = await boot(root)
    expect((await controller.status()).stages[0]?.landed).toBe(false)

    // The ledger holds no cache of its own answer: a second call re-stats, which
    // is what lets the client poll a stage's progress.
    await seed(root, MAPPING)
    await seed(root, SYMBOLS)
    const landed = await controller.status()
    expect(landed.stages[0]?.landed).toBe(true)
    expect(landed.stages[0]?.missing).toEqual([])
  })

  it('omits landing information for a stage the caller did not ask about', async () => {
    const { controller } = await boot(await scratch())

    // The default is every stage; naming a subset keeps the report bounded while
    // the stage model itself is still returned whole.
    const named = await controller.status([])
    expect(named.stages).toHaveLength(1)
    expect(named.stages[0]).not.toHaveProperty('landed')
    expect(named.stages[0]).not.toHaveProperty('missing')

    const kept = await controller.status(['swe-arch'])
    expect(kept.stages[0]).toHaveProperty('landed')
  })

  it('lists the declared artifacts once each, POSIX-normalized and sorted', async () => {
    const { controller } = await boot(await scratch())

    // `SYMBOLS` is declared with backslashes in the model; the wire carries one
    // spelling so a client matching paths does not need both.
    expect(controller.declaredArtifacts()).toEqual([MAPPING, SYMBOLS.replace(/\\/g, '/')])
    expect(controller.declaredArtifactsOf('swe-arch'))
      .toEqual([MAPPING, SYMBOLS.replace(/\\/g, '/')])
    expect(controller.declaredArtifactsOf('ghost')).toEqual([])
  })

  it('lists the specification documents a project already holds', async () => {
    const root = await scratch()
    await seed(root, 'project/specs/aspice.pdf')
    const { ctx, controller } = await boot(root)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'p1', roots: [root] }],
    } as never)

    const found = await controller.documents('p1')
    expect(found.documents.map(view => view.path)).toEqual(['project/specs/aspice.pdf'])
    // The report names the directories walked, absolute, so an operator can compare them
    // against a file manager without knowing how the host resolves a project root.
    expect(found.searched).toContain(join(root, 'project'))
    expect(found.truncated).toBe(false)
  })

  it('returns an empty listing rather than failing on an unmounted registry', async () => {
    const { ctx, controller } = await boot(await scratch())
    // No workspace registry in this context: "this project has no inputs yet" is
    // a state the wizard renders, not an error.
    expect(ctx.get('workspaceRegistry')).toBeUndefined()
    await expect(controller.documents('p1')).resolves.toEqual({ documents: [], searched: [], truncated: false })
  })

  it('widens the search onto the directories the caller added', async () => {
    const root = await scratch()
    const added = await scratch()
    await seed(root, 'project/specs/aspice.pdf')
    await seed(added, 'delivered/prd.docx')
    const { ctx, controller } = await boot(root)
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: 'p1', roots: [root] }],
    } as never)

    // The additions arrive as an argument rather than as host state: this controller stays
    // read-only, and where one operator looked is not a property of the project. The operator's own
    // directory outranks the two the deployment walks on its own.
    const found = await controller.documents('p1', [added])
    expect(found.documents.map(view => view.path)).toEqual(['delivered/prd.docx', 'project/specs/aspice.pdf'])
    expect(found.documents[0]?.rootIndex).toBe(1)
    expect(found.searched).toContain(added)

    // Omitting the parameter searches the project's own layout alone.
    const alone = await controller.documents('p1')
    expect(alone.documents.map(view => view.path)).toEqual(['project/specs/aspice.pdf'])
    expect(alone.searched).not.toContain(added)
  })

  it('fails each read with an actionable code once its seam goes away', async () => {
    const root = await scratch()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const svc = await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    const ledger = await ctx.plugin(YxspecArtifactLedger)
    const fiber = await ctx.plugin(YxspecController)
    cleanups.push(() => fiber.dispose())
    expect(ctx.get('yxspecController')).toBeDefined()

    // Disposing the domain service is the deployment-side shape of "the seam this
    // controller projects is not mounted": the read path must answer with the code
    // it declares, not with cordis's "cannot get property without inject".
    await svc.dispose()
    expect(ctx.get('yxspec')).toBeUndefined()
    for (const call of [
      () => ctx.yxspecController.status(),
      () => ctx.yxspecController.declaredArtifacts(),
      () => ctx.yxspecController.declaredArtifactsOf('swe-arch'),
    ]) {
      try {
        await call()
        throw new Error('expected the call to fail')
      } catch (error) {
        expect(remoteErrorOf(error)?.code).toBe('yxspec/service-unavailable')
      }
    }

    // The other seam reports itself by name, so an operator can tell the two apart.
    await ledger.dispose()
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    try {
      await ctx.yxspecController.status()
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspec/ledger-unavailable')
    }
  })

  it('still lists declared artifacts when only the ledger is unmounted', async () => {
    const root = await scratch()
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(YxspecService, { workspaceRoot: root, stages: STAGES })
    const fiber = await ctx.plugin(YxspecController)
    cleanups.push(() => fiber.dispose())

    // The namespace is published even with no ledger: `declaredArtifacts` reads
    // only the stage model, and `status` reports the absent seam by name instead
    // of the whole section vanishing.
    expect(ctx.get('yxspecController')).toBeDefined()
    expect(ctx.yxspecController.declaredArtifacts()).toHaveLength(2)
    try {
      await ctx.yxspecController.status()
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspec/ledger-unavailable')
    }
  })
})

describe('the yxspecRemote Remote namespace', () => {
  it('publishes the build-server namespace from its own service key', async () => {
    const { ctx } = await boot(await scratch())
    expect(ctx.yxspecRemoteController.typertRemote.serviceKey).toBe('yxspecRemoteController')
    expect(ctx.yxspecRemoteController.typertRemote.namespace).toBe('yxspecRemote')
    expect(remoteMethods(ctx.yxspecRemoteController).map(marker => marker.method))
      .toEqual(['servers', 'browseServer', 'probeServer', 'declareServer'])
  })

  it('projects a declaration to what the browser actually renders', async () => {
    const { ctx } = await boot(await scratch())
    ctx.provide('yxspecRemote', {
      list: async () => [
        {
          serverId: 'build-01',
          title: '构建机',
          destination: 'ci@build.internal',
          projectDirectory: '/srv/yx',
          transport: 'ssh',
          recipes: { compile: 'cmake --build .', unitTest: 'ctest' },
          declaredAt: '2026-01-02T03:04:05.000Z',
          lastProbeAt: '2026-01-03T00:00:00.000Z',
          lastPlatform: 'linux',
          lastProbeError: 'Connection refused',
        },
        {
          serverId: 'build-02',
          title: '未探测',
          destination: 'ci@other',
          projectDirectory: '/srv/y2',
          transport: 'ssh',
          recipes: {},
          declaredAt: '2026-01-04T00:00:00.000Z',
        },
      ],
    } as never)

    const servers = await ctx.yxspecRemoteController.servers('p1')
    expect(servers).toEqual([
      {
        serverId: 'build-01',
        title: '构建机',
        destination: 'ci@build.internal',
        projectDirectory: '/srv/yx',
        transport: 'ssh',
        recipeIds: ['compile', 'unitTest'],
        declaredAt: '2026-01-02T03:04:05.000Z',
        lastProbeAt: '2026-01-03T00:00:00.000Z',
        lastPlatform: 'linux',
        lastProbeError: 'Connection refused',
      },
      {
        // The command templates behind the recipe ids stay server-side: a Remote
        // boundary carries what the caller reads.
        serverId: 'build-02',
        title: '未探测',
        destination: 'ci@other',
        projectDirectory: '/srv/y2',
        transport: 'ssh',
        recipeIds: [],
        declaredAt: '2026-01-04T00:00:00.000Z',
      },
    ])
  })

  it('reports an empty list on a deployment that mounts no remote plugin', async () => {
    const { ctx } = await boot(await scratch())
    // A browser-only deployment has no OpenSSH client and no storage domain, so
    // the wizard shows "no server declared yet" instead of failing to load.
    expect(ctx.get('yxspecRemote')).toBeUndefined()
    await expect(ctx.yxspecRemoteController.servers('p1')).resolves.toEqual([])
  })

  it('refuses a server list when no project was named', async () => {
    const { ctx } = await boot(await scratch())
    try {
      await ctx.yxspecRemoteController.servers('')
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/no-project')
    }
  })

  it('declares a server through the service that owns the record', async () => {
    const { ctx } = await boot(await scratch())
    const declared: unknown[] = []
    ctx.provide('yxspecRemote', {
      declare: async (_workspaceId: string, server: unknown) => {
        declared.push(server)
        return {
          workspaceId: 'p1',
          ...server as Record<string, unknown>,
          serverId: (server as { id: string }).id,
          projectDirectory: '/srv/yx',
          declaredAt: '2026-02-03T04:05:06.000Z',
        }
      },
    } as never)

    const view = await ctx.yxspecRemoteController.declareServer('p1', {
      serverId: 'build-01',
      destination: 'ci@build.internal',
      projectDirectory: '/srv/yx/',
      recipes: [
        { id: 'compile', command: 'cmake --build .', outputDirectory: '/srv/yx/out' },
        { id: 'unit', command: 'ctest' },
      ],
    })

    // The draft's optional fields are filled by the host: the label falls back to the id, the
    // timeout to the declared default, and an absent ssh client stays absent rather than
    // becoming an empty string the run would then try to execute.
    expect(declared).toEqual([{
      id: 'build-01',
      title: 'build-01',
      destination: 'ci@build.internal',
      projectDirectory: '/srv/yx/',
      transport: 'ssh',
      recipes: {
        compile: { command: 'cmake --build .', outputDirectory: '/srv/yx/out' },
        unit: { command: 'ctest' },
      },
      timeoutMs: 900_000,
    }])
    expect(view).toEqual({
      serverId: 'build-01',
      title: 'build-01',
      destination: 'ci@build.internal',
      projectDirectory: '/srv/yx',
      transport: 'ssh',
      recipeIds: ['compile', 'unit'],
      declaredAt: '2026-02-03T04:05:06.000Z',
    })
  })

  it('carries the operator’s optional values through instead of the defaults', async () => {
    const { ctx } = await boot(await scratch())
    const declared: unknown[] = []
    ctx.provide('yxspecRemote', {
      declare: async (_workspaceId: string, server: unknown) => {
        declared.push(server)
        return {
          workspaceId: 'p1',
          ...server as Record<string, unknown>,
          serverId: (server as { id: string }).id,
          declaredAt: '2026-02-03T04:05:06.000Z',
        }
      },
    } as never)

    await ctx.yxspecRemoteController.declareServer('p1', {
      serverId: 'aosp',
      title: '  构建机  ',
      destination: 'ci@aosp',
      projectDirectory: '/srv/aosp',
      captureRevision: true,
      recipes: [{ id: 'ninja', command: 'ninja -C {cwd} OUT={out}', outputDirectory: '/srv/aosp-out' }],
      timeoutMs: 60_000,
      sshExecutable: '/usr/bin/ssh',
    })

    expect(declared).toEqual([{
      id: 'aosp',
      title: '构建机',
      destination: 'ci@aosp',
      projectDirectory: '/srv/aosp',
      captureRevision: true,
      transport: 'ssh',
      recipes: { ninja: { command: 'ninja -C {cwd} OUT={out}', outputDirectory: '/srv/aosp-out' } },
      sshExecutable: '/usr/bin/ssh',
      timeoutMs: 60_000,
    }])
  })

  it('fails loudly when the deployment mounts no build-server service', async () => {
    const { ctx } = await boot(await scratch())
    // Unlike the list, which answers "none declared", a declaration that landed nowhere would
    // look to the operator exactly like one that landed and was not shown.
    try {
      await ctx.yxspecRemoteController.declareServer('p1', {
        serverId: 'build-01',
        destination: 'ci@build.internal',
        projectDirectory: '/srv/yx',
        recipes: [{ id: 'compile', command: 'make' }],
      })
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/service-unavailable')
    }
  })

  it('reports the service’s own reason for refusing a declaration', async () => {
    const { ctx } = await boot(await scratch())
    ctx.provide('yxspecRemote', {
      declare: async () => {
        throw new Error("server 'build-01' projectDirectory must be an absolute server path")
      },
    } as never)

    try {
      await ctx.yxspecRemoteController.declareServer('p1', {
        serverId: 'build-01',
        destination: 'ci@build.internal',
        projectDirectory: 'srv/yx',
        recipes: [{ id: 'compile', command: 'make' }],
      })
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/rejected')
      // The message is the operator's only account of what to fix, so it survives the hop.
      expect((error as Error).message).toContain('projectDirectory must be an absolute server path')
    }
  })

  it('reports what a probe of a declared server found', async () => {
    const { ctx } = await boot(await scratch())
    const asked: string[] = []
    ctx.provide('yxspecRemote', {
      probe: async (workspaceId: string, serverId: string) => {
        asked.push(`${workspaceId}:${serverId}`)
        return { serverId, reachable: true, outputPresent: false, platform: 'Linux' }
      },
    } as never)

    await expect(ctx.yxspecRemoteController.probeServer('p1', 'build-01')).resolves.toEqual({
      serverId: 'build-01', reachable: true, outputPresent: false, platform: 'Linux',
    })
    expect(asked).toEqual(['p1:build-01'])
  })

  it('carries a directory listing back from the host, with no project involved', async () => {
    // The one call here that names a destination rather than a declaration: the operator browses
    // before the declaration exists, so there is no project id to require.
    const { ctx } = await boot(await scratch())
    const asked: unknown[] = []
    ctx.provide('yxspecRemote', {
      browse: async (request: unknown) => {
        asked.push(request)
        return {
          directory: '/users/builder',
          parent: '/users',
          entries: ['projects', 'projects/aosp'],
          depth: 2,
          truncated: false,
        }
      },
    } as never)

    await expect(ctx.yxspecRemoteController.browseServer({ destination: 'builder@farm' })).resolves.toEqual({
      directory: '/users/builder',
      parent: '/users',
      entries: ['projects', 'projects/aosp'],
      depth: 2,
      truncated: false,
    })
    expect(asked).toEqual([{ destination: 'builder@farm' }])
  })

  it('reports a host that refused a listing, rather than an empty directory', async () => {
    const { ctx } = await boot(await scratch())
    ctx.provide('yxspecRemote', {
      browse: async () => { throw new Error("browse directory must be an absolute server path, got 'srv/x'") },
    } as never)

    try {
      await ctx.yxspecRemoteController.browseServer({ destination: 'builder@farm', directory: 'srv/x' })
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/rejected')
      expect((error as Error).message).toContain('must be an absolute server path')
    }
  })

  it('fails loudly when a deployment mounts no build-server service to browse', async () => {
    const { ctx } = await boot(await scratch())
    try {
      await ctx.yxspecRemoteController.browseServer({ destination: 'builder@farm' })
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/service-unavailable')
    }
  })

  it('fails loudly when a deployment mounts no build-server service to probe', async () => {
    const { ctx } = await boot(await scratch())
    try {
      await ctx.yxspecRemoteController.probeServer('p1', 'build-01')
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/service-unavailable')
    }
  })

  it('carries the service\'s own words when it refuses to probe an unknown server', async () => {
    const { ctx } = await boot(await scratch())
    ctx.provide('yxspecRemote', {
      probe: async () => {
        throw new Error("project 'p1' declares no build server 'ghost'; known: build-01")
      },
    } as never)

    try {
      await ctx.yxspecRemoteController.probeServer('p1', 'ghost')
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/rejected')
      expect((error as Error).message).toContain("declares no build server 'ghost'")
    }
  })

  it('refuses a probe when no project was named', async () => {
    const { ctx } = await boot(await scratch())
    try {
      await ctx.yxspecRemoteController.probeServer('', 'build-01')
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/no-project')
    }
  })

  it('refuses a declaration when no project was named', async () => {
    const { ctx } = await boot(await scratch())
    try {
      await ctx.yxspecRemoteController.declareServer('', {
        serverId: 'build-01',
        destination: 'ci@build.internal',
        projectDirectory: '/srv/yx',
        recipes: [{ id: 'compile', command: 'make' }],
      })
      throw new Error('expected the call to fail')
    } catch (error) {
      expect(remoteErrorOf(error)?.code).toBe('yxspecRemote/no-project')
    }
  })
})
