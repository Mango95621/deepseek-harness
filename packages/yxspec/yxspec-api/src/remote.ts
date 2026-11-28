/**
 * Host Remote owner for the YXSpec build-server surface: exposes one project's declared
 * servers to the desktop client as the `yxspecRemote` namespace, and lets the onboarding
 * wizard declare one.
 *
 * The seam (`ctx.yxspecRemote`) is registered by a plugin the deployment may not mount — a
 * browser-only deployment has no OpenSSH client and no storage domain. This controller
 * therefore declares no hard dependency on it: the two halves are separate Cordis plugins
 * and the controller reads the seam defensively, reporting an empty list when it is absent.
 * That is why the onboarding wizard can render "no server declared yet" on a deployment
 * that never mounted the remote plugin at all, instead of failing to load.
 *
 * Declaring is a second front door onto the one operation that already owns it: this method
 * builds the service's own record type from the draft and calls `ctx.yxspecRemote.declare`,
 * which is the same call `remote_server_declare` makes and the same validation every
 * declaration passes. Probing and running stay tool calls — those consume a server rather than
 * describe one, and their results are ledger evidence rather than wizard state.
 * @module @deepseek-ai/dsh-yxspec-api/remote
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteServerRecord } from '@deepseek-ai/dsh-yxspec-remote'
import type {
  YxspecRemoteBrowse,
  YxspecRemoteBrowseRequest,
  YxspecRemoteProbe,
  YxspecRemoteServerDraft,
  YxspecRemoteServerView,
} from './types.ts'

/**
 * Per-run wall clock budget a draft without one gets.
 *
 * The same value `remote_server_declare` applies, and here rather than in the form so the two
 * front doors cannot disagree about what an unspecified timeout means.
 */
const DEFAULT_TIMEOUT_MS = 900_000

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No project identity was supplied and none could be derived from the caller. */
    'yxspecRemote/no-project': {}
    /** The deployment mounts no build-server service, so a declaration has nowhere to land. */
    'yxspecRemote/service-unavailable': {}
    /** The build-server service refused the call; the message carries its reason. */
    'yxspecRemote/rejected': {}
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
    return declared.map(serverView)
  }

  /**
   * List the directories under one path on a server, so the wizard can offer them.
   *
   * This is the one call on this surface that names a destination instead of a declaration, and it
   * has to be: the operator picks the directory *before* the declaration that would name it exists,
   * which is what turns "type the path from memory" into "connect and choose". Nothing is stored —
   * the answer is a listing, and the declaration written afterwards is where a choice becomes state.
   *
   * A host that cannot answer is an answer: an unreachable machine, a path that is not there, and a
   * directory with no children all come back as a listing whose `error` or emptiness says which.
   * Only a missing build-server service, or a path the service refuses, raises.
   * @param request - the destination to reach and the directory to list.
   * @returns the listing, with `error` set when it could not be produced.
   * @throws RemoteError when no build-server service is mounted, or the service refused the request.
   */
  @Remote
  async browseServer(request: YxspecRemoteBrowseRequest): Promise<YxspecRemoteBrowse> {
    const remote = this.ctx.get('yxspecRemote')
    if (remote === undefined) {
      throw new RemoteError(
        'yxspecRemote/service-unavailable',
        'this deployment mounts no build-server service, so there is nothing to browse',
        {},
      )
    }
    try {
      return await remote.browse(request)
    } catch (error) {
      throw new RemoteError('yxspecRemote/rejected', messageOf(error), {})
    }
  }

  /**
   * Test one declared server and report what the build host answered.
   *
   * The wizard asks this when the operator wants to know whether the declaration they just wrote
   * reaches anything. The outcome is stored on the declaration by the service, so the row a list
   * renders afterwards describes this attempt without asking again — which is why the answer is
   * returned *and* persisted rather than only returned.
   *
   * An unreachable host is an answer, not a failure: it comes back as `reachable: false` with the
   * client's own words. Only a missing project id, a deployment that mounts no build-server
   * service, or a server this project never declared raises.
   * @param workspaceId - the project that declared the server.
   * @param serverId - the declaration to test.
   * @returns what the probe concluded.
   * @throws RemoteError when no project was named, no build-server service is mounted, or the
   *   project declares no such server.
   */
  @Remote
  async probeServer(workspaceId: string, serverId: string): Promise<YxspecRemoteProbe> {
    if (workspaceId.length === 0) {
      throw new RemoteError(
        'yxspecRemote/no-project',
        'probing a build server requires the project id',
        {},
      )
    }
    const remote = this.ctx.get('yxspecRemote')
    if (remote === undefined) {
      throw new RemoteError(
        'yxspecRemote/service-unavailable',
        'this deployment mounts no build-server service, so there is nothing to probe',
        {},
      )
    }
    // A probe of a server the project never declared is a caller mistake, and the service says so
    // with the ids it does know; re-raising it typed keeps that message in front of the operator.
    try {
      return await remote.probe(workspaceId, serverId)
    } catch (error) {
      throw new RemoteError('yxspecRemote/rejected', messageOf(error), {})
    }
  }

  /**
   * Declare or replace one build server from the onboarding wizard.
   *
   * Unlike {@link servers}, an absent seam is a failure rather than an empty answer: listing
   * nothing and declaring nothing look the same to a caller that swallows the difference, and
   * an operator who filled in a form and saw the row simply not appear would have no way to
   * tell a deployment that cannot store declarations from one that refused this one.
   *
   * The refusal path carries the service's own message. Validation belongs to the operation
   * that writes the record — `declare` runs it for this call exactly as it does for the tool —
   * so re-raising its reason as a typed fault is what keeps the wizard's report actionable
   * instead of a generic failure.
   * @param workspaceId - the project the declaration belongs to.
   * @param draft - the declaration the operator submitted.
   * @returns the stored declaration, projected as the list renders it.
   * @throws RemoteError when no project was named, no build-server service is mounted, or the
   *   service refused the declaration.
   */
  @Remote
  async declareServer(
    workspaceId: string,
    draft: YxspecRemoteServerDraft,
  ): Promise<YxspecRemoteServerView> {
    if (workspaceId.length === 0) {
      throw new RemoteError(
        'yxspecRemote/no-project',
        'declaring a build server requires the project id',
        {},
      )
    }
    const remote = this.ctx.get('yxspecRemote')
    if (remote === undefined) {
      throw new RemoteError(
        'yxspecRemote/service-unavailable',
        'this deployment mounts no build-server service, so a declaration has nowhere to land',
        {},
      )
    }
    // The draft's optional fields are resolved here rather than by the caller, so the wizard
    // and the tool cannot disagree about what an omitted timeout or a blank label means.
    const title = draft.title?.trim()
    const sshExecutable = draft.sshExecutable?.trim()
    let record: RemoteServerRecord
    try {
      record = await remote.declare(workspaceId, {
        id: draft.serverId,
        title: title === undefined || title.length === 0 ? draft.serverId : title,
        destination: draft.destination,
        projectDirectory: draft.projectDirectory,
        ...draft.captureRevision === true ? { captureRevision: true } : {},
        transport: 'ssh',
        // Last one wins for a repeated id, as it does for the tool: a form row the operator
        // edited twice is one recipe, and refusing the whole declaration would lose the rest.
        recipes: Object.fromEntries(draft.recipes.map(recipe => [
          recipe.id,
          {
            command: recipe.command,
            ...recipe.outputDirectory === undefined || recipe.outputDirectory.trim().length === 0
              ? {}
              : { outputDirectory: recipe.outputDirectory },
          },
        ])),
        ...sshExecutable === undefined || sshExecutable.length === 0 ? {} : { sshExecutable },
        timeoutMs: draft.timeoutMs === undefined || draft.timeoutMs <= 0
          ? DEFAULT_TIMEOUT_MS
          : draft.timeoutMs,
      })
    } catch (error) {
      throw new RemoteError('yxspecRemote/rejected', messageOf(error), {})
    }
    return serverView(record)
  }
}

/**
 * Project one stored declaration to what the browser renders.
 *
 * The record's own fields are projected rather than returned whole: `recipes` maps a recipe id
 * to a server-side command template, which is deployment detail the browser has no use for,
 * and a Remote boundary should carry what the caller reads.
 * @param record - the stored declaration.
 * @returns the view the list and the declaration answer both carry.
 */
function serverView(record: RemoteServerRecord): YxspecRemoteServerView {
  return {
    serverId: record.serverId,
    title: record.title,
    destination: record.destination,
    projectDirectory: record.projectDirectory,
    transport: record.transport,
    recipeIds: Object.keys(record.recipes).sort(),
    declaredAt: record.declaredAt,
    ...record.lastProbeAt === undefined ? {} : { lastProbeAt: record.lastProbeAt },
    ...record.lastPlatform === undefined ? {} : { lastPlatform: record.lastPlatform },
    ...record.lastProbeError === undefined ? {} : { lastProbeError: record.lastProbeError },
  }
}

/** An error's message, for a value that may be anything. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default YxspecRemoteController
