# Agent Note: A remote build runs in the checkout the server already holds

Status: implemented

English | [中文](2026-11-24-remote-build-runs-in-place.zh.md)

## Problem

The remote build seam (`@deepseek-ai/dsh-yxspec-remote`) began as "the server is a build farm, never the system of record": a run archived the local project tree, streamed it into a per-project scratch directory under a declared base directory, ran the recipe in the extracted copy, and recorded the archive's SHA-256 as the run's input identity. That model is unusable on the projects this seam exists for. An automotive checkout is hundreds of gigabytes; archiving it, pushing it over SSH, and extracting it before every compile costs more than the compile, and the exclusions that made it survivable (`.git`, `out`, `build`) are exactly the directories a tree needs to be *incremental* — so each run paid full price for a tree that a developer's machine already had, and the build it produced started from cold output.

The operator's actual situation is the opposite of what the model assumed: the build machine already holds the checkout, kept in step by whatever sync or CI the team runs, and the missing capability is "run my declared commands over there, in that tree, and bring the results back".

## Decision

A declaration names directories on the server instead of a scratch root:

- `projectDirectory` (required, absolute) — the checkout a run executes in. A run `cd`s there and runs the recipe. The harness never creates, replaces, or deletes it, and a missing directory is a failed run with the path named rather than a directory the seam makes: an empty directory it created would be a build that compiled nothing.
- `outputDirectory` (optional, absolute, **per recipe**) — where that recipe's products land, resolved to `<projectDirectory>/out` per run when the recipe omits it. It belongs to the recipe and not to the server because a whole build and a module build of one tree write their products to different places: an Android tree sends a full build to its `out/` root while a single-module build writes into that module's own output, so one directory per machine could only ever describe one of them. The recipe receives it as a `{out}` token, because redirecting products (`OUT_DIR_COMMON_BASE`, an `--output` flag) is the build system's decision and the seam's job is only to name the place; a fetch resolves its paths against the directory of the recipe that ran.
- `captureRevision` (optional, off by default) — read the server-side source revision before each run (`repo manifest -r` when the tree carries a `.repo`, else `git rev-parse HEAD`) and record it as the run's input identity, verbatim when it is one short line and always as a SHA-256 of the full output. It is opt-in because a `repo` manifest walks every project of the tree, and a flow whose own scripts already record traceability would pay for a second answer to the same question. A failed read never fails the build: `revisionError` says why, and the exit code stands as the build's verdict.

Between the revision read and the recipe, a run fetches whatever the caller names: `fetch` is a list of paths relative to the output directory and `fetchInto` is the local directory they land in, under a per-run subdirectory. The service refuses an absolute path, a `~`, and any `..` segment before the transfer starts, so returning products cannot become a way to read arbitrary files off the build machine, and it refuses `fetch` without `fetchInto` rather than inventing a destination. The archive streams to disk under `fetchMaxBytes` and the transfer is aborted while it runs, because naming a whole product tree by accident is one keystroke away. A transfer that fails is reported per requested path, never as an exception: the build already happened, and its exit code is a separate fact from whether the products arrived.

Config shrank with the model: `excludes` and `pushSource` are gone, `tarExecutable` now names the tool used to *expand* a fetched archive, and `fetchMaxBytes` (512 MiB) is the one new knob. The service no longer injects `workspaceRegistry`, because it reads no local project at all, and `paths.ts` was deleted with `projectSlug`: nothing derives a server-side path from a project title any more.

The durable record moved with it. `remoteServerRecord` replaces `baseDirectory` with `projectDirectory` and adds `captureRevision`, and its recipe map now holds `{ command, outputDirectory? }` rather than a bare command string; `remoteRunRecord` replaces the uploaded `treeDigest` with `revision`/`revisionDigest`/`revisionError` and now stores the command line and both directories. The domain went to `version: 2` with no `compatibleVersions`: the two shapes share no field that means the same thing, so a version 1 row is refused rather than read as version 2, and an operator who re-declares is better served than one whose server silently starts building in a directory the harness used to fill.

## Alternatives considered

**Keep the upload for small trees and add in-place as a second mode.** Two models in one seam, chosen per declaration: the tools, the durable record, the wizard form, and every doc would carry both, and the AOSP case would be the one the shipped copy is not. The upload side existed to make the *input* provable (an archive digest); in-place replaces that with a revision, which is the same fact for a tree that is already there. Keeping both would keep the weaker mechanism for a case — a tree that lives only on the developer's machine — that the seam's own judgement says is not worth copying.

**Sync the tree incrementally instead of copying it whole.** `rsync`-style delta transfer would make the upload affordable for a large tree. It also makes the server-side tree a *derived* copy the harness owns and must reconcile, which is the ownership this seam deliberately avoids: with an operator-owned tree, a run cannot corrupt the thing the developer is working on, and nobody has to decide what happens when the delta is interrupted.

**Run the build over the share the workspace already mounts.** The baseline checkout is reachable from the developer's machine as an SMB share, so a build could run against that path with no SSH at all. It needs the mounted filesystem to be a build-capable machine (it is not — the toolchain is on the Linux host), and it would tie the seam to one deployment's mount layout.

**Record the revision automatically and always.** Unconditional capture would make every run's record comparable without anyone opting in. It costs a walk of a `repo`-managed tree before every run, and it duplicates traceability that some projects already emit from their own scripts; the flag is the operator's call, and `revisionError` keeps a failed read visible rather than silent.

**Stage products back through the shared filesystem instead of a fetch.** A deployment whose build machine exports a mount could drop products there. That assumes the mount exists and is writable from the build user, and it makes "what came back" invisible to the run's record; a fetch names its paths, bounds its size, and reports what arrived.

## Consequences

- **There is no archive digest any more.** The input identity is the source revision, and only when the declaration asks for it. A project that needs a provable input and does not want `captureRevision` has to emit its own revision evidence from the recipe.
- **Tree freshness is the deployment's problem.** A run compiles whatever is at `projectDirectory`; nothing tells the operator it is stale. A stale tree compiles stale source, and the recorded revision is what makes that visible after the fact rather than before.
- **The build machine must hold the tree, and keeping it there is outside this seam.** That is a real precondition on any deployment adopting it, and it is why the README's "when to choose it" now says so rather than describing an upload.
- **Products come back only when asked for, by name.** The seam lists nothing on its own, so discovering a product name belongs to the recipe or the build log. A caller that wants an inventory has to know it or read it out of the log.
- **The ledger carries more of the run than before** — the command line and both directories are stored — because with no archive digest the record's value is in what it says about *what ran where*, not only about which input it ran against.
- **The wizard's server form declares the new fields** — the project directory, one output directory per recipe row, and the revision flag — so a declaration made from the browser and one made by an agent carry the same shape, through the same service method.
