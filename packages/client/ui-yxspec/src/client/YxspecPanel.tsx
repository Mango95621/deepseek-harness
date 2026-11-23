/** YXSpec process section: the ASPICE stage list with each stage's artifact landing status. */
import { useEffect, useState, type ReactNode } from 'react'
import type { YxspecStageView, YxspecStatusValue } from '@deepseek-ai/dsh-yxspec-api/types'
import type { YxspecSectionProps } from './slots.ts'

/** One stage row: ASPICE process, title, step count, and landing state. */
function StageRow({ stage, props }: { stage: YxspecStageView; props: YxspecSectionProps }): ReactNode {
  const frozen = stage.steps.filter(step => step.frozen).length
  const state = stage.landed === undefined
    ? props.t('section.unknown')
    : stage.landed
      ? props.t('section.landed')
      : props.t('section.missing', { count: stage.missing?.length ?? 0 })
  const tone = stage.landed === undefined ? 'unknown' : stage.landed ? 'ok' : 'pending'
  return (
    <div className="yxspec-stage" data-tone={tone}>
      <span className="yxspec-stage-aspice">{stage.aspice}</span>
      <span className="yxspec-stage-title">{stage.title}</span>
      <span className="yxspec-stage-steps">
        {stage.steps.length}
        {frozen > 0 ? ` · ${props.t('step.frozen')}×${frozen}` : ''}
      </span>
      <span className="yxspec-stage-state">{state}</span>
    </div>
  )
}

/**
 * Render the YXSpec process section. Loads once on mount; the section owns no process
 * state, so a stale read is corrected by the next mount rather than by a subscription —
 * deliberately, because a live subscription would add host→client traffic for a table that
 * changes only when an agent advances a step.
 * @param props - the slot props, carrying the bound translator and the loader.
 * @returns the section body.
 */
export function YxspecSection(props: YxspecSectionProps): ReactNode {
  const [state, setState] = useState<YxspecStatusValue | undefined>()
  const [unavailable, setUnavailable] = useState(false)
  const { load } = props

  useEffect(() => {
    let live = true
    void load().then(
      (value) => {
        if (!live) return
        if (value === undefined) setUnavailable(true)
        else setState(value)
      },
      () => { if (live) setUnavailable(true) },
    )
    return () => { live = false }
  }, [load])

  if (unavailable) return <div className="yxspec-panel" data-empty="true">{props.t('empty')}</div>
  if (state === undefined) return <div className="yxspec-panel" data-loading="true" />

  return (
    <div className="yxspec-panel">
      <div className="yxspec-identity">
        <span>{props.t('identity.specId')}: {state.identity.specId}</span>
        <span>{props.t('identity.customer')}: {state.identity.customer}</span>
      </div>
      {state.stages.map(stage => <StageRow key={stage.id} stage={stage} props={props} />)}
    </div>
  )
}
