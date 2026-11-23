/**
 * YXSpec blind dispatch. YXSpec's controller protocol (LD-027) says a controller must not
 * let a worker's rendered prompt pass through its own context: render, land, hash, and
 * dispatch are all mechanical steps, and the controller only consumes a diagnostic line.
 *
 * In the original toolchain that was a rule the controller was asked to honour — with an
 * explicit reminder not to `Read` the rendered file even while debugging a hash mismatch.
 * Here it is a property of the API: this plugin exposes `render` (which returns only the
 * file path and its hash) and `spawn` (which takes that path), and offers no method that
 * returns the rendered body. A controller running against this API cannot leak the body
 * into its context because there is nothing to read.
 *
 * Worker identity travels as `prompt_file` + `prompt_sha256`. The worker's first act is to
 * read the file and verify the hash; the spawn prompt says so.
 * @module @deepseek-ai/dsh-yxspec-dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-yxspec'

/** Plugin configuration. */
export interface Config {
  /** Where rendered role prompts land, workspace-relative. */
  spawnDir?: string
  /** Where role prompt templates are read from, workspace-relative. */
  promptDir?: string
}

/** Schemastery configuration for blind dispatch. */
export const Config: z<Config> = z.object({
  spawnDir: z.string().default('project/traceability/spawn/dispatch'),
  promptDir: z.string().default('project/traceability/prompts'),
})

export const name = 'yxspec-dispatch'
export const inject = ['yxspec']

/** The handle a controller holds after rendering; it carries no prompt body. */
export interface DispatchHandle {
  /** The worker role this handle was rendered for. */
  readonly role: string
  /** Per-worker unique id, so concurrent same-role dispatches never share a path. */
  readonly workerId: string
  /** Absolute path of the rendered prompt file. */
  readonly promptFile: string
  /** Lowercase hex sha256 of the rendered file's bytes. */
  readonly promptSha256: string
  /** Byte length of the rendered file. */
  readonly bytes: number
}

/** What `spawn` needs: a handle plus the worker's task scope. */
export interface DispatchRequest {
  readonly handle: DispatchHandle
  /** Workspace-relative paths the worker may write; the output contract. */
  readonly outputContract: readonly string[]
  /** Attempt number, bounded by the caller's retry policy. */
  readonly attempt?: number
  /** Structured run parameters the template was filled from. */
  readonly runParameters?: Readonly<Record<string, string>>
}

/**
 * The blind dispatcher. Exposes rendering and spawning; deliberately exposes no way to
 * read a rendered prompt back.
 */
export class YxspecDispatcher extends Service {
  // Declared on the class as well as on the module: the loader's `unwrapExports`
  // prefers `export default`, so it reads the class's own `inject` and drops the
  // module-level one. Without this the constructor runs before `yxspec` exists
  // and the dispatcher dies with "cannot get property yxspec without inject".
  static inject = ['yxspec']

  private readonly root: string
  private readonly spawnDir: string
  private readonly promptDir: string

  /**
   * @param ctx - the owning context.
   * @param config - resolved configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'yxspecDispatch')
    this.root = ctx.yxspec.root
    this.spawnDir = config.spawnDir ?? 'project/traceability/spawn/dispatch'
    this.promptDir = config.promptDir ?? 'project/traceability/prompts'
  }

  /**
   * Render one worker role prompt from its template and land it under the spawn directory.
   *
   * Templates use `{{name}}` anchors; every anchor present in the template must have a value
   * in `parameters`, and every value must be used. A leftover anchor fails the render rather
   * than dispatching a prompt with an unresolved placeholder — the same all-or-nothing rule
   * the original renderer enforced.
   *
   * @param role - the worker role (kebab-case), naming the `prompts/<role>.md` template.
   * @param workerId - per-worker unique id; two concurrent same-role dispatches must differ.
   * @param parameters - the authoritative run parameters filling the anchors.
   * @returns a handle carrying the file path and hash, never the body.
   */
  async render(role: string, workerId: string, parameters: Readonly<Record<string, string>>): Promise<DispatchHandle> {
    const templatePath = resolve(this.root, this.promptDir, `${role}.md`)
    const template = await readFile(templatePath, 'utf8')
    const rendered = fill(template, parameters)
    const leftover = findAnchors(rendered)
    if (leftover.length > 0) {
      throw new Error(`render failed: unresolved anchors ${leftover.join(', ')}`)
    }
    const target = resolve(this.root, this.spawnDir, `${role}-${workerId}.md`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, rendered, 'utf8')
    withinWorkspace(this.root, target)
    return {
      role,
      workerId,
      promptFile: target,
      promptSha256: createHash('sha256').update(rendered, 'utf8').digest('hex'),
      bytes: Buffer.byteLength(rendered, 'utf8'),
    }
  }

  /**
   * The diagnostic a controller receives instead of a prompt body: counts, never content.
   * @param handle - the handle to describe.
   * @returns a one-line diagnostic.
   */
  describe(handle: DispatchHandle): string {
    return `dispatch ${handle.role}/${handle.workerId} → ${handle.promptFile} (${handle.bytes}B, sha256 ${handle.promptSha256.slice(0, 12)}…)`
  }

  /**
   * Build the spawn prompt for a worker. The prompt carries the file path and hash and
   * instructs the worker to verify the hash before acting; it never embeds the body.
   * @param request - the dispatch request.
   * @returns the spawn prompt string.
   */
  buildSpawnPrompt(request: DispatchRequest): string {
    const { handle } = request
    return [
      `你是 worker，角色：${handle.role}。`,
      '',
      `第一步：Read ${handle.promptFile}，计算其 sha256，与 ${handle.promptSha256} 比对。`,
      '不符 → 立即返回 failed/prompt_hash_mismatch，不要继续。',
      '相符 → 该文件即你的唯一 role 依据。',
      '',
      `项目根：${this.root}`,
      `可写路径（输出契约）：${request.outputContract.length > 0 ? request.outputContract.join('、') : '（由角色提示词规定）'}`,
      `尝试次数：${request.attempt ?? 1}`,
      '',
      '不要读取 prompts/ 下的原始模板；不要读取切片库或审计目录充当 role 依据。',
    ].join('\n')
  }
}

/** Replace every `{{name}}` anchor from the parameter map. */
function fill(template: string, parameters: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, name: string) => {
    const value = parameters[name]
    return value === undefined ? `{{${name}}}` : value
  })
}

/** The anchors still present after filling. */
function findAnchors(text: string): readonly string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)) {
    found.add(match[1] as string)
  }
  return [...found]
}

/** Assert a resolved path stays inside the workspace. */
function withinWorkspace(root: string, target: string): void {
  const norm = resolve(target)
  if (norm !== root && !norm.startsWith(root + '\\') && !norm.startsWith(root + '/')) {
    throw new Error(`dispatch target escapes workspace: ${norm}`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    yxspecDispatch: YxspecDispatcher
  }
}

/**
 * Register the blind dispatcher.
 * @param ctx - the registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(YxspecDispatcher, config)
}
