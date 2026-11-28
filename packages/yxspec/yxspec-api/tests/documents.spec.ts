/**
 * The onboarding wizard's specification step: which documents a project could be run against.
 *
 * Two sources answer, and these specs pin both of them: the operator's own added directories, and
 * the two places this process keeps a specification (`project` and `YX_Docs/projects` under each
 * root). The candidate filter is pinned too — office documents only, never markdown — along with the
 * two bounds that keep a vendored tree from swamping the picker.
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocumentCandidates, readDocumentListing, type WorkspaceRegistryFace } from '../src/documents.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

/** A registry over a fixed project list. */
function registry(projects: Array<{ id: string; roots: string[] }>): WorkspaceRegistryFace {
  return { list: () => projects }
}

/** A fresh scratch project root, removed after the test. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-yxspec-docs-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Write one file under `root`, creating parents. */
async function seed(root: string, rel: string, body = 'x'): Promise<void> {
  const absolute = join(root, rel)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, body, 'utf8')
}

/** The paths of a listing, in the order the step renders them. */
async function pathsOf(root: string, extra: readonly string[] = []): Promise<string[]> {
  const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1', extra)
  return found.map(view => view.path)
}

describe('readDocumentCandidates', () => {
  it('lists what the project directory holds, and nothing outside it', async () => {
    const root = await scratch()
    await seed(root, 'project/prd/spec.pdf')
    await seed(root, 'project/sqt/cases.docx')
    // Beside the document directory rather than in it: this process keeps specifications in
    // `project`, so a file elsewhere in the tree is not one of them.
    await seed(root, 'specs/elsewhere.pdf')

    await expect(pathsOf(root)).resolves.toEqual([
      'project/prd/spec.pdf',
      'project/sqt/cases.docx',
    ])
  })

  it('lists the documentation tree\'s own document directory too', async () => {
    const root = await scratch()
    await seed(root, 'YX_Docs/projects/delivered.xlsx')

    await expect(pathsOf(root)).resolves.toEqual(['YX_Docs/projects/delivered.xlsx'])
  })

  it('offers the project directory before the documentation tree', async () => {
    const root = await scratch()
    // `YX_Docs/...` collates before `project/...`, so the order has to come from the walk rather
    // than from the paths: the process's own directory is the first place to look.
    await seed(root, 'YX_Docs/projects/b.xlsx')
    await seed(root, 'project/a.pdf')

    await expect(pathsOf(root)).resolves.toEqual([
      'project/a.pdf',
      'YX_Docs/projects/b.xlsx',
    ])
  })

  it('offers every delivered format a specification arrives in', async () => {
    const root = await scratch()
    for (const name of ['a.doc', 'b.docx', 'c.xls', 'd.xlsx', 'e.ppt', 'f.pptx', 'g.pdf', 'h.PDF']) {
      await seed(root, `project/${name}`)
    }

    const found = await pathsOf(root)
    expect(found).toHaveLength(8)
  })

  it('never offers markdown, or the prose that sits beside it', async () => {
    const root = await scratch()
    // The markdown in these trees is working prose — design notes, guides, READMEs — and the one
    // document the step exists to find would be buried under them.
    for (const name of ['spec.md', 'notes.txt', 'data.json', 'config.yaml', 'config.yml', 'README.MD']) {
      await seed(root, `project/${name}`)
    }
    await seed(root, 'project/real.pdf')

    await expect(pathsOf(root)).resolves.toEqual(['project/real.pdf'])
  })

  it('descends a bounded number of levels and stops there', async () => {
    const root = await scratch()
    await seed(root, 'project/a/b/c/deep.pdf')
    await seed(root, 'project/a/b/c/d/too-deep.pdf')

    await expect(pathsOf(root)).resolves.toEqual(['project/a/b/c/deep.pdf'])
  })

  it('carries the partition so a row says which subtree it came from', async () => {
    const root = await scratch()
    await seed(root, 'project/prd/spec.pdf')
    await seed(root, 'project/top.pdf')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => [view.path, view.partition])).toEqual([
      ['project/prd/spec.pdf', 'prd'],
      // Directly under the walked directory: nothing above it names a group.
      ['project/top.pdf', undefined],
    ])
  })

  it('keeps the root index so the same path under two roots stays distinguishable', async () => {
    const first = await scratch()
    const second = await scratch()
    await seed(first, 'project/spec.pdf')
    await seed(second, 'project/spec.pdf')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [first, second] }]), 'p1')
    expect(found.map(view => [view.rootIndex, view.path])).toEqual([
      [0, 'project/spec.pdf'],
      [1, 'project/spec.pdf'],
    ])
  })

  it('is empty, not an error, for a project whose specification has not arrived', async () => {
    const root = await scratch()

    await expect(pathsOf(root)).resolves.toEqual([])
  })

  it('is empty for a project the registry does not know', async () => {
    await expect(readDocumentCandidates(registry([{ id: 'other', roots: ['/nowhere'] }]), 'p1'))
      .resolves.toEqual([])
  })

  it('caps the listing, reporting that it stopped', async () => {
    const root = await scratch()
    for (let index = 0; index < 205; index += 1) {
      await seed(root, `project/case-${String(index).padStart(3, '0')}.pdf`)
    }

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(listing.documents).toHaveLength(200)
    expect(listing.truncated).toBe(true)
  })

  it('spends the ceiling across every root rather than per root', async () => {
    const first = await scratch()
    const second = await scratch()
    for (let index = 0; index < 150; index += 1) {
      await seed(first, `project/a-${String(index).padStart(3, '0')}.pdf`)
      await seed(second, `project/b-${String(index).padStart(3, '0')}.pdf`)
    }

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [first, second] }]), 'p1')
    expect(listing.documents).toHaveLength(200)
    expect(listing.truncated).toBe(true)
  })
})

describe('readDocumentListing with added directories', () => {
  it('walks an added directory as itself, above the project directories', async () => {
    const root = await scratch()
    const added = await scratch()
    await seed(root, 'project/own.pdf')
    await seed(added, 'delivered.pdf')
    // Inside an added directory, `project` is a name like any other: the operator pointed at this
    // tree because the documents are in it, so a convention path beneath it means nothing.
    await seed(added, 'project/inside.pdf')

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1', [added])
    expect(listing.documents.map(view => [view.rootIndex, view.path])).toEqual([
      [1, 'delivered.pdf'],
      [1, 'project/inside.pdf'],
      [0, 'project/own.pdf'],
    ])
    // The addition is searched first, and the project's own directories follow it.
    expect(listing.searched[0]).toBe(added)
    expect(listing.searched).toContain(join(root, 'project'))
  })

  it('offers a file once when two sources reach it', async () => {
    const root = await scratch()
    await seed(root, 'project/spec.pdf')

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1', [
      join(root, 'project'),
    ])
    // The addition is walked first and its row is the one kept: an added directory's paths are
    // relative to it, so the row reads  with the index the addition was given.
    expect(listing.documents.map(view => [view.rootIndex, view.path])).toEqual([[1, 'spec.pdf']])
    expect(listing.searched).toContain(join(root, 'project'))
  })

  it('ignores an addition that is not an absolute path', async () => {
    const root = await scratch()
    await seed(root, 'project/spec.pdf')

    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1', ['relative/dir']))
      .resolves.toHaveLength(1)
  })

  it('searches an addition for a project that has no root yet', async () => {
    const added = await scratch()
    await seed(added, 'spec.pdf')
    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [] }]), 'p1', [added])

    expect(listing.documents.map(view => view.path)).toEqual(['spec.pdf'])
    expect(listing.searched).toEqual([added])
  })

  it('names every directory it looked in, whether or not it exists', async () => {
    const root = await scratch()
    await seed(root, 'project/spec.pdf')

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // The operator reads this when the list is short: a directory nobody has created is exactly the
    // fact that explains an empty answer.
    expect(listing.searched).toEqual([
      join(root, 'project'),
      join(root, 'YX_Docs', 'projects'),
    ])
  })
})
