/**
 * How a declared build server's connection state reads, wherever it is shown.
 *
 * Three surfaces show it — the onboarding wizard's server step and the blank home's strip, and the
 * Session panel's section — and they must say the same thing about the same declaration. The state
 * itself is the host's, stored on the declaration by the last probe; this module only turns it into
 * a dot and the operator's own words for it, so no surface owns a second opinion about what "tested
 * and reachable" means.
 * @module @deepseek-ai/dsh-client-ui-yxspec/serverStatus
 */

import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { YxspecRemoteServerView } from '@deepseek-ai/dsh-yxspec-api/types'
import type { NS } from './locales.ts'

/** The copy seat every surface renders through: this package's namespace, as the slots compose it. */
export type CopySeat = PropsLocale<typeof NS>['t']

/** One declaration's connection state: the dot that carries it, and the words that say it. */
export interface ServerState {
  /**
   * Which dot to paint: `idle` before the first test, `error` after a failed one, `done` after a
   * reachable one.
   */
  readonly dot: StateDotState
  /** The state in one line, for the dot's accessible label and for the line a failure shows. */
  readonly label: string
}

/**
 * Read what the last probe of one declaration concluded.
 *
 * The order matters. A failure outranks everything, because it is the state the operator has to act
 * on; "never tested" outranks a success, because a declaration nothing has probed is not a
 * declaration that works; and the platform is a detail of the success rather than a state of its
 * own — a probe that reported no platform still connected.
 * @param server - the declaration as the host projects it.
 * @param t - the surface's copy seat.
 * @returns the dot for that state and the text that says it.
 */
export function serverState(server: YxspecRemoteServerView, t: CopySeat): ServerState {
  if (server.lastProbeError !== undefined) {
    return { dot: 'error', label: t('server.unreachable', { error: server.lastProbeError }) }
  }
  if (server.lastProbeAt === undefined) return { dot: 'idle', label: t('server.neverProbed') }
  return {
    dot: 'done',
    label: server.lastPlatform === undefined
      ? t('server.reachable')
      : t('server.reachableOn', { platform: server.lastPlatform }),
  }
}

/**
 * When the last probe ran, for the dot's tooltip.
 * @param server - the declaration as the host projects it.
 * @param t - the surface's copy seat.
 * @returns the tooltip text, or undefined when nothing has probed this server yet.
 */
export function serverProbedAt(server: YxspecRemoteServerView, t: CopySeat): string | undefined {
  if (server.lastProbeAt === undefined) return undefined
  return t('server.probedAt', { time: server.lastProbeAt })
}
