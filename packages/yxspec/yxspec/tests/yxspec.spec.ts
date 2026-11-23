/**
 * The YXSpec domain service, which every enforcement plugin gates on: identity
 * resolution order, the declared stage model, per-agent active-step ownership,
 * and the two deployment files it reads.
 *
 * The service owns no enforcement, so these specs assert what it *answers* —
 * never what it refuses. Identity is the one place a deployment restates state
 * that may also live in the project's own `yxspec.json`, so the precedence
 * between the two is pinned here rather than inferred from the constructor.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import YxspecService from '../src/index.ts'
import type { YxspecSpecIdentity, YxspecStage, YxspecStep } from '../src/index.ts'
import { sessionDeclaresYxspecProcess } from '../src/project.ts'
import type { ProjectScope } from '../src/project.ts'
import { JSON_TOOL_OUTPUT } from '../src/tool-output.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A throwaway workspace root, removed with the test that made it. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-domain-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Write a JSON fixture at an absolute path, creating its parents. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
}

/** Deployment configuration shape, restated because the package does not export `Config`. */
interface ConfigShape {
  workspaceRoot?: string
  identity?: YxspecSpecIdentity
  trackMapPath?: string
  projectConfigPath?: string
  stages?: YxspecStage[]
}

/** Mount the service over a fresh context and hand back both. */
async function mount(root: string, config: ConfigShape = {}) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  const fiber = await ctx.plugin(YxspecService, { workspaceRoot: root, ...config })
  cleanups.push(() => fiber.dispose())
  return { ctx, service: ctx.yxspec }
}

/** One step with the fields a test does not care about filled in. */
function step(id: string, overrides: Partial<YxspecStep> = {}): YxspecStep {
  return { id, cell: `${id}.md`, title: id, frozen: false, requiredInputs: [], ...overrides }
}

/** A two-step stage whose second step is a ❄ point. */
function twoStepStage(): YxspecStage {
  return {
    id: 'swe-arch',
    title: '软件架构设计',
    aspice: 'SWE.2',
    group: 'design',
    steps: [
      step('mapping', { requiredInputs: ['project/inputs/mapping.json'] }),
      step('freeze', { frozen: true, requiredInputs: ['project/inputs/frozen.json'] }),
    ],
  }
}

/** A landed predicate answering from a fixed set of present paths. */
function landedAmong(present: readonly string[]): (path: string) => Promise<boolean> {
  return async (path: string) => present.includes(path)
}

describe('identity resolution', () => {
  it('prefers the deployment config over the project file', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), {
      spec_id: 'from-file',
      project_name: 'File Project',
      customer: 'File Customer',
      product_type: 'file-type',
    })
    const { service } = await mount(root, {
      identity: {
        specId: 'from-config',
        projectName: 'Config Project',
        customer: 'Config Customer',
        productType: 'config-type',
      },
    })

    expect(service.spec).toEqual({
      specId: 'from-config',
      projectName: 'Config Project',
      customer: 'Config Customer',
      productType: 'config-type',
    })
  })

  it('falls back to the project file, field by field', async () => {
    const root = await workspace()
    // A numeric `spec_id` is not text, so that one field alone must fall through
    // to the placeholder while its neighbours come from the file.
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), {
      spec_id: 5,
      project_name: 'File Project',
      customer: 'File Customer',
      product_type: 'ivi',
    })
    const { service } = await mount(root)

    expect(service.spec).toEqual({
      specId: 'unspecified',
      projectName: 'File Project',
      customer: 'File Customer',
      productType: 'ivi',
    })
  })

  it('treats an empty file field as absent rather than as a name', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), {
      project_name: '',
      customer: 'File Customer',
    })
    const { service } = await mount(root)

    expect(service.spec.projectName).toBe('unspecified')
    expect(service.spec.customer).toBe('File Customer')
  })

  it('reports the placeholder identity for a workspace with no project file', async () => {
    const { service } = await mount(await workspace())
    expect(service.spec).toEqual({
      specId: 'unspecified',
      projectName: 'unspecified',
      customer: 'unspecified',
      productType: 'unspecified',
    })
  })

  it('ignores a project file that is not JSON', async () => {
    const root = await workspace()
    const path = join(root, 'project', 'config', 'yxspec.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'not json at all', 'utf8')
    const { service } = await mount(root)
    expect(service.spec.specId).toBe('unspecified')
  })

  it('ignores a project file that declares nothing recognisable', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), { unrelated: true })
    const { service } = await mount(root)
    expect(service.spec.specId).toBe('unspecified')
  })

  it('reads the project file from a configured path instead of the default', async () => {
    const root = await workspace()
    await writeJson(join(root, 'custom', 'identity.json'), { spec_id: 'custom-path' })
    const { service } = await mount(root, { projectConfigPath: 'custom/identity.json' })
    expect(service.spec.specId).toBe('custom-path')
  })
})

describe('stage model', () => {
  it('ships the SWE.1–SWE.5 default model when the deployment declares none', async () => {
    const { service } = await mount(await workspace())
    expect(service.stages().map(stage => stage.aspice)).toEqual([
      'SWE.1', 'SWE.2', 'SWE.3', 'SWE.4', 'SWE.5',
    ])
  })

  it('uses the deployment stage model when one is declared', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    expect(service.stages()).toHaveLength(1)
    expect(service.stages()[0]?.id).toBe('swe-arch')
  })

  it('resolves a stage by id, and reports an unknown one as absent', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    expect(service.stage('swe-arch')?.title).toBe('软件架构设计')
    expect(service.stage('no-such-stage')).toBeUndefined()
  })

  it('resolves a step across the whole model, with its owning stage', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const found = service.step('freeze')
    expect(found?.stage.id).toBe('swe-arch')
    expect(found?.step.frozen).toBe(true)
    // The scan crosses every stage, so a step id no stage declares ends absent.
    expect(service.step('ghost')).toBeUndefined()
  })

  it('answers frozen-ness, and treats an unknown step as not frozen', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    expect(service.isFrozenStep('freeze')).toBe(true)
    expect(service.isFrozenStep('mapping')).toBe(false)
    expect(service.isFrozenStep('ghost')).toBe(false)
  })

  it('answers status for only the stages it is asked about', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const status = await service.status('ghost', landedAmong([]))
    expect(status).toEqual({ stage: 'ghost', currentStep: undefined, complete: false })
  })

  it('walks a stage from the first step that lacks its inputs', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const first = await service.status('swe-arch', landedAmong(['project/inputs/mapping.json']))
    expect(first.currentStep).toBe('mapping')
    expect(first.complete).toBe(false)

    const both = await service.status(
      'swe-arch',
      landedAmong(['project/inputs/mapping.json', 'project/inputs/frozen.json']),
    )
    expect(both.currentStep).toBe('freeze')
    expect(both.complete).toBe(true)

    const none = await service.status('swe-arch', landedAmong([]))
    expect(none.currentStep).toBeUndefined()
    expect(none.complete).toBe(false)
  })

  it('treats a step with no declared inputs as satisfied, and one with a miss as not', async () => {
    const { service } = await mount(await workspace())
    expect(await service.inputsLanded(step('open'), landedAmong([]))).toBe(true)
    expect(await service.inputsLanded(step('gated', { requiredInputs: ['a'] }), landedAmong(['a']))).toBe(true)
    expect(await service.inputsLanded(step('gated', { requiredInputs: ['a'] }), landedAmong([]))).toBe(false)
  })
})

describe('active step ownership', () => {
  it('is undefined until a step is set, and follows the step the agent was given', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const agent = {}
    expect(service.activeStep(agent)).toBeUndefined()

    expect(service.setActiveStep(agent, 'mapping')).toBe(true)
    expect(service.activeStep(agent)?.step.id).toBe('mapping')
  })

  it('clears the active step when handed undefined', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const agent = {}
    service.setActiveStep(agent, 'mapping')
    expect(service.setActiveStep(agent, undefined)).toBe(true)
    expect(service.activeStep(agent)).toBeUndefined()
  })

  it('refuses a step id the model does not declare', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    expect(service.setActiveStep({}, 'ghost')).toBe(false)
  })

  it('keys progress per agent, so a fan-out does not gate on a sibling', async () => {
    const { service } = await mount(await workspace(), { stages: [twoStepStage()] })
    const first = {}
    const second = {}
    service.setActiveStep(first, 'mapping')
    service.setActiveStep(second, 'freeze')
    expect(service.activeStep(first)?.step.id).toBe('mapping')
    expect(service.activeStep(second)?.step.id).toBe('freeze')
    // Re-reading the same agent reuses the minted key rather than minting another.
    expect(service.activeStep(first)?.step.id).toBe('mapping')
    service.setActiveStep(first, undefined)
    expect(service.activeStep(second)?.step.id).toBe('freeze')
  })
})

describe('track map and snapshot', () => {
  it('reports the default tracks when the workspace has no track map', async () => {
    const { service } = await mount(await workspace())
    expect(await service.domains()).toEqual([])
    expect((await service.snapshot()).tracks).toEqual(['mcu', 'mpu'])
  })

  it('reads domain targets with their evidence', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
      tracks: ['mcu', 'both'],
      domain_targets: { power: 'mcu', hmi: 'mpu', shared: 'both' },
      domain_targets_evidence: { power: 'PRD §3.1', hmi: '', shared: 42 },
    })
    const { service } = await mount(root)

    expect(await service.domains()).toEqual([
      { domain: 'power', track: 'mcu', evidence: 'PRD §3.1' },
      { domain: 'hmi', track: 'mpu' },
      { domain: 'shared', track: 'both' },
    ])
    expect(await service.trackOf('power')).toBe('mcu')
    // An unmapped domain defaults to both tracks rather than to one of them.
    expect(await service.trackOf('nothing-declared')).toBe('both')
    expect((await service.snapshot()).tracks).toEqual(['mcu', 'both'])
  })

  it('keeps the same domain list across calls, which is what the cache is for', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
      domain_targets: { power: 'mcu' },
    })
    const { service } = await mount(root)
    const first = await service.domains()
    expect(await service.domains()).toBe(first)
  })

  it('drops track names the closed vocabulary does not contain', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
      tracks: ['mcu', 'xpu'],
    })
    const { service } = await mount(root)
    expect((await service.snapshot()).tracks).toEqual(['mcu'])
  })

  it('falls back to both tracks when every declared name is unknown', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), { tracks: ['xpu'] })
    const { service } = await mount(root)
    expect((await service.snapshot()).tracks).toEqual(['mcu', 'mpu'])
  })

  it('treats a non-array track list as undeclared', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), { tracks: 'mcu' })
    const { service } = await mount(root)
    expect((await service.snapshot()).tracks).toEqual(['mcu', 'mpu'])
  })

  it('reports no domains when the target map is absent or not a map', async () => {
    for (const domainTargets of [undefined, null, 'mcu', ['mcu']]) {
      const root = await workspace()
      await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
        domain_targets: domainTargets,
      })
      const { service } = await mount(root)
      expect(await service.domains()).toEqual([])
    }
  })

  it('skips a domain whose track is not text or not a known track', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
      domain_targets: { numeric: 5, unknown: 'xpu', real: 'mpu' },
      domain_targets_evidence: 'not a map',
    })
    const { service } = await mount(root)
    expect(await service.domains()).toEqual([{ domain: 'real', track: 'mpu' }])
  })

  it('ignores a track map that is not JSON, or that is JSON but not an object', async () => {
    for (const body of ['{ not json', '5', 'null']) {
      const root = await workspace()
      const path = join(root, 'project', 'config', 'swe-track-map.json')
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body, 'utf8')
      const { service } = await mount(root)
      expect(await service.domains()).toEqual([])
      expect((await service.snapshot()).tracks).toEqual(['mcu', 'mpu'])
    }
  })

  it('reads the track map from a configured path instead of the default', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'custom-track-map.json'), {
      domain_targets: { power: 'mcu' },
    })
    const { service } = await mount(root, { trackMapPath: 'project/custom-track-map.json' })
    expect(await service.domains()).toEqual([{ domain: 'power', track: 'mcu' }])
  })

  it('assembles one snapshot from the identity, model, domains, and tracks', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'swe-track-map.json'), {
      tracks: ['both'],
      domain_targets: { power: 'both' },
    })
    const { service } = await mount(root, { stages: [twoStepStage()] })

    const snapshot = await service.snapshot()
    expect(snapshot.identity.specId).toBe('unspecified')
    expect(snapshot.stages.map(stage => stage.id)).toEqual(['swe-arch'])
    expect(snapshot.domains).toEqual([{ domain: 'power', track: 'both' }])
    expect(snapshot.tracks).toEqual(['both'])
  })
})

describe('direct construction', () => {
  it('falls back to the working directory when no root is configured', async () => {
    // Restated because the loader always materializes `workspaceRoot`; the field
    // is optional on the class, and a direct mount must still resolve a root.
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    const service = new YxspecService(ctx, {})
    expect(service.root).toBe(resolve(process.cwd()))
    expect(service.stages().length).toBeGreaterThan(0)
  })
})

describe('session project membership', () => {
  /** The two Host reads the predicate answers from, over a fixed cwd. */
  function scope(cwd: string, roots: readonly string[]): ProjectScope<string> {
    return {
      workingDirectory: { get: () => cwd },
      workspaceRegistry: { list: () => roots.length === 0 ? [] : [{ roots }] },
    }
  }

  it('is true when the cwd is a root of a project declaring the process', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), {})
    expect(sessionDeclaresYxspecProcess(scope(root, [root]), 'session-1')).toBe(true)
  })

  it('is false when the project declares no process', async () => {
    const root = await workspace()
    expect(sessionDeclaresYxspecProcess(scope(root, [root]), 'session-1')).toBe(false)
  })

  it('is false when the cwd belongs to no declared project', async () => {
    const root = await workspace()
    await writeJson(join(root, 'project', 'config', 'yxspec.json'), {})
    expect(sessionDeclaresYxspecProcess(scope(join(root, 'nested'), [root]), 'session-1')).toBe(false)
  })

  it('is false when no project is declared at all', () => {
    expect(sessionDeclaresYxspecProcess(scope('/tmp/anywhere', []), 'session-1')).toBe(false)
  })

  it('reads the declaration from the project\'s primary root, whichever root the session entered through', async () => {
    // A vehicle program spans several repositories, so a Session may enter
    // through the MCU firmware checkout rather than the primary one. The marker
    // is one project-level fact, so it is read from the project's first root —
    // the canonical place the onboarding wizard writes it — and a secondary
    // root that happens to carry its own copy is not a second declaration.
    const primary = await workspace()
    const secondary = await workspace()
    await writeJson(join(primary, 'project', 'config', 'yxspec.json'), {})
    await writeJson(join(secondary, 'project', 'config', 'yxspec.json'), {})
    expect(sessionDeclaresYxspecProcess(scope(secondary, [primary, secondary]), 'session-1')).toBe(true)

    // Without the primary root's marker the answer is false even though the
    // Session's own root carries one: the project, not the checkout, declares.
    await rm(join(primary, 'project', 'config', 'yxspec.json'))
    expect(sessionDeclaresYxspecProcess(scope(secondary, [primary, secondary]), 'session-1')).toBe(false)
  })
})

describe('shared tool output contract', () => {
  it('declares an open object and renders the value as indented JSON', () => {
    // Pinned here because five tools across two packages depend on this one
    // declaration: the gap the shape leaves (open object, no properties) is what
    // lets each tool return its own record, so a change to it is a change to
    // every YXSpec tool's model-facing output.
    expect(JSON_TOOL_OUTPUT.schema).toEqual({ type: 'object', additionalProperties: true })
    const rendered = JSON_TOOL_OUTPUT.render({ ok: true }, { stage: 'swe-1', steps: [1, 2] })
    expect(rendered).toEqual([{ type: 'text', text: '{\n  "stage": "swe-1",\n  "steps": [\n    1,\n    2\n  ]\n}' }])
  })
})
