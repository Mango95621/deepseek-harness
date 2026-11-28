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
import type {
  YxspecRemoteProbe,
  YxspecRemoteServerView,
  YxspecStatusValue,
} from '@deepseek-ai/dsh-yxspec-api/types'
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
  /**
   * Read the build servers the section's project declared, with whatever each one's last probe
   * concluded.
   *
   * A separate call rather than a field of {@link load}: the servers live in the `yxspecRemote`
   * namespace, which a deployment may not mount, and a panel that lost its whole process state to a
   * missing build-server plugin would be a worse failure than one that shows no servers.
   * @param workspaceId - the project whose declarations to read.
   * @returns the declarations; empty when the project declared none or the namespace is absent.
   */
  readonly loadServers: (workspaceId: string) => Promise<YxspecRemoteServerView[]>
  /**
   * Test one declared build server and report what the host answered.
   *
   * The outcome is stored on the declaration by the service, so the section re-reads its list
   * afterwards rather than keeping an answer of its own — the same reason the wizard does.
   * @param workspaceId - the project that declared the server.
   * @param serverId - the declaration to test.
   * @returns what the probe concluded; an unreachable host is reported, not thrown.
   */
  readonly probeServer: (workspaceId: string, serverId: string) => Promise<YxspecRemoteProbe>
}

/** Full props of the YXSpec process section. */
export type YxspecSectionProps =
  PropsRuntime<'conversation.session.panel.section'>
  & PropsLocale<typeof NS>
  & Pick<YxspecSectionInjected, 'load' | 'loadServers' | 'probeServer'>
