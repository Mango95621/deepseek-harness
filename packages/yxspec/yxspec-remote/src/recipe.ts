/**
 * Recipe rendering for the remote build seam.
 *
 * A recipe is deployment-supplied text, and the model picks one by id rather
 * than writing a command. Rendering is therefore the only place a remote command
 * line is built, which keeps the "the model cannot invent a build command"
 * property checkable in one function.
 * @module @deepseek-ai/dsh-yxspec-remote/recipe
 */

/**
 * Render one recipe template with its working directory and any extra arguments.
 *
 * `set -e` means a template written as `a; b` stops at the first failure rather
 * than reporting the last command's status — the difference between "the build
 * broke in step 1" and "the build passed" when step 2 is a `tee`. The explicit
 * `cd` keeps a recipe independent of ssh's login directory.
 * @param template - the declared command template, with `{cwd}` placeholders.
 * @param remoteDirectory - the uploaded tree's server directory.
 * @param extraArgs - one-off shell text appended last.
 * @returns the command to run on the server.
 */
export function renderRecipe(template: string, remoteDirectory: string, extraArgs?: string): string {
  const rendered = template.replaceAll('{cwd}', remoteDirectory)
  const extra = extraArgs === undefined || extraArgs.trim().length === 0 ? '' : ` ${extraArgs.trim()}`
  return `set -e; cd '${remoteDirectory}'; ${rendered}${extra}`
}
