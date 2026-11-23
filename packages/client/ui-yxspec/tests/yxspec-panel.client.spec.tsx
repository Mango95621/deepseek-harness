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

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { YxspecStatusValue, YxspecStageView } from '@deepseek-ai/dsh-yxspec-api/types'
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

/** Render the section with one loader outcome. */
function view(load: YxspecSectionProps['load']) {
  return render(<YxspecSection {...{ load, t } as YxspecSectionProps} />)
}

/** The loader that resolves the given value; never refuses. */
function resolving(value: YxspecStatusValue | undefined): YxspecSectionProps['load'] {
  return () => Promise.resolve(value)
}

describe('YxspecSection', () => {
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
