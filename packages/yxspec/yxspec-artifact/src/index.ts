/**
 * The YXSpec artifact ledger. YXSpec's completion rule is that a step is done when its
 * artifacts have landed on disk — never when the agent says it is done. This service is
 * that rule, made mechanical and readable by other plugins.
 *
 * The ledger watches the workspace for file writes the harness performs (through the
 * `fs/write` observation point) and answers `landed(path)` from real filesystem state.
 * It deliberately re-stats on every query rather than trusting an accumulated set, so a
 * file removed out of band is reported as gone: a step that lost its inputs must go back
 * to failing its gate.
 * @module @deepseek-ai/dsh-yxspec-artifact
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {} from '@deepseek-ai/dsh-yxspec'

/** Plugin configuration. */
export interface Config {
  /**
   * Emission interval for the `yxspec/artifact-write` observation event, in milliseconds.
   * Zero disables emission; the ledger still answers queries.
   */
  emitIntervalMs?: number
}

/** Schemastery configuration for the artifact ledger. */
export const Config: z<Config> = z.object({
  emitIntervalMs: z.natural().default(0),
})

export const name = 'yxspec-artifact'
export const inject = ['yxspec']

/** One observed artifact write. */
export interface ArtifactWrite {
  /** Workspace-relative path (POSIX separators). */
  readonly path: string
  /** Size in bytes at observation time. */
  readonly bytes: number
  /** Whether this path is a declared input of any stage step. */
  readonly declared: boolean
}

/**
 * The artifact ledger. Answers existence queries against the workspace root the YXSpec
 * service resolved, so every consumer shares one path base.
 */
export class YxspecArtifactLedger extends Service {
  // Declared on the class as well as on the module: the loader's `unwrapExports`
  // prefers `export default`, so it reads the class's own `inject` and drops the
  // module-level one. Without this the constructor runs before `yxspec` exists
  // and the ledger dies with "cannot get property yxspec without inject".
  static inject = ['yxspec']

  private readonly root: string
  private readonly emitIntervalMs: number

  /**
   * @param ctx - the owning context.
   * @param config - resolved configuration.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'yxspecArtifacts')
    this.root = ctx.yxspec.root
    this.emitIntervalMs = config.emitIntervalMs ?? 0
  }

  /** The workspace root every path in this ledger is relative to. */
  get base(): string {
    return this.root
  }

  /**
   * Whether a workspace-relative path has landed as a readable file. Re-stats on every
   * call; a path that vanished since an earlier call reads as absent.
   * @param rel - the workspace-relative path (POSIX separators).
   * @returns true when the path exists and is a file.
   */
  async landed(rel: string): Promise<boolean> {
    const abs = this.resolveOne(rel)
    try {
      const info = await stat(abs)
      return info.isFile()
    } catch {
      return false
    }
  }

  /**
   * Which of the given paths have landed, in one pass.
   * @param rels - workspace-relative paths.
   * @returns the subset that exists on disk, in input order.
   */
  async landedOf(rels: readonly string[]): Promise<readonly string[]> {
    const out: string[] = []
    for (const rel of rels) {
      if (await this.landed(rel)) out.push(rel)
    }
    return out
  }

  /**
   * Which of the given paths are still missing.
   * @param rels - workspace-relative paths.
   * @returns the subset absent from disk, in input order.
   */
  async missingOf(rels: readonly string[]): Promise<readonly string[]> {
    const out: string[] = []
    for (const rel of rels) {
      if (!(await this.landed(rel))) out.push(rel)
    }
    return out
  }

  /**
   * Record an observed write. Called by the plugin's own `fs` observation hook; public so a
   * deployment can feed the ledger from an out-of-band watcher.
   * @param rel - the workspace-relative path written.
   * @returns the recorded observation, or `undefined` when the path is outside the workspace.
   */
  async observe(rel: string): Promise<ArtifactWrite | undefined> {
    const abs = this.resolveOne(rel)
    let bytes = 0
    try {
      const info = await stat(abs)
      if (!info.isFile()) return undefined
      bytes = info.size
    } catch {
      return undefined
    }
    const write: ArtifactWrite = { path: this.relativize(abs), bytes, declared: this.isDeclared(rel) }
    if (this.emitIntervalMs > 0) this.ctx.emit('yxspec/artifact-write', write)
    return write
  }

  /**
   * Whether any stage step declares this path as a required input.
   * @param rel - the workspace-relative path.
   * @returns true when some step gates on it.
   */
  isDeclared(rel: string): boolean {
    const norm = this.normalize(rel)
    for (const stage of this.ctx.yxspec.stages()) {
      for (const step of stage.steps) {
        if (step.requiredInputs.some(p => this.normalize(p) === norm)) return true
      }
    }
    return false
  }

  private resolveOne(rel: string): string {
    return resolve(this.root, rel)
  }

  private relativize(abs: string): string {
    const rel = abs.slice(this.root.length).replace(/^[\\/]+/, '')
    return this.normalize(rel)
  }

  private normalize(rel: string): string {
    return rel.replace(/\\/g, '/')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    yxspecArtifacts: YxspecArtifactLedger
  }

  interface Events {
    /**
     * An artifact write was observed in the workspace. Emitted only when
     * `emitIntervalMs` is positive; the ledger answers queries regardless.
     * @param write - the observed write.
     * @mode emit
     */
    'yxspec/artifact-write'(write: ArtifactWrite): void
  }
}

/**
 * Register the artifact ledger.
 * @param ctx - the registrant context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(YxspecArtifactLedger, config)
}
