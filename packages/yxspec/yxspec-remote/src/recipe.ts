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
 * Render one recipe template with its directories and any extra arguments.
 *
 * `set -e` means a template written as `a; b` stops at the first failure rather
 * than reporting the last command's status — the difference between "the build
 * broke in step 1" and "the build passed" when step 2 is a `tee`. The explicit
 * `cd` keeps a recipe independent of ssh's login directory, and it is where a
 * missing project directory becomes a failure the operator can read.
 *
 * `{out}` is a second token rather than a second directory the seam moves the
 * build into: products land wherever the build system was told to put them, so
 * the seam's job is to name the place a recipe can point at (`OUT_DIR_COMMON_BASE`
 * for a Soong tree, an `--output` flag for a Gradle one) and to fetch from the
 * same place afterwards.
 * @param template - the declared command template, with `{cwd}` and `{out}` placeholders.
 * @param directories - the project directory to run in and the output directory to name.
 * @param extraArgs - one-off shell text appended last.
 * @returns the command to run on the server.
 */
export function renderRecipe(
  template: string,
  directories: { readonly cwd: string; readonly out: string },
  extraArgs?: string,
): string {
  const rendered = template
    .replaceAll('{cwd}', directories.cwd)
    .replaceAll('{out}', directories.out)
  const extra = extraArgs === undefined || extraArgs.trim().length === 0 ? '' : ` ${extraArgs.trim()}`
  return `set -e; cd '${directories.cwd}'; ${rendered}${extra}`
}
