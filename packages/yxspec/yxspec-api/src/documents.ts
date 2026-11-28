/**
 * Candidate specification documents for the onboarding wizard's specification step.
 *
 * Two sources answer where a specification lives, in that order:
 *
 * 1. **The operator's own additions.** Directories the operator attached from the step, passed in as
 *    {@link readDocumentListing}'s `extraDirectories`. A specification tree often lives beside the
 *    repositories rather than inside one — a delivered package, a shared document folder, a
 *    process-input archive — and nothing in the project's layout names it. An explicit instruction
 *    outranks a lookup in a conventional place.
 * 2. **The deployment's document directories.** `project` and `YX_Docs/projects`, relative to each
 *    registered root. These are where this process keeps the specification a run is performed
 *    against, and the pair is fixed rather than discovered: a document is enumerated because it
 *    sits where the process says specifications sit, which is the one rule an operator can predict
 *    without reading this module.
 *
 * A candidate is an *office document* — `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.pdf` —
 * and never markdown. The specification of a gated automotive run is a delivered document, and the
 * markdown in these trees is working prose: design notes, guides, READMEs. Offering those would bury
 * the one file the step exists to find under forty it does not want.
 *
 * An added directory is walked as itself rather than joined to a convention path. The operator
 * points at a tree that holds the documents, so descending `project` beneath it would look past the
 * very files they meant; the walk therefore enters it directly, under the same depth and count
 * bounds. Rows from it carry their path relative to that directory and an index continuing past the
 * project's roots, so the same relative path from two sources stays two distinguishable rows — and
 * a file already reachable through a root is offered once, because deletion at the row level is
 * decided by the file's absolute path rather than by how the walk arrived at it.
 *
 * The walk is bounded twice on purpose. A project tree can be enormous — a vendored AOSP checkout
 * alone would swamp any listing — and a browser step that takes seconds to open is worse than one
 * that shows the first 200 candidates. Depth and file count are both capped, and the caps are named
 * constants rather than inline numbers so a deployment can see them.
 *
 * Every location the walk enters is reported back alongside the candidates. The list is what the
 * operator reads when it comes back empty, and "no document found" alone cannot tell them whether
 * the project has no specification yet or they pointed the wizard at the wrong directory.
 * @module @deepseek-ai/dsh-yxspec-api/documents
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { YxspecDocumentListing, YxspecDocumentView } from './types.ts'

/** Extensions a specification document may carry: the delivered formats, and nothing else. */
const DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf'])

/**
 * Where this process keeps a project's specification, relative to each registered root.
 *
 * Fixed paths rather than a search: `project` is the process's own directory, and `YX_Docs/projects`
 * is the documentation tree's, for a project whose documents live beside the code rather than in it.
 */
const DOCUMENT_ROOTS = ['project', 'YX_Docs/projects'] as const

/**
 * Which of the two sources a row came from, ordered the way the step must read them.
 *
 * A tier ahead of the group rather than a numeric band woven into it: the group is a position
 * *within* one source (a document root's index, an addition's ordinal), and merging the two into a
 * single scale would make a deployment with many document roots sort above the operator's own
 * addition. Two axes keep the sources strictly ordered whatever their sizes.
 */
const TIER_ADDED = 0
/** The deployment's own directories: what to offer when the operator named nothing. */
const TIER_DOCUMENTS = 1

/** How deep below each root the walk descends. */
const MAX_DEPTH = 3

/** Ceiling on returned candidates; the wizard lists them, so an unbounded scan helps nobody. */
const MAX_CANDIDATES = 200

/** The workspace-registry face this module reads, named so the walk stays testable. */
export interface WorkspaceRegistryFace {
  /**
   * The registered projects.
   * @returns every project the host knows.
   */
  list(): readonly { readonly id: string; readonly roots: readonly string[] }[]
}

/** A candidate plus the source and group it came from. */
interface Ranked {
  readonly view: YxspecDocumentView
  /**
   * Which of the two sources the row came from: an operator-added directory or the deployment's own
   * document directory.
   *
   * A separate axis from {@link group} because the two answer different questions. The tier is
   * *whose word* a row rests on, and it must decide the ordering regardless of how many rows the
   * source contributes — a deployment walking many directories still may not push an operator's own
   * addition below its own conventions. The group is a position *within* one source (a document
   * root's index, an addition's ordinal), which only breaks ties inside a tier.
   */
  readonly tier: number
  /**
   * Which location the row came from: an addition's ordinal, or a document root's index.
   *
   * Ordering by this rather than by path is what preserves the declared order of the document roots
   * — `project` before `YX_Docs/projects` — instead of handing the candidate ceiling to whichever
   * tree happens to collate earlier. Within one group the rows stay path-sorted, so a directory's
   * contents read the same way on every run.
   *
   * The group stays out of {@link YxspecDocumentView}: it is this module's ordering device,
   * not something a client renders.
   */
  readonly group: number
}

/**
 * Order the collected rows: the operator's additions, then the deployment's document directories;
 * within each group, by root and path.
 * @param a - one row.
 * @param b - the other row.
 * @returns the comparison result.
 */
function compareCandidates(a: Ranked, b: Ranked): number {
  return a.tier - b.tier
    || a.group - b.group
    || a.view.rootIndex - b.view.rootIndex
    || a.view.path.localeCompare(b.view.path)
}

/**
 * Enumerate candidate specification documents for one project.
 *
 * Every declared root is walked, not only the primary one. A project spans an IVI application, MCU
 * firmware, and often a vendored tree; the specification can live in whichever of them the team
 * keeps its process inputs in, so limiting the search to `roots[0]` would report "no specification"
 * for a project that has one. Each candidate carries the root it came from, so a wizard showing two
 * files with the same relative path can still tell them apart.
 *
 * A missing directory is not an error: a project before its specification is delivered simply has
 * nothing to offer, and the step renders its empty state beside the control that defers the choice.
 * Only enumerated directories are read, so a project root full of unrelated files produces no
 * candidates rather than a slow scan.
 *
 * The result reports where the walk looked, not only what it found. An empty candidate list is
 * ambiguous on its own — it reads the same whether the project has no specification yet or the
 * operator selected the wrong directory — so the listing carries the absolute directories that were
 * enumerated, and whether the ceiling cut the candidates short. The caller needs neither to render a
 * populated list; both are what make an *empty* one actionable.
 *
 * The two sources are walked in separate passes rather than per root, so the candidate ceiling is
 * spent in priority order across the whole project: every root's document directories before any
 * convention. A single pass per root would let the first repository's guessed directory crowd out
 * the second repository's own document tree, which is the ordering this exists to prevent.
 * @param registry - the workspace registry to resolve the project through.
 * @param workspaceId - the project whose documents to list.
 * @param extraDirectories - absolute directories the operator added to the search, in the
 *   order they were added; entries that are not absolute are ignored, because a location
 *   named relative to nothing cannot be walked. Searched even for a project that declares no
 *   repository root yet.
 * @returns the candidates, the directories searched, and whether the ceiling truncated the
 *   listing; empty when the project is unknown and nothing was added.
 */
export async function readDocumentListing(
  registry: WorkspaceRegistryFace | undefined,
  workspaceId: string,
  extraDirectories: readonly string[] = [],
): Promise<YxspecDocumentListing> {
  const empty: YxspecDocumentListing = { documents: [], searched: [], truncated: false }
  const project = registry?.list().find(candidate => candidate.id === workspaceId)
  if (project === undefined) return empty
  // An added directory stands on its own: the operator pointed at it explicitly, so it does not
  // need a repository root to resolve against and is searched for a project that has none.
  const added = extraDirectories.filter(path => isAbsolute(path))
  if (project.roots.length === 0 && added.length === 0) return empty
  const out: Ranked[] = []
  // Keyed by the file's own absolute path: an added directory can hold a root's file, and two
  // additions can name the same tree — every one of those would otherwise render as two identical
  // rows the operator cannot tell apart. Two rows of one file are the same file no matter which
  // source reached it.
  const seen = new Set<string>()
  // One entry per directory handed to `collect`, in walk order and across every root. Kept as a
  // Set as well so a location declared *and* conventionally walked is reported once: the
  // operator reads this as "where to look", and a repeat there is noise, not information.
  const searched: string[] = []
  const searchedSeen = new Set<string>()
  const noteSearched = (absolute: string): void => {
    if (searchedSeen.has(absolute)) return
    searchedSeen.add(absolute)
    searched.push(absolute)
  }

  // Pass one: the operator's own additions, in the order they were added. Each is walked as
  // itself — the top of the tree they pointed at is where the documents are, so descending
  // `project` beneath it would look past the very files they meant. Its rows number their
  // `rootIndex` past the project's own roots, which is what keeps an added directory's
  // `specs/spec.md` distinguishable from the primary root's.
  for (const [ordinal, absolute] of added.entries()) {
    if (out.length >= MAX_CANDIDATES) break
    noteSearched(absolute)
    await collect({
      tier: TIER_ADDED,
      root: absolute,
      rootIndex: project.roots.length + ordinal,
      group: ordinal,
      absolute,
      label: basename(absolute),
      partitionFor: partitionOf,
      out,
      seen,
    })
  }

  // Pass two: the directories this process keeps specifications in, every root's before the next
  // root's, and within one root in the order they are named — `project`, then the documentation
  // tree's own.
  for (const [rootIndex, root] of project.roots.entries()) {
    if (out.length >= MAX_CANDIDATES) break
    for (const [index, start] of DOCUMENT_ROOTS.entries()) {
      if (out.length >= MAX_CANDIDATES) break
      const absolute = join(root, ...start.split('/'))
      noteSearched(absolute)
      await collect({
        tier: TIER_DOCUMENTS,
        root,
        rootIndex,
        group: index,
        absolute,
        label: start,
        partitionFor: partitionOf,
        out,
        seen,
      })
    }
  }
  return {
    documents: out
      .sort(compareCandidates)
      .slice(0, MAX_CANDIDATES)
      .map(entry => entry.view),
    searched,
    // The walk stops the moment the accumulator fills, so a full listing is the only shape a
    // shortened one can take. Reporting it lets a client say "showing the first N" rather than
    // implying the list is everything the project holds.
    truncated: out.length >= MAX_CANDIDATES,
  }
}

/**
 * Enumerate candidate specification documents for one project, without the search report.
 *
 * The wizard reads {@link readDocumentListing} because an empty candidate list alone does not
 * say which directory was wrong. This is the narrower projection for a caller that only
 * renders rows.
 * @param registry - the workspace registry to resolve the project through.
 * @param workspaceId - the project whose documents to list.
 * @param extraDirectories - absolute directories the operator added to the search; see
 *   {@link readDocumentListing}.
 * @returns the candidates; empty when the project is unknown and nothing was added.
 */
export async function readDocumentCandidates(
  registry: WorkspaceRegistryFace | undefined,
  workspaceId: string,
  extraDirectories: readonly string[] = [],
): Promise<YxspecDocumentView[]> {
  return (await readDocumentListing(registry, workspaceId, extraDirectories)).documents
}

/**
 * Walk one enumerated root and append the specifications it holds. Depth-first with an explicit
 * stack rather than recursion, so a deep tree cannot overflow the call stack.
 * @param input - the source tier, the base the row's display path is relative to, the row's
 *   root index, the ordering group, the absolute directory to walk, its label, the partition
 *   rule for its rows, and accumulators.
 */
async function collect(input: {
  readonly tier: number
  readonly root: string
  readonly rootIndex: number
  readonly group: number
  readonly absolute: string
  readonly label: string
  readonly partitionFor: (label: string) => string | undefined
  readonly out: Ranked[]
  readonly seen: Set<string>
}): Promise<void> {
  const stack: { readonly path: string; readonly label: string; readonly depth: number }[] =
    [{ path: input.absolute, label: input.label, depth: 0 }]
  while (stack.length > 0) {
    if (input.out.length >= MAX_CANDIDATES) return
    // The length guard proves a frame exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current.path, { withFileTypes: true })
    } catch {
      // Absent or unreadable: a project that never received its specification, or a permission the
      // host does not hold. Neither is an error for a picker.
      continue
    }
    for (const entry of entries) {
      if (input.out.length >= MAX_CANDIDATES) return
      const child = join(current.path, entry.name)
      const childLabel = `${current.label}/${entry.name}`
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) {
          stack.push({ path: child, label: childLabel, depth: current.depth + 1 })
        }
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0 || !DOCUMENT_EXTENSIONS.has(entry.name.slice(dot).toLowerCase())) continue
      const size = await sizeOf(child)
      if (size === undefined) continue
      if (input.seen.has(child)) continue
      input.seen.add(child)
      const partition = input.partitionFor(current.label)
      input.out.push({
        tier: input.tier,
        group: input.group,
        view: {
          path: toPosix(relative(input.root, child)),
          title: entry.name.slice(0, dot),
          ...partition === undefined ? {} : { partition },
          size,
          rootIndex: input.rootIndex,
        },
      })
    }
  }
}

/**
 * The project-relative partition label for one walked source directory.
 * @param label - the walked directory's label; for a document root this is its project-relative
 *   start, for an added one the directory's own basename.
 * @returns the first segment below the walked root, or undefined at the root itself.
 */
function partitionOf(label: string): string | undefined {
  const segments = label.split('/')
  return segments.length > 1 ? segments[1] : undefined
}

/**
 * Stat one file, tolerating a race with deletion.
 * @param path - absolute path to stat.
 * @returns the size in bytes, or undefined when it is not a file or has vanished.
 */
async function sizeOf(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path)
    // A dangling symlink reports as neither a file nor a directory: a picker can offer nothing
    // for it.
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * Normalize a path to POSIX separators for the wire.
 * @param path - the platform path.
 * @returns the same path with forward slashes.
 */
function toPosix(path: string): string {
  return path.split(sep).join('/')
}
