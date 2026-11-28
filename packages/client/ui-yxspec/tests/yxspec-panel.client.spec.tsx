// @vitest-environment jsdom
/**
 * The process section's own view: an unavailable-service notice, the loading placeholder,
 * and the stage rows with each stage's landing status.
 *
 * The section owns no process state — it reads once on mount and a stale read is corrected
 * by the next mount — so these specs drive it through its `load` seat rather than through a
 * subscription, and they pin the three things the section decides: which of the three shapes
 * it renders, how a stage's landing status becomes its tone, and how a frozen-step count is
 * appended to the step count.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  YxspecRemoteProbe,
  YxspecRemoteServerView,
  YxspecStatusValue,
  YxspecStageView,
} from '@deepseek-ai/dsh-yxspec-api/types'
import { YxspecSection } from '../src/client/YxspecPanel.tsx'
import type { YxspecSectionProps } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as YxspecSectionProps['t']

afterEach(cleanup)

function stage(overrides: Partial<YxspecStageView> = {}): YxspecStageView {
  return {
    id: 'sys',
    title: 'System requirements',
    aspice: 'SYS.2',
    group: 'system',
    steps: [],
    ...overrides,
  }
}

function status(stages: readonly YxspecStageView[]): YxspecStatusValue {
  return {
    identity: { specId: 'ivi-hmi', projectName: 'ivi', customer: 'acme', productType: 'mpu' },
    root: '/work',
    stages: [...stages],
    domains: [],
    tracks: [],
  }
}

function step(id: string, frozen = false): YxspecStageView['steps'][number] {
  return { id, cell: `${id}.md`, title: id, frozen, requiredInputs: [], hasGateScript: false }
}

/** One declared server, with whatever its last probe concluded. */
function server(overrides: Partial<YxspecRemoteServerView> = {}): YxspecRemoteServerView {
  return {
    serverId: 'build-1',
    title: 'Build farm',
    destination: 'ci@farm',
    projectDirectory: '/srv/aosp',
    transport: 'ssh',
    recipeIds: ['ninja-full'],
    declaredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A ready catalogue naming one session, which is the project the section resolves. */
const SESSIONS = { ids: ['s1'], byId: { s1: { retainedBy: { mainView: 1 } } } } as unknown as SessionListState
const WORKSPACES = {
  phase: 'ready',
  items: [{ workspaceId: 'ws-1', roots: ['/work'], path: '/work', title: 'ivi', sessionIds: ['s1'] }],
} as unknown as WorkspaceSnapshot

/**
 * Render the section with one loader outcome and one build-server answer.
 *
 * The catalogues are supplied because the section resolves the project for itself, the way the
 * skeleton's global and session standard props deliver them.
 */
function view(load: YxspecSectionProps['load'], options: {
  servers?: readonly YxspecRemoteServerView[]
  loadServers?: YxspecSectionProps['loadServers']
  probeServer?: YxspecSectionProps['probeServer']
  probing?: (workspaceId: string, serverId: string) => void
} = {}) {
  const loadServers = options.loadServers ?? (() => Promise.resolve([...(options.servers ?? [])]))
  const probeServer = options.probeServer ?? (async (workspaceId: string, serverId: string) => {
    options.probing?.(workspaceId, serverId)
    return { serverId, reachable: true, platform: 'Linux' } satisfies YxspecRemoteProbe
  })
  const props = {
    load, loadServers, probeServer, t,
    useWorkspaces: <S,>(select: (value: WorkspaceSnapshot) => S): S => select(WORKSPACES),
    useSessions: <S,>(select: (value: SessionListState) => S): S => select(SESSIONS),
  } as unknown as YxspecSectionProps
  return render(<YxspecSection {...props} />)
}

/** The loader that resolves the given value; never refuses. */
function resolving(value: YxspecStatusValue | undefined): YxspecSectionProps['load'] {
  return () => Promise.resolve(value)
}

describe('YxspecSection', () => {
  it('lists the declared servers with what their last probe concluded', async () => {
    const section = view(resolving(status([])), {
      servers: [
        server({ lastProbeAt: '2026-02-03T04:05:06.000Z', lastPlatform: 'Linux' }),
        server({ serverId: 'build-2', title: 'Spare', lastProbeAt: '2026-02-03T04:05:06.000Z', lastProbeError: 'Connection refused' }),
        server({ serverId: 'build-3', title: 'Untested' }),
      ],
    })

    // The three states, in the order an operator reads them: reachable, failed with the host's own
    // words, and never tried. Each is a dot — green, red, grey — and the failure is the one that
    // also shows the line behind it.
    await vi.waitFor(() => { expect(screen.getByText(zh['section.servers'])).toBeTruthy() })
    const rows = [...section.container.querySelectorAll('.yxspec-server')]
    expect(rows.map(row => row.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['done', 'error', 'idle'])
    expect(screen.getByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeTruthy()
    expect(screen.getByText(zh['server.unreachable'].replace('{error}', 'Connection refused'))).toBeTruthy()
    expect(screen.getByText(zh['server.neverProbed'])).toBeTruthy()
    expect(rows).toHaveLength(3)
  })

  it('reports a connection whose probe named no platform as connected all the same', async () => {
    // The platform is a detail of a success rather than a state of its own: a host that answered
    // without one is reachable, and the row must not read as untested for the missing detail.
    const section = view(resolving(status([])), {
      servers: [server({ lastProbeAt: '2026-02-03T04:05:06.000Z' })],
    })

    await vi.waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })
    expect(section.container.querySelector('.yxspec-server [data-state]')?.getAttribute('data-state')).toBe('done')
    expect(screen.getByText(zh['server.reachable'])).toBeTruthy()
  })

  it('shows nothing about servers for a project that declared none', async () => {
    view(resolving(status([])))
    await vi.waitFor(() => { expect(screen.queryByText(zh['section.servers'])).toBeNull() })
  })

  it('keeps the server block when the process service itself is missing', async () => {
    // Two independent readings: a deployment without the process service still has to say whether
    // the machine that compiles is reachable, and vice versa.
    const section = view(resolving(undefined), { servers: [server({ lastProbeError: 'Connection refused' })] })

    await vi.waitFor(() => { expect(screen.getByText(zh.empty)).toBeTruthy() })
    expect(section.container.querySelectorAll('.yxspec-server')).toHaveLength(1)
    expect(screen.getByText(zh['server.unreachable'].replace('{error}', 'Connection refused'))).toBeTruthy()
  })

  it('reads a refusal to list servers as having none, not as a broken panel', async () => {
    // The build-server namespace is optional: a deployment without it still shows the process.
    const section = view(resolving(status([stage()])), { loadServers: () => Promise.reject(new Error('no namespace')) })
    await vi.waitFor(() => { expect(screen.getByText('SYS.2')).toBeTruthy() })
    expect(screen.queryByText(zh['section.servers'])).toBeNull()
    expect(section.container.querySelector('[data-empty="true"]')).toBeNull()
  })

  it('tests one server on demand and re-reads the list afterwards', async () => {
    const asked: { workspaceId: string; serverId: string }[] = []
    let reads = 0
    view(resolving(status([])), {
      servers: [server()],
      loadServers: () => { reads += 1; return Promise.resolve([server()]) },
      probing: (workspaceId, serverId) => { asked.push({ workspaceId, serverId }) },
    })
    await vi.waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh['server.probe'] }))

    // The write lives on the declaration, so the answer is read back rather than held: two reads,
    // one the mount and one after the probe.
    await vi.waitFor(() => { expect(asked).toEqual([{ workspaceId: 'ws-1', serverId: 'build-1' }]) })
    expect(reads).toBe(2)
  })

  it('keeps the last recorded state when the test itself is refused', async () => {
    const section = view(resolving(status([])), {
      servers: [server({ lastProbeAt: '2026-02-03T04:05:06.000Z', lastPlatform: 'Linux' })],
      probeServer: () => Promise.reject(new Error('the build-server namespace is not mounted')),
    })
    await vi.waitFor(() => { expect(screen.getByText('Build farm')).toBeTruthy() })

    fireEvent.click(screen.getByRole('button', { name: zh['server.probe'] }))

    // A refused call is not a verdict about the host, and this section owns no notice surface.
    await vi.waitFor(() => {
      expect(section.container.querySelectorAll('.yxspec-server')).toHaveLength(1)
    })
    expect(screen.getByText(zh['server.reachableOn'].replace('{platform}', 'Linux'))).toBeTruthy()
  })
  it('shows the loading placeholder until the first read answers', () => {
    const pending = view(resolving(undefined))
    expect(pending.container.querySelector('[data-loading="true"]')).toBeTruthy()
    expect(pending.container.querySelector('[data-empty="true"]')).toBeNull()
  })

  it('reports an unmounted service as unavailable rather than as an error', async () => {
    // A deployment without the host plugin resolves to `undefined`; the section must read as
    // a quiet notice, because a partially deployed host is not a broken one.
    const section = view(resolving(undefined))
    await vi.waitFor(() => { expect(section.container.querySelector('[data-empty="true"]')).toBeTruthy() })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('reports a refused read the same way as an absent service', async () => {
    const section = view(() => Promise.reject(new Error('gateway unreachable')))
    await vi.waitFor(() => { expect(section.container.querySelector('[data-empty="true"]')).toBeTruthy() })
    expect(screen.getByText(zh.empty)).toBeTruthy()
  })

  it('ignores an answer that lands after unmount', async () => {
    let settle: (value: YxspecStatusValue) => void = () => {}
    const section = view(() => new Promise<YxspecStatusValue>((resolve) => { settle = resolve }))
    const error = vi.spyOn(console, 'error')
    section.unmount()
    settle(status([]))
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('ignores a refusal that lands after unmount', async () => {
    // The rejection arm carries the same guard as the resolution arm: a section torn down while
    // its read was in flight must not set state on a tree React has already released.
    let refuse: (reason: unknown) => void = () => {}
    const section = view(() => new Promise<YxspecStatusValue>((_resolve, reject) => { refuse = reject }))
    const error = vi.spyOn(console, 'error')
    section.unmount()
    refuse(new Error('gateway unreachable'))
    await Promise.resolve()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('draws the declared identity and one row per stage', async () => {
    const section = view(resolving(status([
      stage({ id: 'a', aspice: 'SYS.2', title: 'System', steps: [step('one')] }),
      stage({ id: 'b', aspice: 'SWE.1', title: 'Software', steps: [] }),
    ])))
    // The loading placeholder is also a `.yxspec-panel`, so the wait keys on the identity
    // block that only the loaded shape draws.
    await vi.waitFor(() => { expect(section.container.querySelector('.yxspec-identity')).toBeTruthy() })
    expect(screen.getByText(`${zh['identity.specId']}: ivi-hmi`)).toBeTruthy()
    expect(screen.getByText(`${zh['identity.customer']}: acme`)).toBeTruthy()
    expect(section.container.querySelectorAll('.yxspec-stage')).toHaveLength(2)
    expect(section.container.querySelector('.yxspec-stage-aspice')?.textContent).toBe('SYS.2')
    expect(section.container.querySelector('.yxspec-stage-title')?.textContent).toBe('System')
  })

  it.each([
    ['landed', stage({ landed: true }), 'ok', zh['section.landed']],
    ['missing inputs', stage({ landed: false, missing: ['a', 'b'] }), 'pending', '缺 2 项'],
    // No override at all, not `landed: undefined`: an absent property is the shape a host sends
    // when it was not asked for this stage's status.
    ['not asked about', stage({}), 'unknown', zh['section.unknown']],
  ])('renders a stage %s as tone %s', async (_name, row, tone, label) => {
    const section = view(resolving(status([row])))
    await vi.waitFor(() => { expect(section.container.querySelector('.yxspec-stage')).toBeTruthy() })
    const drawn = section.container.querySelector('.yxspec-stage')
    expect(drawn?.getAttribute('data-tone')).toBe(tone)
    expect(drawn?.querySelector('.yxspec-stage-state')?.textContent).toBe(label)
  })

  it('counts a stage with no recorded missing inputs as zero', async () => {
    // `missing` is present only alongside `landed: false`; a host that omitted it still has
    // to render a count rather than "undefined missing".
    const section = view(resolving(status([stage({ landed: false })])))
    await vi.waitFor(() => { expect(section.container.querySelector('.yxspec-stage')).toBeTruthy() })
    expect(section.container.querySelector('.yxspec-stage-state')?.textContent).toBe('缺 0 项')
  })

  it.each([
    ['no frozen steps', [step('one'), step('two')], '2'],
    ['one frozen step', [step('one', true), step('two')], `2 · ${zh['step.frozen']}×1`],
    ['several frozen steps', [step('a', true), step('b', true), step('c')], `3 · ${zh['step.frozen']}×2`],
  ])('appends the freeze count for %s', async (_name, steps, text) => {
    const section = view(resolving(status([stage({ steps })])))
    await vi.waitFor(() => { expect(section.container.querySelector('.yxspec-stage')).toBeTruthy() })
    expect(section.container.querySelector('.yxspec-stage-steps')?.textContent).toBe(text)
  })
})
