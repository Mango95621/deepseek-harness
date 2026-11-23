/**
 * The vanishing-path cases the picker tolerates, and the cap that ends the walk
 * one directory short of draining its queue.
 *
 * Every case here replaces a filesystem call rather than racing one for real: a
 * project tree is being written to while the wizard reads it, and the cap
 * boundary depends on which order a directory happens to be enumerated in.
 * A single spec file owns that interception so the ordinary listings stay on the
 * real filesystem.
 * @module
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocumentCandidates, type WorkspaceRegistryFace } from '../src/documents.ts'

// `spy: true` keeps every real implementation and lets one call be overridden,
// which is what a race is: the same code path with one syscall answered
// differently.
vi.mock('node:fs/promises', { spy: true })

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A registry over a fixed project list. */
function registry(roots: string[]): WorkspaceRegistryFace {
  return { list: () => [{ id: 'p1', roots }] }
}

/** A fresh scratch project root, removed after the test. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-docs-race-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Write one file under `root`, creating parents. */
async function seed(root: string, rel: string, body = 'x'): Promise<void> {
  const absolute = join(root, rel)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, body, 'utf8')
}

describe('readDocumentCandidates against a filesystem that is changing', () => {
  it('drops a file that vanished before it could be sized', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')

    // The file was listed a moment ago and is gone by the time it is stat'd.
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
    )

    await expect(readDocumentCandidates(registry([root]), 'p1')).resolves.toEqual([])
  })

  it('drops a file whose size it may not read, without failing the rest', async () => {
    const root = await scratch()
    await seed(root, 'specs/locked.md')
    await seed(root, 'specs/readable.md')

    // One unreadable entry must not cost the operator the whole listing.
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    const found = await readDocumentCandidates(registry([root]), 'p1')
    expect(found.map(view => view.title)).toEqual(['readable'])
  })

  it('ends the walk when the cap fills exactly as a directory is still queued', async () => {
    const root = await scratch()
    // One subdirectory and exactly 200 documents beside it. With the directory
    // enumerated first it is queued, the documents then fill the list to the cap
    // on the last one, and the `for` ends instead of returning early — so the
    // walk comes back around to the loop head with an unvisited directory and a
    // full list. That is the only state the loop-head check exists for.
    await mkdir(join(root, 'specs', 'later'), { recursive: true })
    await seed(root, 'specs/later/unreached.md')
    for (let i = 0; i < 200; i++) await seed(root, `specs/f${String(i).padStart(3, '0')}.md`)

    // The root listing is answered from a fixed, directory-first order; every
    // other path falls through to the real filesystem, so this is a reordering
    // and not a reimplementation of readdir.
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.spyOn(fs, 'readdir').mockImplementation((async (path: unknown, options: unknown) => {
      if (path !== join(root, 'specs')) return await actual.readdir(path as never, options as never)
      return [
        { name: 'later', isDirectory: () => true, isFile: () => false },
        ...Array.from({ length: 200 }, (_unused, i) => ({
          name: `f${String(i).padStart(3, '0')}.md`, isDirectory: () => false, isFile: () => true,
        })),
      ]
    }) as never)

    const found = await readDocumentCandidates(registry([root]), 'p1')
    expect(found).toHaveLength(200)
    expect(found.some(view => view.title === 'unreached')).toBe(false)
  })
})
