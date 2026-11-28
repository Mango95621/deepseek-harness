/**
 * One declared build server's connection state, as every surface shows it.
 *
 * A dot is quicker to read down a list than a sentence, so the state itself is a dot — grey before
 * the first test, green after a reachable one, red after a failed one — and it is not a label: the
 * state's own words sit behind it for screen readers, and the dot's tooltip carries them, with the
 * timestamp of the test they describe. A failure is the one state that shows its words outright:
 * "no directory '/srv/build' on ci@farm" is what the operator has to act on, and no dot can say it.
 * @module @deepseek-ai/dsh-client-ui-yxspec/ServerStateDot
 */

import type { ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { YxspecRemoteServerView } from '@deepseek-ai/dsh-yxspec-api/types'
import { serverProbedAt, serverState, type CopySeat } from './serverStatus.ts'
import css from './ServerStateDot.module.css'

/**
 * Render one declaration's connection state.
 * @param props.server - the declaration as the host projects it.
 * @param props.t - the surface's copy seat.
 * @param props.className - the calling surface's class for the words the state shows; a state
 * without words renders none, because a dot carries it on its own.
 * @returns the state line: a dot, and whatever text belongs with it.
 */
export function ServerStateDot({ server, t, className }: {
  server: YxspecRemoteServerView
  t: CopySeat
  className?: string | undefined
}): ReactNode {
  const state = serverState(server, t)
  const probedAt = serverProbedAt(server, t)
  return (
    <span
      className={css.state}
      title={probedAt === undefined ? state.label : `${state.label} · ${probedAt}`}
    >
      <StateDot state={state.dot} />
      {server.lastProbeError === undefined
        ? <span className={css.visuallyHidden}>{state.label}</span>
        : <span className={className}>{state.label}</span>}
    </span>
  )
}
