/**
 * Host Remote owner for the YXSpec build-server surface: exposes one project's declared
 * servers to the desktop client as the `yxspecRemote` namespace.
 *
 * The seam (`ctx.yxspecRemote`) is registered by a plugin the deployment may not mount — a
 * browser-only deployment has no OpenSSH client and no storage domain. This controller
 * therefore declares no hard dependency on it: the two halves are separate Cordis plugins
 * and the controller reads the seam defensively, reporting an empty list when it is absent.
 * That is why the onboarding wizard can render "no server declared yet" on a deployment
 * that never mounted the remote plugin at all, instead of failing to load.
 *
 * Read-only by design. Declaring and probing a server stay tool calls, which travel through
 * the remote plugin's own surface and its host-side validation — a UI that could write a
 * declaration directly would be a second, unvalidated path into durable state.
 * @module @deepseek-ai/dsh-yxspec-api/remote
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-yxspec-remote'
import type { YxspecRemoteServerView } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No project identity was supplied and none could be derived from the caller. */
    'yxspecRemote/no-project': {}
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `yxspecRemote` Remote namespace. */
    yxspecRemoteController: YxspecRemoteController
  }
}

/**
 * Host service backing the generated `ctx.remote.yxspecRemote` namespace.
 *
 * Mounted unconditionally by this package, but its data source is not: when
 * `ctx.yxspecRemote` is absent the list is empty rather than an error. A wizard step
 * asking "which build server?" shows its empty state, which is the truth on a deployment
 * that mounts no remote plugin.
 */
export class YxspecRemoteController extends TypertRemoteService {
  /**
   * @param ctx - Host context; the remote seam is read optionally per call.
   */
  constructor(ctx: Context) {
    super(ctx, 'yxspecRemoteController', { namespace: 'yxspecRemote' })
  }

  /**
   * The build servers one project declared, as the client renders them.
   *
   * The record's own fields are projected rather than returned whole: `recipes` maps a
   * recipe id to a server-side command template, which is deployment detail the browser
   * has no use for, and a Remote boundary should carry what the caller reads.
   * @param workspaceId - the project whose declarations to list.
   * @returns the declared servers in declaration order; empty when the remote plugin is
   *   not mounted or the project declared none.
   */
  @Remote
  async servers(workspaceId: string): Promise<YxspecRemoteServerView[]> {
    if (workspaceId.length === 0) {
      throw new RemoteError(
        'yxspecRemote/no-project',
        'listing build servers requires the project id',
        {},
      )
    }
    // `ctx.get` rather than `this.ctx.yxspecRemote`: the seam is optional by
    // design, and the property read is gated on `inject`, so it would raise
    // "cannot get property without inject" on exactly the deployment this
    // controller exists to tolerate.
    const remote = this.ctx.get('yxspecRemote')
    if (remote === undefined) return []
    const declared = await remote.list(workspaceId)
    return declared.map(record => ({
      serverId: record.serverId,
      title: record.title,
      destination: record.destination,
      baseDirectory: record.baseDirectory,
      transport: record.transport,
      recipeIds: Object.keys(record.recipes).sort(),
      declaredAt: record.declaredAt,
      ...record.lastProbeAt === undefined ? {} : { lastProbeAt: record.lastProbeAt },
      ...record.lastPlatform === undefined ? {} : { lastPlatform: record.lastPlatform },
    }))
  }
}

export default YxspecRemoteController
