/**
 * The project's YXSpec declaration, and the one test for whether a project runs one.
 *
 * "Is this a YXSpec project?" is asked from three places, and they must never
 * disagree:
 *
 * - `@deepseek-ai/dsh-yxspec` seeds the declared spec identity from the file, so
 *   the stage model and the identity describe the same tree.
 * - `@deepseek-ai/dsh-yxspec-step` hides `yxspec_status`/`yxspec_next` from
 *   sessions in other projects, so a single-schema discipline is not paid for by
 *   every session that never asked for the process.
 * - `@deepseek-ai/dsh-yxspec-remote/tools` hides the three build-server tools the
 *   same way.
 *
 * The marker is a file rather than a config flag because the file is what the
 * onboarding wizard and the bundled `yxspec-*` skills actually read. A boolean
 * config key would be a second declaration that can drift out of step with the
 * tree it is meant to describe; reading the tree keeps the wizard, the skills,
 * and the tool guards answering from the same bytes.
 *
 * This module is a subpath rather than part of the entry because a plugin entry
 * may export only what the Loader loads (see `docs/defensive-patterns/package-surface.md`).
 * It imports nothing but `node:fs`/`node:path`, so a tool package can depend on
 * the predicate without also depending on the domain service it belongs to.
 * @module @deepseek-ai/dsh-yxspec/project
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Where a project states that it runs a YXSpec process, relative to a project root. */
export const PROJECT_CONFIG_PATH = 'yxspec.json'

/**
 * The location a project's YXSpec declaration occupied before the root-level file.
 *
 * Kept as a fallback rather than dropped: a project set up under the older layout is
 * not wrong, and the one read both this predicate and the wizard's enumeration depend
 * on would otherwise report a fully declared project as unconfigured. The root file
 * wins when both are present, so migrating is an act of adding a file rather than
 * removing one — and a deployment that only ever wrote the nested path keeps working.
 */
export const LEGACY_PROJECT_CONFIG_PATH = 'project/config/yxspec.json'

/**
 * The declarative candidates, in the order they are consulted.
 *
 * The first is the project root, which is where a project's own statement about itself
 * belongs: it sits beside the tree it describes rather than under a `project/` scaffold
 * a documentation repository has no reason to carry. The second is the older nested
 * location, admitted so a project written before the move still answers.
 */
export const PROJECT_CONFIG_CANDIDATES = [PROJECT_CONFIG_PATH, LEGACY_PROJECT_CONFIG_PATH] as const

/**
 * Resolve the project's YXSpec declaration, or `undefined` when it declares none.
 *
 * One resolution function rather than a list each caller walks: the predicate above, the
 * wizard's document enumeration, and the identity seed all have to agree on *which* file
 * a project carries, and a copy of the ordering in each is three chances to disagree.
 * @param root - an absolute project root.
 * @returns the absolute path of the first candidate that exists, or undefined.
 */
export function resolveProjectConfigPath(root: string): string | undefined {
  for (const relative of PROJECT_CONFIG_CANDIDATES) {
    const absolute = join(root, relative)
    if (existsSync(absolute)) return absolute
  }
  return undefined
}

/**
 * Whether one project root declares a YXSpec process.
 *
 * A missing or unreadable file reads as `false`, which is the safe direction. The
 * cost of hiding a tool from a project that does declare the process is one
 * missing capability, reported by the tool's absence at the point of use; the
 * cost of the opposite mistake is a schema carried in the request context of
 * every unrelated session in the deployment.
 * @param root - an absolute project root.
 * @returns true when the root carries the project's YXSpec config.
 */
export function declaresYxspecProcess(root: string): boolean {
  return resolveProjectConfigPath(root) !== undefined
}

/**
 * The two Host reads that answer "which project is this Session in?".
 *
 * Declared as the verbs actually called rather than as the whole services, so a
 * plugin supplies exactly what is used and a spec's recording double satisfies
 * them unchanged. The Session type stays a parameter because naming it would
 * make this subpath depend on the agent package — the one thing its module
 * contract forbids. `get` answers the deployment default when the Session
 * recorded none, so it never misses: an unmatched cwd is the only way this pair
 * reports "no project".
 * @typeParam TSession - the Session handle the caller's services key on.
 */
export interface ProjectScope<TSession> {
  /** Read the Session's committed working directory. */
  readonly workingDirectory: { get(session: TSession): string }
  /** List every declared project, in durable registry order. */
  readonly workspaceRegistry: { list(): readonly { readonly roots: readonly string[] }[] }
}

/**
 * Whether the agent's Session works inside a project that declares a YXSpec
 * process.
 *
 * This is the one place the "cwd → project root → marker" chain is written, so
 * the guard `@deepseek-ai/dsh-yxspec-step` puts on its two tools and the one
 * `@deepseek-ai/dsh-yxspec-remote/tools` puts on its three cannot answer
 * differently. The chain itself is deliberately the same one those tools use to
 * resolve the project a call targets, so a call that would have resolved to a
 * project is exactly the call that gets the schema.
 *
 * A `false` result excludes a tool from both the step's declarations and its
 * dispatch, so the reduction is real at the model boundary rather than
 * advisory. Both reads are synchronous and the marker is a `stat`, so the
 * answer costs no round trip.
 * @param scope - the Session's working directory and the declared projects.
 * @param session - the Session whose project membership is asked about.
 * @returns true when that Session's cwd is a root of a project declaring the process.
 */
export function sessionDeclaresYxspecProcess<TSession>(scope: ProjectScope<TSession>, session: TSession): boolean {
  const cwd = scope.workingDirectory.get(session)
  const root = scope.workspaceRegistry.list().find(candidate => candidate.roots.includes(cwd))?.roots[0]
  if (root === undefined) return false
  return declaresYxspecProcess(root)
}
