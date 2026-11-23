/**
 * Model-facing `remote_server_list`, `remote_server_declare`, and `remote_build`
 * over the Host `ctx.yxspecRemote` service.
 *
 * Mounting this plugin registers the three tools in the *mounting* scope, so a
 * preset decides which agents receive them: the shipped Web composition mounts
 * the row in `standard`, `ptc`, and `cordis` and omits it from `minimal`. The
 * tools are the only path the agent has to a build server, and that is the
 * point — a build is a tool call, so it passes through the same `tools` pipeline
 * the YXSpec gate hooks, and a stage gate can therefore require a green remote
 * build before letting a later stage start.
 *
 * The build-server service itself stays on the Host plane in a sibling entry
 * (`@deepseek-ai/dsh-yxspec-remote`): the onboarding wizard's server step reads
 * the `yxspecRemote` Remote namespace, so a deployment that grants its agents no
 * build-server tool still lists what the project declared. The two halves are
 * separate plugins and this one resolves the service per scope through
 * `ctx.inject`, which is also what keeps it inert — rather than failing — on a
 * composition that mounts the tools without the service.
 *
 * Every registration additionally carries a step-time `when` guard restricting
 * it to a project that declares a YXSpec process. A build server is a
 * YXSpec concept; a Session in any other project pays none of these three
 * schemas' fixed request-context token cost.
 * @module @deepseek-ai/dsh-yxspec-remote/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sessionDeclaresYxspecProcess } from '@deepseek-ai/dsh-yxspec/project'
// Type-only: pulls the `ctx.yxspecRemote`, `ctx.workspaceRegistry`, and
// `ctx.workingDirectory` service merges this module reads.
import type {} from './index.ts'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-workspace'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JSON_TOOL_OUTPUT } from '@deepseek-ai/dsh-yxspec/tool-output'

/** Plugin name registered with the Loader. */
export const name = 'yxspec-remote-tools'

/**
 * Host services this plugin consumes.
 *
 * `yxspecRemote` is deliberately absent: it is resolved per scope inside
 * {@link registerRemoteTools} through `ctx.inject`, the way a preset-level
 * consumer reaches a Host service. Declaring it here would make the row depend
 * on a service the host plane owns *and* would stop the row from reporting the
 * honest thing — that its tools need the service, not the whole deployment.
 */
export const inject = ['tools', 'workspaceRegistry', 'workingDirectory']

/**
 * Register the three model-facing tools in the scope that resolved the build
 * server service.
 * @param ctx - the registrant context.
 */
export function apply(ctx: Context): void {
  ctx.inject(['yxspecRemote'], registerRemoteTools)
}

/**
 * Register list, declare, and build over the resolved scope's remote service.
 * @param ctx - scope whose `yxspecRemote` service the tools act through.
 */
function registerRemoteTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'remote_server_list',
    description:
      'List the build servers declared for the active project, with each declaration\'s recipes and the '
      + 'outcome of its last probe. Read-only.',
    parameters: {
      workspaceId: { type: 'string', description: 'The project id; omit to use the active project.' },
    },
    output: JSON_TOOL_OUTPUT,
    async execute(args, exec) {
      const workspaceId = resolveWorkspaceId(ctx, args.workspaceId, exec)
      if (workspaceId === undefined) return { ok: false, error: 'no active project' }
      const servers = await ctx.yxspecRemote.list(workspaceId)
      return {
        ok: true,
        workspaceId,
        servers: servers.map(server => ({
          id: server.serverId,
          title: server.title,
          destination: server.destination,
          baseDirectory: server.baseDirectory,
          recipes: Object.keys(server.recipes),
          lastProbeAt: server.lastProbeAt ?? null,
          lastPlatform: server.lastPlatform ?? null,
        })),
      }
    },
  }), { when: whenYxspecProject(ctx) })

  ctx.tools.register(defineTool({
    name: 'remote_server_declare',
    description:
      'Declare or replace a build server for the active project. The destination is an OpenSSH destination '
      + '(a `Host` alias from the user\'s own SSH config, or `user@host`); credentials are never passed here and '
      + 'never stored. A recipe is a command template run on the server with `{cwd}` replaced by the uploaded '
      + 'tree\'s directory — only declared recipes can ever run.',
    parameters: {
      serverId: { type: 'string', required: true, description: 'Short id, unique within the project, e.g. `aosp-builder`.' },
      destination: {
        type: 'string', required: true,
        description: 'OpenSSH destination: a `~/.ssh/config` Host alias or `user@host`.',
      },
      baseDirectory: {
        type: 'string', required: true,
        description: 'Absolute server directory under which this project gets a scratch build tree.',
      },
      recipes: {
        type: 'array', required: true,
        description: 'The recipes this server may run. At least one is required.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Recipe id, e.g. `ninja-full`.' },
            command: {
              type: 'string', required: true,
              description: 'Server command template. Use `{cwd}` for the uploaded tree directory.',
            },
          },
        },
      },
      title: { type: 'string', description: 'Human label for the server picker; defaults to the id.' },
      timeoutMs: { type: 'number', description: 'Per-run wall clock budget in milliseconds; defaults to 900000.' },
      sshExecutable: { type: 'string', description: 'Absolute local ssh client; omit for the platform default.' },
      workspaceId: { type: 'string', description: 'The project id; omit to use the active project.' },
    },
    output: JSON_TOOL_OUTPUT,
    async execute(args, exec) {
      const workspaceId = resolveWorkspaceId(ctx, args.workspaceId, exec)
      if (workspaceId === undefined) return { ok: false, error: 'no active project' }
      const recipes = recipeMap(args.recipes)
      if (recipes === undefined) {
        return { ok: false, error: 'recipes must be a non-empty array of { id, command }' }
      }
      const declared = await ctx.yxspecRemote.declare(workspaceId, {
        id: args.serverId,
        title: typeof args.title === 'string' && args.title.length > 0 ? args.title : args.serverId,
        destination: args.destination,
        baseDirectory: args.baseDirectory,
        transport: 'ssh',
        recipes,
        ...typeof args.sshExecutable === 'string' && args.sshExecutable.length > 0
          ? { sshExecutable: args.sshExecutable }
          : {},
        timeoutMs: typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 900_000,
      })
      return { ok: true, workspaceId, serverId: declared.serverId, recipes: Object.keys(declared.recipes) }
    },
  }), { when: whenYxspecProject(ctx) })

  ctx.tools.register(defineTool({
    name: 'remote_build',
    description:
      'Run one declared recipe on a declared build server: archive the project tree, upload it to the '
      + 'server\'s scratch directory, run the recipe, and return the log and exit code. A failing build is '
      + 'returned as data, not as an error — read `exitCode` and `log`. Every run is recorded with its tree '
      + 'digest and log digest.',
    parameters: {
      serverId: { type: 'string', required: true, description: 'The declared server to run on.' },
      recipe: { type: 'string', required: true, description: 'The recipe id; must be one the server declares.' },
      sourceDirectory: {
        type: 'string',
        description: 'Absolute local directory to upload; omit for the project\'s primary root.',
      },
      push: { type: 'boolean', description: 'Set false to run against whatever is already on the server.' },
      extraArgs: { type: 'string', description: 'Extra shell text appended to the recipe, for a one-off flag.' },
      workspaceId: { type: 'string', description: 'The project id; omit to use the active project.' },
    },
    output: JSON_TOOL_OUTPUT,
    async execute(args, exec) {
      const workspaceId = resolveWorkspaceId(ctx, args.workspaceId, exec)
      if (workspaceId === undefined) return { ok: false, error: 'no active project' }
      const result = await ctx.yxspecRemote.run(workspaceId, {
        serverId: args.serverId,
        recipe: args.recipe,
        ...typeof args.sourceDirectory === 'string' && args.sourceDirectory.length > 0
          ? { sourceDirectory: args.sourceDirectory }
          : {},
        ...typeof args.push === 'boolean' ? { push: args.push } : {},
        ...typeof args.extraArgs === 'string' && args.extraArgs.length > 0 ? { extraArgs: args.extraArgs } : {},
      }, exec.signal)
      return { ok: result.exitCode === 0, workspaceId, ...result }
    },
  }), { when: whenYxspecProject(ctx) })
}

/**
 * The step-time activation guard for all three tools: the preparing agent works
 * inside a project that declares a YXSpec process.
 *
 * The reduction itself lives in `@deepseek-ai/dsh-yxspec/project`, shared with
 * `yxspec-step`, so the two rows cannot come to disagree about which Sessions
 * are in a YXSpec project. A `false` result excludes the tool from both the
 * step's declarations and its dispatch, so the reduction is real at the model
 * boundary rather than advisory.
 * @param ctx - the registrant context.
 * @returns the activation condition.
 */
function whenYxspecProject(ctx: Context) {
  return ({ agent }: { agent: Agent }): boolean =>
    sessionDeclaresYxspecProcess(ctx, agent.session)
}

/**
 * Convert the tool's `{ id, command }` list into the declaration's recipe map.
 *
 * Returns `undefined` rather than a partial map so a malformed entry fails the
 * whole declaration instead of silently dropping one recipe a stage gate might
 * have been told to require.
 * @param value - the raw tool argument.
 * @returns the recipe map, or `undefined` when any entry is unusable.
 */
function recipeMap(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const entry of value) {
    /* v8 ignore next -- the tool schema types `recipes` as an array of objects with
     * `additionalProperties: false`, and the pipeline validates arguments against it before
     * dispatch, so a non-object entry cannot reach this loop. The check is the type-level
     * obligation for an `unknown[]`, not a live path. */
    if (typeof entry !== 'object' || entry === null) return undefined
    const { id, command } = entry as { id?: unknown; command?: unknown }
    if (typeof id !== 'string' || id.trim().length === 0) return undefined
    if (typeof command !== 'string' || command.trim().length === 0) return undefined
    out[id] = command
  }
  return out
}

/**
 * Resolve the project a call targets: an explicit id, else the Session's own
 * working directory resolved back to the project that declares it.
 *
 * The working directory is the honest source: a project's first root is exactly
 * the cwd its sessions get, so the two agree by construction rather than by a
 * second piece of state that could drift.
 * @param ctx - the registrant context.
 * @param explicit - the tool's optional `workspaceId` argument.
 * @param exec - the tool run context, read for the calling agent.
 * @returns the project id, or `undefined` when none can be resolved.
 */
function resolveWorkspaceId(
  ctx: Context,
  explicit: unknown,
  exec: { agent?: Agent | undefined },
): string | undefined {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const session = exec.agent?.session
  if (session === undefined) return undefined
  // `get` answers the deployment default when the Session recorded none, so it
  // never misses: "no project" here means the cwd matched no declared root.
  const cwd = ctx.workingDirectory.get(session)
  const project = ctx.workspaceRegistry.list().find(candidate => candidate.roots.includes(cwd))
  return project?.id
}
