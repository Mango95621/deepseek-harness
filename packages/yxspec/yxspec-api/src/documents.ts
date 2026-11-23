/**
 * Candidate specification documents for the onboarding wizard's first step.
 *
 * The wizard asks the operator to pick the ASPICE specification a project will be run
 * against. Three sources answer where those documents live, in that order:
 *
 * 1. **The project's own declaration.** `project/config/yxspec.json` names the directories and
 *    the single files its process runs against (`sqt.paths.prd`, `sqt.paths.sqt_tp`, and so
 *    on). A project that states this is authoritative about itself, so its entries are
 *    offered first — and in the order the config lists them, which is what keeps `prd` ahead
 *    of a directory holding hundreds of cases.
 * 2. **The operator's own additions.** Directories the operator attached to the project from
 *    the wizard's specification step, passed in as {@link readDocumentListing}'s
 *    `extraDirectories`. A specification tree often lives beside the repositories rather than
 *    inside one — a shared document folder, a delivered package, a process-input archive — and
 *    nothing in the project's own layout names it. An explicit instruction outranks a guess at
 *    where documents usually live, and it cannot outrank the project's statement about itself.
 * 3. **The deployment convention.** `project/inputs`, `project/design`, `specs`, and `docs`
 *    are walked afterwards, so a project without a readable config still offers something.
 *
 * An added directory is walked as itself rather than by convention. The operator points at a
 * tree that holds the documents, so descending `project/inputs` beneath it would look past the
 * very files they meant; the walk therefore enters it directly, under the same depth and count
 * bounds. Rows from it carry their path relative to that directory and an index continuing past
 * the project's roots, so the same relative path from two sources stays two distinguishable
 * rows — and a file already reachable through a root is offered once, because deletion at the
 * row level is decided by the file's absolute path rather than by how the walk arrived at it.
 *
 * Reading the declaration is what makes a project whose specification lives under
 * `project/specs/**` enumerable at all: the convention never named that tree, so those files
 * were invisible no matter how complete the project was. Worse, the ordinary convention
 * directories alone can fill the candidate ceiling, and the ordering then decided which
 * documents survived by path collation rather than by relevance — a specification sitting in
 * `project/specs/prd` lost its place to a design note sorting earlier.
 *
 * The walk is bounded twice on purpose. A project tree can be enormous — a vendored AOSP
 * checkout alone would swamp any listing — and a browser step that takes seconds to open is
 * worse than one that shows the first 200 candidates. Depth and file count are both capped,
 * and the caps are named constants rather than inline numbers so a deployment can see them.
 *
 * Every location the walk enters is reported back alongside the candidates. The list is what
 * the operator reads when it comes back empty, and "no document found" alone cannot tell them
 * whether the project has no inputs yet or they pointed the wizard at the wrong directory.
 * @module @deepseek-ai/dsh-yxspec-api/documents
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { YxspecDocumentListing, YxspecDocumentView } from './types.ts'

/** Extensions a candidate document may carry. */
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml'])

/**
 * Directories walked when the project declares none of its own, relative to each root.
 *
 * These are the convention this deployment follows, kept as the fallback rather than the
 * authority: a project that names its own locations is served by those instead.
 */
const FALLBACK_DOCUMENT_ROOTS = ['project/inputs', 'project/design', 'specs', 'docs'] as const

/** Where a project states its own process-artifact locations, relative to each root. */
const PROJECT_CONFIG_PATH = 'project/config/yxspec.json'

/**
 * The ordering group every convention directory shares.
 *
 * Above any entry index so the project's own declarations always come first, and a single
 * value rather than one per directory: the convention group is path-sorted as a whole, which
 * is the order this module produced before it read declarations at all.
 */
const FALLBACK_GROUP = Number.MAX_SAFE_INTEGER

/**
 * Which of the three sources a row came from, ordered the way the wizard must read them.
 *
 * A tier ahead of the group rather than a numeric band woven into it: the group is a position
 * *within* one source (a config index, an addition's ordinal), and merging the two into a
 * single scale would make a project declaring a thousand config entries sort above an
 * operator's own addition. Two axes keep the sources strictly ordered whatever their sizes.
 */
const TIER_DECLARED = 0
/** The operator's own additions: authoritative about intent, below the project's own word. */
const TIER_ADDED = 1
/** The deployment convention: what to offer when nobody said anything. */
const TIER_CONVENTION = 2

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

/**
 * One location a project declared, with the config's own ordering preserved.
 *
 * The kind is resolved while reading the config rather than guessed per row, so the two
 * shapes travel together: a later reader cannot mistake a named document for a tree.
 */
type DeclaredEntry =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'document'; readonly path: string }

/** A candidate plus the source and group it came from. */
interface Ranked {
  readonly view: YxspecDocumentView
  /**
   * Which of the three sources the row came from: a declared location, an operator-added
   * directory, or a convention directory.
   *
   * A separate axis from {@link group} because the two answer different questions. The tier is
   * *whose word* a row rests on, and it must decide the ordering regardless of how many rows
   * the source contributes — a project declaring a thousand config entries still may not push
   * an operator's own added directory below the deployment's guesses. The group is a position
   * *within* one source (a config index, an addition's ordinal), which only breaks ties inside
   * a tier.
   */
  readonly tier: number
  /**
   * Which declaration the row came from: its entry's index in the config, an addition's
   * ordinal, or a {@link FALLBACK_GROUP} offset for the convention directories.
   *
   * Ordering by this rather than by path is what preserves the project's own priority: the
   * config lists `prd` first and a directory of hundreds of cases later, and a path sort would
   * hand the candidate ceiling to whichever tree happened to collate earlier instead of to the
   * specification the project named first. Within one group the rows stay path-sorted, so a
   * directory's contents read the same way on every run.
   *
   * The group stays out of {@link YxspecDocumentView}: it is this module's ordering device,
   * not something a client renders.
   */
  readonly group: number
}

/**
 * Order the collected rows: the project's declarations, then the operator's additions, then the
 * convention directories; within each group, by root and path.
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
 * Every declared root is walked, not only the primary one. A project spans an IVI
 * application, MCU firmware, and often a vendored tree; the ASPICE specification can live in
 * whichever of them the team keeps its process inputs in, so limiting the search to
 * `roots[0]` would report "no specification" for a project that has one. Each candidate
 * carries the root it came from, so a wizard showing two files with the same relative path
 * can still tell them apart.
 *
 * A missing directory is not an error: a project before its first input import simply has
 * nothing to offer, and the wizard renders its empty state. Only enumerated directories are
 * read, so a project root full of unrelated files produces no candidates rather than a slow
 * scan.
 *
 * The result reports where the walk looked, not only what it found. An empty candidate list is
 * an ambiguous answer on its own — it reads the same whether the project has no inputs yet or
 * the operator selected the wrong directory — so the listing carries the absolute directories
 * that were enumerated, and whether the ceiling cut the candidates short. The caller needs
 * neither to render a populated list; both are what make an *empty* one actionable.
 *
 * The three sources are walked in separate passes rather than per root, so the candidate
 * ceiling is spent in priority order across the whole project: every root's declaration before
 * any addition, and every addition before any convention directory. A single pass per root
 * would let the first repository's guessed directory crowd out the second repository's own
 * declaration, which is the ordering this exists to prevent.
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
  // Keyed by the file's own absolute path: a declared document can sit inside a declared
  // directory (`sqt.paths.step_capability` under `sqt.paths.sqt_tp`), an added directory can
  // hold a root's file, and two additions can name the same tree — every one of those would
  // otherwise render as two identical rows the operator cannot tell apart. Two rows of one file
  // are the same file no matter which source reached it.
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

  // Pass one: what the project says about itself, every root's declaration before any guess.
  // Each declared entry becomes its own ordering group, numbered by its position in the
  // config: that position *is* the project's priority, so `prd` (the first key in the
  // shipped config) outranks the case directories that follow it instead of losing the
  // candidate ceiling to whichever path happened to collate earlier.
  for (const [rootIndex, root] of project.roots.entries()) {
    if (out.length >= MAX_CANDIDATES) break
    const declared = await readDeclaredEntries(root)
    for (const [index, entry] of declared.entries()) {
      if (out.length >= MAX_CANDIDATES) break
      if (entry.kind === 'directory') {
        const absolute = join(root, ...entry.path.split('/'))
        noteSearched(absolute)
        await collect({
          tier: TIER_DECLARED,
          root,
          rootIndex,
          group: index,
          absolute,
          label: entry.path,
          partitionFor: () => declaredPartition(entry.path),
          out,
          seen,
        })
      } else {
        await offer({ tier: TIER_DECLARED, root, rootIndex, group: index, relativePath: entry.path, out, seen })
      }
    }
  }

  // Pass two: the operator's own additions, in the order they were added. Each is walked as
  // itself — the top of the tree they pointed at is where the documents are, so descending
  // `project/inputs` beneath it would look past the very files they meant. Its rows number
  // their `rootIndex` past the project's own roots, which is what keeps an added directory's
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

  // Pass three: the deployment's conventions, which are what to offer when nobody said
  // anything — and therefore the first thing the ceiling may cut.
  for (const [rootIndex, root] of project.roots.entries()) {
    if (out.length >= MAX_CANDIDATES) break
    for (const start of FALLBACK_DOCUMENT_ROOTS) {
      if (out.length >= MAX_CANDIDATES) break
      const absolute = join(root, ...start.split('/'))
      noteSearched(absolute)
      await collect({
        tier: TIER_CONVENTION,
        root,
        rootIndex,
        group: FALLBACK_GROUP,
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
 * Read one root's `yxspec.json` and project out the locations it declares, in config order.
 *
 * Only `sqt.paths` string values are read, and only those whose shape says where they point.
 * The arrays and objects beside them stay out on purpose: `prd_globs` holds a pattern rather
 * than a location, `trace_bases` resolves inside another tool's working directory, and
 * `source_app` names subdirectories of a checkout this module is not told about — reading any
 * of them would invent candidates no row could be opened from. A missing or malformed file
 * yields nothing, which falls the caller back to the convention directories.
 * @param root - the project root to read from.
 * @returns the declared entries in the order the config lists them; empty when none.
 */
async function readDeclaredEntries(root: string): Promise<readonly DeclaredEntry[]> {
  let raw: string
  try {
    raw = await readFile(join(root, ...PROJECT_CONFIG_PATH.split('/')), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const paths = (parsed as { sqt?: { paths?: unknown } } | null)?.sqt?.paths
  if (typeof paths !== 'object' || paths === null) return []
  const out: DeclaredEntry[] = []
  for (const value of Object.values(paths)) {
    if (typeof value !== 'string' || value.length === 0) continue
    // `repo_root` names the checkout itself; walking it is the whole tree, and it is the base
    // the other declared paths resolve against rather than a place a document lives.
    if (value === '.') continue
    if (isDirectoryPath(value)) {
      out.push({ kind: 'directory', path: value })
      continue
    }
    // The extension filter runs here rather than at offer time, so a named document that is
    // not a document — a declared `icon.png` — never becomes an entry in the first place. It
    // also leaves `offer` with the guarantee that its path always has a dot to slice a title
    // at, which is what keeps that function free of an unreachable fallback.
    const last = lastSegment(value)
    const dot = last.lastIndexOf('.')
    if (!DOCUMENT_EXTENSIONS.has(last.slice(dot).toLowerCase())) continue
    out.push({ kind: 'document', path: value })
  }
  return out
}

/**
 * Whether a declared path names a directory rather than one document.
 *
 * The config carries no type field, so the shape has to answer. A trailing separator is
 * explicit; otherwise the last segment decides, and a segment without a dot is a directory in
 * every layout this repository uses (`project/specs/sqt-tp`, `project/inputs/raw/07_TH7台架库`)
 * while a declared document always carries an extension (`.md`, `.json`).
 * @param value - one declared path.
 * @returns whether the path is a directory.
 */
function isDirectoryPath(value: string): boolean {
  if (value.endsWith('/')) return true
  return !lastSegment(value).includes('.')
}

/**
 * The last segment of a slash-separated path.
 *
 * Slicing rather than `split('/').pop()`: a non-empty path always has a final segment, so the
 * array form would need an `undefined` fallback no input could ever reach.
 * @param value - the path to read.
 * @returns the segment after the last separator, or the whole string when there is none.
 */
function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1)
}

/**
 * Everything before the last segment of a slash-separated path.
 *
 * The complement of {@link lastSegment}, and spelled as a slice for the same reason: a
 * separator-less path has no directory, which is `''` rather than something to recover with a
 * fallback.
 * @param value - the path to read.
 * @returns the leading directories, or `''` when the path is a bare name.
 */
function stripLastSegment(value: string): string {
  return value.slice(0, Math.max(value.lastIndexOf('/'), 0))
}

/**
 * The partition a declared entry's documents belong to: the entry's own last segment.
 *
 * A declared document sits inside its declared directory in every case the shipped config
 * uses (`sqt_tp/step_capability.md`), so the subtree groups under the one name the project
 * chose rather than under a segment of the path above it — which for `project/specs/sqt-tp`
 * would be the uninformative `specs`. A document declared at the root itself has no directory
 * to name, and reads as having no partition, the same as a row sitting directly under a
 * walked root.
 * @param path - the declared directory, or the declared document's directory.
 * @returns the partition label, or undefined when there is no directory to name.
 */
function declaredPartition(path: string): string | undefined {
  const segments = path.split('/').filter(segment => segment.length > 0)
  return segments[segments.length - 1]
}

/**
 * Walk one enumerated root and append the documents it holds. Depth-first with an explicit
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
      // Absent or unreadable: a project that never imported inputs, or a permission the
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
 * Offer one document the project declared by path, when it exists and a picker can show it.
 *
 * A declaration is a claim, not a guarantee: a config naming a document the project never
 * created is ordinary in a tree mid-setup, and the row is then absent rather than an error.
 * Nothing is descended — the config named one document, so a directory carrying a document
 * extension is refused by the same stat that proves the file exists.
 *
 * The path already carries a document extension: `readDeclaredEntries` filters on it before
 * an entry is created, so the title always has a dot to slice at.
 * @param input - the source tier, the project root, the root's index, the declared path, and
 *   accumulators.
 */
async function offer(input: {
  readonly tier: number
  readonly root: string
  readonly rootIndex: number
  readonly group: number
  readonly relativePath: string
  readonly out: Ranked[]
  readonly seen: Set<string>
}): Promise<void> {
  const name = lastSegment(input.relativePath)
  const absolute = join(input.root, ...input.relativePath.split('/'))
  const size = await sizeOf(absolute)
  if (size === undefined) return
  // Reachable through the shipped config, which declares `sqt_tp` and `step_capability`
  // together: `collect` offers the file while walking the directory, and this call then finds
  // it already recorded. The row must not appear twice.
  if (input.seen.has(absolute)) return
  input.seen.add(absolute)
  const partition = declaredPartition(stripLastSegment(input.relativePath))
  input.out.push({
    tier: input.tier,
    group: input.group,
    view: {
      path: toPosix(input.relativePath),
      title: name.slice(0, name.lastIndexOf('.')),
      ...partition === undefined ? {} : { partition },
      size,
      rootIndex: input.rootIndex,
    },
  })
}

/**
 * The project-relative partition label for one walked source directory.
 * @param label - the walked directory's label; for a convention directory this is its
 *   project-relative start, for an added one the directory's own basename.
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
    // A declared path can name a directory whose last segment looks like a document, and a
    // dangling symlink reports as neither: a picker can offer neither of them.
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
