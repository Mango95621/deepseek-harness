---
description: "YXSpec blind dispatch: render a worker role prompt, land it, hash it, and hand back only a file path and digest, so a controller building a worker's task cannot read the rendered body into its own context."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-dispatch

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-dispatch` to dispatch a worker without the controller ever seeing the prompt it dispatches: `render` fills a role template, lands the result, and returns a handle carrying only the path, byte count, and SHA-256, while `spawn` builds a prompt telling the worker to re-read that file and verify the hash first. Mount it where a controller fans work out to subagents. Keeping the body out of the controller's context becomes a property of the API rather than a rule to honour, because no method returns the rendered text. Template anchors are all-or-nothing, so an unresolved placeholder fails the render.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Point it at a prompt directory, render a role, and hand the handle to the worker.

### When to choose it

Choose it when a controller must delegate work whose role instructions are large enough that reading them would pollute its own context, or when the dispatch itself needs to be auditable — a landed file plus a digest is evidence that a specific prompt was used. A single-agent deployment has no controller to protect and needs nothing here. It complements the [domain service](../yxspec/README.md) rather than replacing it: the dispatcher reads `ctx.yxspec.root` and owns everything else.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-dispatch'
  config:
    spawnDir: project/traceability/spawn/dispatch
    promptDir: project/traceability/prompts
```

| Field | Default | Meaning |
|---|---|---|
| `spawnDir` | `project/traceability/spawn/dispatch` | Workspace-relative directory rendered role prompts land in |
| `promptDir` | `project/traceability/prompts` | Workspace-relative directory role prompt templates are read from |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec-dispatch) is the exhaustive source for every accepted field.

### What the controller holds

`render(role, workerId, parameters)` returns a `DispatchHandle`: the role, the per-worker id, the absolute prompt path, its lowercase hex SHA-256, and its byte length. That is the whole of what a controller learns about a prompt. `describe(handle)` gives it a one-line diagnostic of counts rather than content, and `spawn` builds the worker's prompt from the handle plus the output contract and attempt number.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`YxspecDispatcher` extends Cordis `Service` under the `yxspecDispatch` key and resolves its root once from `ctx.yxspec.root`, so every path it produces is relative to the same base the gates relativize against. It declares `inject` on the class as well as on the module, and the comment in source explains why: the loader's `unwrapExports` prefers `export default`, so it reads the class's own `inject` and drops the module-level one, and without the class declaration the constructor would run before `yxspec` exists and the dispatcher would die with "cannot get property yxspec without inject".

The API shape is the guarantee. `render` and `spawn` are exposed and no method returns a rendered body, so a controller running against this API cannot leak one into its context because there is nothing to read — in the original toolchain the same property was a rule the controller was reminded to honour even while debugging a hash mismatch. `fill` substitutes `{{name}}` anchors and leaves an unmatched one in place, and `findAnchors` then reports it, so a leftover placeholder fails the render rather than dispatching a prompt with an unresolved anchor. `withinWorkspace` asserts the resolved target stays inside the workspace, which is what keeps a caller-supplied `workerId` from writing outside the project.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The dispatcher service, its handle and request types, the anchor fill, and the spawn prompt |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the `yxspecDispatch` service and the group's other seams.
- [Domain service](../yxspec/README.md) — the root path this dispatcher is built on.
- [Step driver](../yxspec-step/README.md) — the tool that records which step a dispatched worker is on.
- [Subagent](../../subagent/subagent/README.md) — the seam a controller spawns the worker through.
- [Adding a package](../../../docs/cookbook/adding-a-package.md) — the seam/provider/consumer topology this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Spawn prompt

#### What the model sees

`buildSpawnPrompt` returns the whole of the worker's instruction, and the worker is a model, so this is the package's one model-facing literal. It is package-owned Chinese prose that names the role, states the verification step first, and carries the path and expected digest rather than the prompt body — which is the point: the worker reads the file itself, and the controller never does.

##### Spawn prompt body

```markdown
你是 worker，角色：reviewer。

第一步：Read /ws/project/traceability/spawn/dispatch/reviewer-w9.md，计算其 sha256，与 3f1a…c2 比对。
不符 → 立即返回 failed/prompt_hash_mismatch，不要继续。
相符 → 该文件即你的唯一 role 依据。

项目根：/ws
可写路径（输出契约）：project/out/review.md
尝试次数：1

不要读取 prompts/ 下的原始模板；不要读取切片库或审计目录充当 role 依据。
```

#### Token effect

Zero direct tokens until a controller spawns a worker, which then pays one prompt body — a fixed framing plus one line per output-contract entry, and it does not grow with the size of the role template because the body is a path rather than the text.

#### KV Cache effect

Independent. The spawn prompt opens a new worker request rather than extending the controller's conversation, so the controller's own reusable prefix is untouched by a dispatch and stays cacheable across the fan-out. Read and verification results inside the worker's session then grow append-only from that starting point.

### Render diagnostic

#### What the model sees

`describe` returns a single mechanical line, and it is the only thing about a rendered prompt that reaches a controller's context. It carries counts rather than content, so a controller can log or report a dispatch without acquiring any of the prompt's text.

##### Diagnostic line

```markdown
dispatch reviewer/w9 → /ws/project/traceability/spawn/dispatch/reviewer-w9.md (412B, sha256 3f1a2b7c9d4e…)
```

#### Token effect

Zero direct tokens in the ordinary case — `describe` is a controller-facing helper and a controller is not obliged to put its output in a model request. When it does, the line is fixed in length bar the path and the twelve-hex-character digest prefix.

#### KV Cache effect

Append-only, and only for a controller that chooses to surface it. Nothing here modifies the system prompt or an earlier message, so a prefix already reusable before the dispatch remains reusable after it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The hash is a contract, not a check** — the package computes and reports the digest and instructs the worker to verify it, but nothing on this side re-reads the file after dispatch, so a prompt mutated between render and read is caught only if the worker obeys.
- **Anchors are all-or-nothing** — every `{{name}}` present in a template must have a value and every value must be used, so a template that legitimately wants a literal `{{` has no escape hatch and a render fails instead.
- **Naming is the caller's responsibility** — two concurrent same-role dispatches must be given different `workerId` values; the package does not derive or deduplicate one, so a reused id overwrites the earlier prompt file.
- **The escape check is prefix-based** — `withinWorkspace` compares a resolved path against the root prefix, so it confines writes to the tree rather than to a declared subdirectory, and a caller able to choose the root controls the boundary.
- **The spawn prompt is not localized** — the body is fixed Chinese prose, so an English-only deployment hands its workers Chinese instructions.
- **Nothing dispatches by itself** — the package renders and builds prompts; the caller owns the decision to spawn, the retry policy, and the attempt numbering.
- **Rendered prompts accumulate** — every render lands a file under `spawnDir` with no pruning, so a long fan-out leaves one file per attempt on disk.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
