# The `yxspec.json` project declaration

English | [中文](yxspec-config.zh.md)

A project that runs the [YXSpec flow](../subsystems/yxspec.md) carries one `yxspec.json` at its root. The file answers two questions the host cannot answer from the tree alone: whether this project runs a gated process at all, and which specification it is. It is also the configuration source the shipped `yxspec-*` skills read.

This page records what the file is, who reads it, and which of its keys are live. It is a reference for the layout as observed in a deployed project; the [subsystem page](../subsystems/yxspec.md) owns the flow's contracts.

## The file is the switch, not a flag

Existence is the test. `declaresYxspecProcess()` in `@deepseek-ai/dsh-yxspec/project` resolves the file and reports whether it is there; there is no boolean config key that says the same thing.

Three consumers must agree on the answer, and they read the same bytes so they cannot disagree:

- **`@deepseek-ai/dsh-yxspec`** seeds the reported spec identity from the file, so the stage model and the identity describe the same tree.
- **`@deepseek-ai/dsh-yxspec-step`** hides `yxspec_status` and `yxspec_next` from sessions whose project does not declare the process, so an unrelated session never carries the schema.
- **`@deepseek-ai/dsh-yxspec-remote`** hides its three build-server tools the same way.

A file rather than a flag because the file is what the onboarding wizard and the skills actually read. A second declaration would be able to drift out of step with the tree it describes.

### Where it lives

`resolveProjectConfigPath(root)` consults two candidates in order and returns the first that exists:

| Order | Path | Status |
|---|---|---|
| 1 | `yxspec.json` | Current — the project root, beside the tree it describes |
| 2 | `project/config/yxspec.json` | Legacy — the location the file occupied before the move |

The root file wins when both are present, so migrating is adding a file rather than removing one. A deployment that only ever wrote the nested path keeps working.

An explicit `projectConfigPath` in the deployment config is honored verbatim: a deployment naming its own location is not asking for the fallback to be searched underneath it.

## Two consumer groups, one file

The host reads a small part of the file; the shipped skills read the rest. Conflating the two is the most common way to misread the file.

| Consumer | Reads | Why |
|---|---|---|
| Harness (TypeScript) | `spec_id`, `project_name`, `customer`, `product_type`, `sqt.paths` | Render the process panel; enumerate candidate specification documents for the wizard |
| `yxspec-*` skills (Python) | `spec_id`, `product_scope`, `init_file_kinds`, `clarify_partitions`, `anchor_template`, … | Drive the gated flow: artifact naming, scope filtering, clarification rules |

### What the harness reads

`readProjectIdentity()` projects four keys out of the file, in snake_case on disk and camelCase in code:

| Key | Type | Purpose | Missing |
|---|---|---|---|
| `spec_id` | string | The specification identifier the panel reports | `'unspecified'` |
| `project_name` | string | The project name | `'unspecified'` |
| `customer` | string | The customer name | `'unspecified'` |
| `product_type` | string | The product type | `'unspecified'` |

A missing or malformed file yields `undefined` rather than throwing: identity is reporting metadata, and a deployment without it still gates correctly on the stage model. An explicit `Config.identity` value wins over the file.

`readDeclaredEntries()` reads `sqt.paths` for the wizard's specification step. Only string values whose shape says where they point are read, and only those with a document extension (`.md .txt .json .yaml .yml`) surface as candidates. `repo_root` is skipped when its value is `'.'` — it names the checkout itself, which the other values resolve against rather than a place a document lives. Arrays and objects beside them stay out on purpose: `prd_globs` holds a pattern, `trace_bases` resolves inside another tool's working directory, and `source_app` names subdirectories of a checkout this module is not told about.

## Key inventory

The table below covers the file as observed in a deployed project: 19 top-level keys. An annotation of the same keys ships as `yxspec-template.json` next to a live project; seven keys in the instance are not in that template.

### Live at the harness boundary

| Key | Consumer | Notes |
|---|---|---|
| `schema` | — | Format marker, `yxspec-config/v1` |
| `spec_id` | 175 skill scripts | Artifact prefix and traceability-ID root; the hardest-worked key in the file |
| `naming_version` | 63 skill scripts | Path-naming convention, e.g. `lowercase-paths/v1` |
| `project_name` | 12 skill scripts | Also read by the panel |
| `customer` | 12 skill scripts | Also read by the panel |
| `product_type` | 13 skill scripts | Selects the function anchor template wholesale; see below |
| `sqt.paths` | harness + 74 references | Path declarations the wizard enumerates |

### Flow-wide configuration

| Key | Consumer | Notes |
|---|---|---|
| `product_scope` | 67 skill scripts | `product`, `in_scope`, `out_of_scope`, `note`; consumed by init brief rendering and PRD scope judgement |
| `clarify_partitions` | 3 skill scripts | `customer_partitions`, `audience_map`, `category_map`, `category_rules`, `blocking_keywords`; a missing section falls back to a packaged default |
| `init_file_kinds` | 2 skill scripts | `native` / `convert` / `attachment` extensions; the scan merges them with its own set rather than replacing it |
| `anchor_template` | 4 scripts (migration tooling) | See the section below — its mechanism is not what the template annotation says |

### Keys with no observed consumer

These are inert in the deployment examined: no script reads them, and the harness does not either. They parse without error, so leaving them in place is harmless — but filling them in does not make anything happen.

| Key | Template annotation claims | Observed |
|---|---|---|
| `init_buckets.{max_files,max_kb,partition_depth}` | ACQ.4 bucket sizing | Only command-line flags exist (`--max-files`); no config read |
| `init_concurrency` | ACQ.4 parse concurrency | No config read |
| `workspace_layout.{baseline_root,sw_arch_docs_dir}` | SWE.2 baseline location | No config read |
| `node_identity` | — | Instance-only key; no reader in this tree |
| `residue_tokens` | Migration carry-over | Read only by the product-migration tooling |

### The `sqt` section

`sqt` holds the SQT-stage constants: path declarations, ID patterns, dimension thresholds, keyword tables, and artifact naming. Its `schema` marker is `sqt-config/v1`.

In the deployment examined the section's own constants have no reader in the tree — searching for the marker value `sqt-config/v1` and for distinguishing values such as `protocol-source-first` returns nothing. Six of the 18 readable path values do not resolve on disk either. Treat the section as configuration for a toolchain that lives outside this checkout.

The one exception is the harness, which walks `sqt.paths` for wizard candidates; that is the only `sqt` reading this repository performs.

## `anchor_template`: the annotation is stale

The template annotation for `anchor_template` describes a resolution chain — `prd.anchor_template` falling back to the top-level key, with `rc=1 ANCHOR_TEMPLATE_UNSET` when unset — and states that `product_type` is always read from the template YAML. Both statements describe the migration tooling, not the flow.

The reading that matters is in `yxspec-sys-arch`. **SYS.3 does not read the key at all.** It globs for a file:

```
--anchor-dir project/config/anchor-templates --anchor-dir project/traceability/mounts/templates
--anchor-prefix ""
```

The first directory containing a `*-anchor-template.yaml` wins; within a directory, a hit prefixed by `anchor_prefix` wins over the lexical first. When no directory yields a hit, the worker reports a missing anchor template and blocks dispatch.

So the key's real effect depends on which toolchain runs:

| Running | What to do |
|---|---|
| The flow (`yxspec-sys-arch`, PRD) | Nothing — place `*-anchor-template.yaml` under `project/config/anchor-templates/` and SYS.3 discovers it |
| The init pre-check | Point the key at a file that exists, e.g. `project/config/anchor-templates/ivi-function-anchor-template.yaml` |
| The migration tooling | Required — omitting it yields `rc=1 ANCHOR_TEMPLATE_UNSET` |

Value handling, in `resolve_anchor_template()`:

```
bare filename (no separator)  → join with anchor_template_dir (default project/config/anchor-templates)
relative path                 → resolve against the workspace root
absolute path                 → used as-is
```

`anchor_template_dir` is what makes a bare filename resolvable; it is otherwise unused.

### `product_type` moved out

The annotation says `product_type` is read from the anchor template YAML and that `yxspec.json` does not set the key. That has since changed: the derived-key table in `config_gen.py` is now empty, with a comment recording that `product_type` and `form_factor` were moved out because they are PRD-specific while `yxspec.json` is a flow-wide declaration. The current source is `config.base.yaml` plus a project override.

## Verification status

The harness-side reading path — `resolveProjectConfigPath`, identity seeding, and `sqt.paths` enumeration — is covered by 235 unit tests across four `yxspec` packages, and passes both `pnpm run build:check` and `pnpm run typecheck`. The claims about the Python-side consumers above come from reading the shipped scripts; they are not covered by tests in this repository, which does not vendor those scripts.
