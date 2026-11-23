/**
 * Server-side naming for the remote build seam.
 *
 * The slug decides a directory name on a machine this process does not own, so
 * it is the one string in the seam that must survive both a hostile title and a
 * second project arriving with the same readable name.
 * @module @deepseek-ai/dsh-yxspec-remote/paths
 */

/** Characters a slug may not contain; the class admits no path separator. */
const SLUG_UNSAFE = /[^A-Za-z0-9._-]+/g

/** Characters the id half may not contain: the suffix is a compact token, not a path. */
const ID_UNSAFE = /[^A-Za-z0-9]/g

/**
 * Reduce a project to a directory-name-safe slug.
 *
 * The slug names a server-side directory, so it must not be able to escape the
 * server's base directory: the character class admits no separator and no shell
 * metacharacter, and collapsing runs of dots removes any `..` component.
 * @param workspaceId - the project id, the stable half of the name.
 * @param title - the project's display title, the readable half.
 * @returns a slug safe to interpolate into a quoted remote path.
 */
export function projectSlug(workspaceId: string, title: string): string {
  const readable = title
    .replace(SLUG_UNSAFE, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const stem = readable.length > 0 ? readable.slice(0, 48) : 'project'
  const stable = workspaceId.replace(ID_UNSAFE, '').slice(0, 12)
  return stable.length > 0 ? `${stem}-${stable}` : stem
}
