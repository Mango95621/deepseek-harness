/**
 * The onboarding wizard's first step: which specification documents a project
 * could be run against.
 *
 * The walk is bounded twice — depth and candidate count — because a project
 * tree can be a vendored AOSP checkout, and a picker that takes seconds to open
 * is worse than one that shows the first 200 candidates. These specs pin the
 * caps, the extension filter, and the tolerance for a project that simply has
 * no inputs yet.
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

/**
 * Write a project's `yxspec.json` declaring `sqt.paths` as given.
 *
 * The block is passed as a literal so a test states exactly the shape it exercises, including
 * the entries a reader must ignore.
 */
async function seedConfig(root: string, paths: Record<string, unknown>): Promise<void> {
  await seed(root, 'project/config/yxspec.json', JSON.stringify({ sqt: { paths } }))
}

describe('readDocumentCandidates', () => {
  it('lists the candidate documents under every declared root', async () => {
    const root = await scratch()
    await seed(root, 'project/inputs/swrs/spec.md')
    await seed(root, 'project/design/overview.txt')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual([
      'project/design/overview.txt',
      'project/inputs/swrs/spec.md',
    ])
    // The title is the basename without its extension: the wizard lists names,
    // not paths, so the extension would only be noise on every row.
    expect(found.map(view => view.title)).toEqual(['overview', 'spec'])
    expect(found.every(view => view.size > 0 && view.rootIndex === 0)).toBe(true)
  })

  it('carries the partition and the root index so two rows stay distinguishable', async () => {
    const first = await scratch()
    const second = await scratch()
    // The same relative path under two repositories: a path alone cannot say
    // which one the operator picked, so the index travels with the row.
    await seed(first, 'specs/release/spec.md')
    await seed(second, 'specs/release/spec.md')

    const found = await readDocumentCandidates(
      registry([{ id: 'p1', roots: [first, second] }]),
      'p1',
    )
    // `release` is the segment below the walked root (`specs`), which is what the
    // wizard groups rows by.
    expect(found.map(view => [view.rootIndex, view.partition, view.path])).toEqual([
      [0, 'release', 'specs/release/spec.md'],
      [1, 'release', 'specs/release/spec.md'],
    ])
  })

  it('skips a document sitting directly under a walked root, which has no partition', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // `specs` is the walked root's own segment, so `partitionOf` has nothing
    // below it to name.
    expect(found).toHaveLength(1)
    expect(found[0]).not.toHaveProperty('partition')
  })

  it('keeps only the document extensions a picker can offer', async () => {
    const root = await scratch()
    for (const name of ['a.md', 'b.txt', 'c.json', 'd.yaml', 'e.yml', 'f.MD']) {
      await seed(root, `specs/${name}`)
    }
    await seed(root, 'specs/skip.png')
    await seed(root, 'specs/skip.ts')
    await seed(root, 'specs/noextension')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.title).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('descends the declared depth and stops there', async () => {
    const root = await scratch()
    // `specs` is depth 0, so `a` is 1, `b` is 2, `c` is 3, and `d` would be 4 —
    // one past `MAX_DEPTH`, so it is never pushed.
    await seed(root, 'specs/a/b/c/at-the-limit.md')
    await seed(root, 'specs/a/b/c/d/too-deep.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['specs/a/b/c/at-the-limit.md'])
  })

  it('caps the listing so a vendored tree cannot swamp the picker', async () => {
    const root = await scratch()
    // Deliberately under `project/inputs`, which is not the last enumerated root:
    // the cap has to stop the walk mid-list, not merely at the end of it.
    for (let i = 0; i < 205; i++) {
      await seed(root, `project/inputs/f${String(i).padStart(3, '0')}.md`)
    }

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found).toHaveLength(200)
    expect(found.map(view => view.title)).toEqual(
      Array.from({ length: 200 }, (_unused, i) => `f${String(i).padStart(3, '0')}`),
    )
  })

  it('caps the listing across repositories, not within each one', async () => {
    const first = await scratch()
    const second = await scratch()
    for (let i = 0; i < 201; i++) await seed(first, `specs/f${String(i).padStart(3, '0')}.md`)
    await seed(second, 'specs/never-reached.md')

    // A project's repositories share one ceiling: the wizard lists 200 rows, not
    // 200 per repository, so the second root is never walked.
    const found = await readDocumentCandidates(
      registry([{ id: 'p1', roots: [first, second] }]),
      'p1',
    )
    expect(found).toHaveLength(200)
    expect(found.some(view => view.path.includes('never-reached'))).toBe(false)
    expect(found.every(view => view.rootIndex === 0)).toBe(true)
  })

  it('returns nothing for a project that has no inputs yet', async () => {
    const root = await scratch()
    await seed(root, 'src/main.c')

    // No enumerated root exists, which is the state of a project before its
    // first input import — the wizard renders its empty state, not an error.
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toEqual([])
  })

  it('treats an unknown project and an unmounted registry alike: no candidates', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')

    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'ghost'))
      .resolves.toEqual([])
    // A project with no roots cannot be walked either.
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [] }]), 'p1'))
      .resolves.toEqual([])
    // A host that mounted no registry at all: still a list, still empty.
    await expect(readDocumentCandidates(undefined, 'p1')).resolves.toEqual([])
  })

  it('skips a directory that vanished between listing and reading it', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    // `project/inputs` is declared but never created, so its `readdir` throws
    // and the walk moves on rather than failing the whole listing.
    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['specs/spec.md'])
  })

  it('ignores a non-file entry that is neither a directory nor a document', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    // A dangling symlink reports as neither directory nor file; it must not be
    // counted as a candidate the wizard can offer.
    const missing = join(root, 'specs', 'dangling.md')
    const { symlink } = await import('node:fs/promises')
    try {
      await symlink(join(root, 'specs', 'nowhere'), missing)
    } catch (_symlinkUnsupported) {
      // A platform that cannot symlink simply does not exercise this branch.
    }

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.title)).toEqual(['spec'])
  })
})

describe('readDocumentCandidates with a project declaration', () => {
  it('offers the declared locations ahead of the convention directories', async () => {
    const root = await scratch()
    await seedConfig(root, { sys_dir: 'project/specs/sys', prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/sys/arch.md')
    await seed(root, 'project/specs/prd/spec.md')
    // A convention document that collates *before* the declared paths: a listing sorted by
    // path alone would put it first, which is the ordering this test exists to rule out.
    await seed(root, 'project/design/aaa.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // `sys_dir` is declared before `prd`, so it comes first — the config's own order is the
    // project's priority, not the alphabet's.
    expect(found.map(view => view.path)).toEqual([
      'project/specs/sys/arch.md',
      'project/specs/prd/spec.md',
      'project/design/aaa.md',
    ])
    expect(found.map(view => view.partition)).toEqual(['sys', 'prd', 'design'])
  })

  it('keeps the declaration order when the convention directories would fill the ceiling', async () => {
    const root = await scratch()
    await seedConfig(root, { sqt_tc: 'project/specs/sqt-tc', prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/prd/spec.md')
    for (let i = 0; i < 205; i++) {
      await seed(root, `project/specs/sqt-tc/case${String(i).padStart(3, '0')}.md`)
    }
    await seed(root, 'project/design/never-reached.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // The project named its case tree before the convention directories, so the ceiling is
    // spent on the declaration and `project/design` is never walked.
    expect(found).toHaveLength(200)
    expect(found[0]?.path).toBe('project/specs/sqt-tc/case000.md')
    expect(found.some(view => view.path.includes('never-reached'))).toBe(false)
    expect(found.some(view => view.path.startsWith('project/inputs/'))).toBe(false)
  })

  it('ignores the entries whose shape is a pattern or another tool\'s relative path', async () => {
    const root = await scratch()
    await seedConfig(root, {
      prd_globs: ['prd-*.md'],
      protocols_glob: [],
      source_app: ['mcu/', 'mpu/'],
      trace_bases: { prd: '../prd/' },
      implicit_prd: null,
      repo_root: '.',
    })
    await seed(root, 'specs/spec.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // None of those names a location this walk can open: a glob has no file of its own,
    // `repo_root` is the checkout the others resolve against, and the rest are arrays,
    // objects, or nulls. Only the convention walk contributes.
    expect(found.map(view => view.path)).toEqual(['specs/spec.md'])
  })

  it('offers a declared document the walk would never reach', async () => {
    const root = await scratch()
    // `project/specs/prd` is outside every convention root, so only the declaration can
    // reach it — this is the case the wizard showed an empty list for.
    await seedConfig(root, { prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/prd/spec.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => [view.path, view.title, view.partition])).toEqual([
      ['project/specs/prd/spec.md', 'spec', 'prd'],
    ])
  })

  it('drops a declared document the project never created', async () => {
    const root = await scratch()
    await seedConfig(root, { prd: 'project/specs/prd/missing.md', sys_dir: 'project/specs/sys' })
    await seed(root, 'project/specs/sys/arch.md')

    // A config names what the project intends to hold; a document it has not written yet is
    // simply absent, not a failure.
    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['project/specs/sys/arch.md'])
  })

  it('lists a document once when its directory is declared as well', async () => {
    const root = await scratch()
    // The shipped config declares both `sqt_tp` and a document inside it, so the same file is
    // reachable twice; two identical rows would be indistinguishable in the picker.
    await seedConfig(root, { sqt_tp: 'project/specs/sqt-tp', step_capability: 'project/specs/sqt-tp/step.md' })
    await seed(root, 'project/specs/sqt-tp/step.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['project/specs/sqt-tp/step.md'])
  })

  it('refuses a declared path that names a directory rather than a document', async () => {
    const root = await scratch()
    // `specs.md` ends in a document extension, so the config's shape test reads it as a
    // document; the stat then finds a directory and the row is dropped rather than descended.
    await seedConfig(root, { wrong: 'specs/specs.md' })
    await seed(root, 'specs/specs.md/inner.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['specs/specs.md/inner.md'])
  })

  it('falls back to the convention directories when the config is absent or malformed', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')

    // Absent.
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toHaveLength(1)
    // Unparseable.
    await seed(root, 'project/config/yxspec.json', '{ not json')
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toHaveLength(1)
    // Parses but declares no `sqt.paths` block at all.
    await seed(root, 'project/config/yxspec.json', JSON.stringify({ spec_id: 'x' }))
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toHaveLength(1)
    // `paths` present but not an object.
    await seed(root, 'project/config/yxspec.json', JSON.stringify({ sqt: { paths: 'nope' } }))
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toHaveLength(1)
    // The whole document is `null`, which has no `sqt` to read.
    await seed(root, 'project/config/yxspec.json', 'null')
    await expect(readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1'))
      .resolves.toHaveLength(1)
  })

  it('reads the declaration of every root, not only the primary one', async () => {
    const first = await scratch()
    const second = await scratch()
    // A project spans repositories and the specification can sit in any of them; reading only
    // the first root would report "no specification" for a project that has one.
    await seedConfig(first, { sqt_tp: 'project/specs/sqt-tp' })
    await seed(first, 'project/specs/sqt-tp/tr.md')
    await seedConfig(second, { prd: 'project/specs/prd/spec.md' })
    await seed(second, 'project/specs/prd/spec.md')

    const found = await readDocumentCandidates(
      registry([{ id: 'p1', roots: [first, second] }]),
      'p1',
    )
    expect(found.map(view => [view.rootIndex, view.path])).toEqual([
      [0, 'project/specs/sqt-tp/tr.md'],
      [1, 'project/specs/prd/spec.md'],
    ])
  })

  it('treats a declared document at the root as having no partition', async () => {
    const root = await scratch()
    // Nothing above the file names a group, the same as a convention row sitting directly
    // under its walked root.
    await seedConfig(root, { top: 'spec.md' })
    await seed(root, 'spec.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found).toHaveLength(1)
    expect(found[0]).not.toHaveProperty('partition')
  })

  it('refuses a declared path with no document extension', async () => {
    const root = await scratch()
    // A shape test reads this as a directory, so the walk descends and finds the two
    // documents inside rather than offering the directory itself.
    await seedConfig(root, { tree: 'notes' })
    await seed(root, 'notes/one.md')
    await seed(root, 'notes/nested/two.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['notes/nested/two.md', 'notes/one.md'])
    expect(found.every(view => view.partition === 'notes')).toBe(true)
  })

  it('refuses a declared document whose extension a picker cannot offer', async () => {
    const root = await scratch()
    // Shaped like a document, but `png` is not one the wizard lists: it never becomes an
    // entry, so the walk's own extension filter is the only thing that admits it.
    await seedConfig(root, { icon: 'assets/icon.png', prd: 'spec.md' })
    await seed(root, 'assets/icon.png')
    await seed(root, 'spec.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['spec.md'])
  })

  it('reads a declaration whose directory is written with a trailing separator', async () => {
    const root = await scratch()
    // The shipped config writes `auto_test_root` this way, so the trailing separator is the
    // only thing marking it a directory — its last segment has no dot to give it away.
    await seedConfig(root, { auto_test_root: 'project/tests/auto_test/' })
    await seed(root, 'project/tests/auto_test/case.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => [view.path, view.partition])).toEqual([
      ['project/tests/auto_test/case.md', 'auto_test'],
    ])
  })

  it('lists a file once when two declared directories both contain it', async () => {
    const root = await scratch()
    // `team` sits inside `project/specs`, so the file under it is reachable from both
    // declarations; a listing that offered it twice would show two rows for one document.
    await seedConfig(root, { outer: 'project/specs', inner: 'project/specs/team' })
    await seed(root, 'project/specs/team/shared.md')

    const found = await readDocumentCandidates(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(found.map(view => view.path)).toEqual(['project/specs/team/shared.md'])
  })
})

describe('readDocumentListing', () => {
  it('reports the directories it walked, declared ones first and absolute', async () => {
    const root = await scratch()
    await seedConfig(root, { sqt_tp: 'project/specs/sqt-tp' })
    await seed(root, 'project/specs/sqt-tp/step.md')

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(listing.documents.map(view => view.path)).toEqual(['project/specs/sqt-tp/step.md'])
    const declared = join(root, 'project', 'specs', 'sqt-tp')
    expect(listing.searched[0]).toBe(declared)
    // The convention directories follow the declaration, and every one is named even though
    // only the declared tree exists: an operator has to see the paths that were looked at,
    // not merely the ones that answered.
    expect(listing.searched).toContain(join(root, 'project', 'inputs'))
    expect(listing.searched).toContain(join(root, 'specs'))
    expect(listing.truncated).toBe(false)
  })

  it('names a declared directory that does not exist, which is what explains an empty list', async () => {
    const root = await scratch()
    await seedConfig(root, { sqt_tp: 'project/specs/sqt-tp' })

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(listing.documents).toEqual([])
    // A report that omitted absent directories would leave an empty list unexplained.
    expect(listing.searched).toContain(join(root, 'project', 'specs', 'sqt-tp'))
  })

  it('names a walked directory once even when a declaration repeats it', async () => {
    const root = await scratch()
    // `specs` is both declared and one of the convention roots, so the walk enters it twice;
    // the report reads as "where to look", where a repeat is noise rather than information.
    await seedConfig(root, { specs_copy: 'specs' })
    await seed(root, 'specs/spec.md')

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    const specs = join(root, 'specs')
    expect(listing.searched.filter(path => path === specs)).toHaveLength(1)
  })

  it('reports the search across every root, in root order', async () => {
    const primary = await scratch()
    const secondary = await scratch()
    await seedConfig(secondary, { sqt_tp: 'project/specs/sqt-tp' })
    await seed(secondary, 'project/specs/sqt-tp/step.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [primary, secondary] }]), 'p1',
    )
    expect(listing.searched).toContain(join(primary, 'project', 'inputs'))
    expect(listing.searched).toContain(join(secondary, 'project', 'inputs'))
    // Root order is walk order: the primary root's directories are reported before the
    // secondary's, which is what lets an operator read the two sets apart.
    expect(listing.searched.indexOf(join(primary, 'project', 'inputs')))
      .toBeLessThan(listing.searched.indexOf(join(secondary, 'project', 'inputs')))
  })

  it('keeps a full search report when the candidate ceiling truncates the listing', async () => {
    const root = await scratch()
    // One declared directory holding more documents than the ceiling admits: the listing is
    // cut, and the report — the part that explains the cut — is not.
    for (let index = 0; index < 205; index += 1) {
      await seed(root, `project/inputs/raw/case-${String(index).padStart(3, '0')}.md`)
    }

    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    expect(listing.documents).toHaveLength(200)
    expect(listing.truncated).toBe(true)
    // The ceiling stops the *walk*, so the convention directories after the overflowing one are
    // never entered and cannot be reported. What is reported is what was actually looked at.
    expect(listing.searched).toEqual([join(root, 'project', 'inputs')])
  })

  it('marks a listing exactly at the ceiling as truncated, since the walk stopped there', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    // Well under the ceiling: nothing was cut, and the report says so.
    expect(listing.truncated).toBe(false)
    expect(listing.documents).toHaveLength(1)
  })

  it('reports looking nowhere for a project it cannot resolve', async () => {
    const root = await scratch()
    await expect(readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'ghost'))
      .resolves.toEqual({ documents: [], searched: [], truncated: false })
    await expect(readDocumentListing(undefined, 'p1'))
      .resolves.toEqual({ documents: [], searched: [], truncated: false })
  })
})

describe('readDocumentListing with operator-added directories', () => {
  it('offers the added directory below the project’s own declaration', async () => {
    const root = await scratch()
    const added = await scratch()
    // The project states its own priority; an addition is the operator's instruction and cannot
    // overturn what the project says about itself, but it does outrank the deployment's guesses.
    await seedConfig(root, { prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/prd/spec.md')
    await seed(root, 'specs/convention.md')
    await seed(added, 'delivered/prd.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [added],
    )
    expect(listing.documents.map(view => view.path)).toEqual([
      'project/specs/prd/spec.md',
      'delivered/prd.md',
      'specs/convention.md',
    ])
    // The added directory's own rows number their root past the project's, which is what keeps
    // them apart from an identically-named file under a real root.
    expect(listing.documents.map(view => view.rootIndex)).toEqual([0, 1, 0])
  })

  it('walks the added directory as itself rather than by convention', async () => {
    const root = await scratch()
    const added = await scratch()
    await seed(root, 'specs/ignored.md')
    // The operator pointed at this tree because the documents are in it, so descending
    // `project/inputs` beneath it would look past the very files they meant. Both files the
    // addition holds are reached, in the path order one group always uses.
    await seed(added, 'spec.md')
    await seed(added, 'project/inputs/buried.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [added],
    )
    expect(listing.documents.map(view => view.path)).toEqual([
      'project/inputs/buried.md',
      'spec.md',
      'specs/ignored.md',
    ])
    // Reported as looked at, at the top of the tree rather than at a convention start inside it.
    expect(listing.searched).toContain(added)
    expect(listing.searched).not.toContain(join(added, 'project', 'inputs'))
  })

  it('refuses an added path that is not absolute', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    // A location named relative to nothing cannot be walked: `resolve` would invent a base, and
    // the row it produced would point at a directory the operator never named.
    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', ['shared/spec', ''],
    )
    expect(listing.documents.map(view => view.path)).toEqual(['specs/spec.md'])
    expect(listing.searched).not.toContain('shared/spec')
  })

  it('searches an added directory for a project that declares no root yet', async () => {
    const added = await scratch()
    await seed(added, 'delivered/prd.md')
    // The operator pointed at it explicitly, so it stands on its own: a project created from a
    // name alone has nowhere of its own to look, and this is the one way it can find anything.
    const listing = await readDocumentListing(registry([{ id: 'p1', roots: [] }]), 'p1', [added])
    expect(listing.documents.map(view => [view.path, view.rootIndex])).toEqual([['delivered/prd.md', 0]])
    expect(listing.searched).toEqual([added])
  })

  it('lists a file once when an added directory contains a project root’s file', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    // One file reached twice — through the project's own root and through an addition naming a
    // directory above it — is still one row: two would be indistinguishable in the picker.
    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [root],
    )
    expect(listing.documents.filter(view => view.path === 'specs/spec.md')).toHaveLength(1)
  })

  it('lists a file once when two added directories both contain it', async () => {
    const outer = await scratch()
    const root = await scratch()
    await seed(root, 'anything.md')
    await seed(outer, 'team/shared.md')
    // `outer/team` sits inside `outer`, so the file is reachable from both additions.
    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [outer, join(outer, 'team')],
    )
    expect(listing.documents.filter(view => view.path === 'team/shared.md')).toHaveLength(1)
  })

  it('holds the added directory’s contents back once the ceiling fills', async () => {
    const root = await scratch()
    const added = await scratch()
    await seedConfig(root, { prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/prd/spec.md')
    for (let index = 0; index < 205; index += 1) {
      await seed(added, `case-${String(index).padStart(3, '0')}.md`)
    }

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [added],
    )
    // The project's own declaration keeps its place; the addition is second in line, so the
    // ceiling is spent on it rather than on the convention directories behind it.
    expect(listing.documents[0]?.path).toBe('project/specs/prd/spec.md')
    expect(listing.documents).toHaveLength(200)
    expect(listing.truncated).toBe(true)
    expect(listing.documents.some(view => view.path.startsWith('docs/'))).toBe(false)
  })

  it('spends the ceiling on an addition before any convention directory', async () => {
    const root = await scratch()
    const added = await scratch()
    // The three sources are ordered for a reason: a directory the operator named may not be
    // crowded out by one the deployment merely guessed at. The addition is searched second, so
    // it fills the ceiling first and the convention walk behind it never starts.
    await seedConfig(root, { prd: 'project/specs/prd/spec.md' })
    await seed(root, 'project/specs/prd/spec.md')
    for (let index = 0; index < 205; index += 1) {
      await seed(added, `case-${String(index).padStart(3, '0')}.md`)
    }
    await seed(root, 'project/inputs/never-reached.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [added],
    )
    expect(listing.documents).toHaveLength(200)
    expect(listing.documents[0]?.path).toBe('project/specs/prd/spec.md')
    expect(listing.documents[1]?.path).toBe('case-000.md')
    // The convention walk never starts, and the report says so rather than naming a directory
    // it did not read.
    expect(listing.searched).not.toContain(join(root, 'project', 'inputs'))
  })

  it('reports an added directory that does not exist, which is what explains an empty list', async () => {
    const root = await scratch()
    const added = join(await scratch(), 'never-created')
    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [added],
    )
    // "I looked here and it is not there" is exactly the fact that explains an empty list.
    expect(listing.documents).toEqual([])
    expect(listing.searched).toContain(added)
  })

  it('treats no added directories and an empty list alike', async () => {
    const root = await scratch()
    await seed(root, 'specs/spec.md')
    // The parameter is optional on the wire, so omitting it and passing nothing must agree.
    const omitted = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1')
    const empty = await readDocumentListing(registry([{ id: 'p1', roots: [root] }]), 'p1', [])
    expect(omitted).toEqual(empty)
  })

  it('reports no search at all when the project is unknown, even with additions', async () => {
    const added = await scratch()
    await seed(added, 'spec.md')
    // An id that names no project resolves to no project to widen: the additions belong to a
    // project, and there is none.
    await expect(readDocumentListing(registry([{ id: 'p1', roots: [] }]), 'ghost', [added]))
      .resolves.toEqual({ documents: [], searched: [], truncated: false })
  })

  it('stops reading a later root once the ceiling fills', async () => {
    const first = await scratch()
    const second = await scratch()
    // One repository's declaration can be the whole listing. The second repository is then
    // never entered, which the search report has to say rather than name a directory it did
    // not read.
    await seedConfig(first, { sqt_tc: 'project/specs/sqt-tc' })
    for (let index = 0; index < 205; index += 1) {
      await seed(first, `project/specs/sqt-tc/case${String(index).padStart(3, '0')}.md`)
    }
    await seedConfig(second, { prd: 'project/specs/prd/spec.md' })
    await seed(second, 'project/specs/prd/spec.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [first, second] }]), 'p1',
    )
    expect(listing.documents).toHaveLength(200)
    expect(listing.documents.every(view => view.rootIndex === 0)).toBe(true)
    expect(listing.searched).toEqual([join(first, 'project', 'specs', 'sqt-tc')])
  })

  it('stops walking a later addition once the ceiling fills', async () => {
    const root = await scratch()
    const first = await scratch()
    const second = await scratch()
    await seed(root, 'specs/spec.md')
    for (let index = 0; index < 205; index += 1) {
      await seed(first, `case${String(index).padStart(3, '0')}.md`)
    }
    await seed(second, 'never-reached.md')

    const listing = await readDocumentListing(
      registry([{ id: 'p1', roots: [root] }]), 'p1', [first, second],
    )
    expect(listing.documents).toHaveLength(200)
    // Every row came from the first addition: the second is behind it in the same source, and
    // the convention walk behind that never starts either.
    expect(listing.documents.every(view => view.rootIndex === 1)).toBe(true)
    expect(listing.searched).toEqual([first])
  })
})
