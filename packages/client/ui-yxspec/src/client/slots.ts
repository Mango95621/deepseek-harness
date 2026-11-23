/**
 * Slot-owner contract for the YXSpec process section and the onboarding wizard frame.
 *
 * The section reuses the session panel's own `conversation.session.panel.section` slot, so
 * its owner values are the panel's; this module only names the section's own registration
 * values. The wizard layer rides `conversation.hero.frame`, whose owner share is the
 * conversation package's — nothing is added to it, because the wizard resolves its own
 * project from the standard `useSessions` kit rather than from a prop the owner would have
 * to thread through.
 * @module @deepseek-ai/dsh-client-ui-yxspec/slots
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { YxspecStatusValue } from '@deepseek-ai/dsh-yxspec-api/types'
import type { NS } from './locales.ts'

/** The values the section's registration injects. */
export interface YxspecSectionInjected {
  /**
   * Read the current process state. Resolves to `undefined` when the host's `yxspec`
   * namespace is not mounted, which the section renders as an unavailable-service notice
   * rather than an error.
   * @param landedStages - stage ids to compute landing status for; omitted means all.
   * @returns the projected state, or `undefined` when the service is absent or refused.
   */
  readonly load: (landedStages?: string[]) => Promise<YxspecStatusValue | undefined>
}

/** Full props of the YXSpec process section. */
export type YxspecSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsLocale<typeof NS>
  & { readonly load: YxspecSectionInjected['load'] }
