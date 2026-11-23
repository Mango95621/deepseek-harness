---
description: "The YXSpec step driver: two tools that report each stage's progress and advance the flow by exactly one step, refusing to move while the leaving step's declared outputs are missing."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-step

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-step` to move an ASPICE flow one step at a time without trusting the agent's word that it finished: `yxspec_status` reports where every stage stands, and `yxspec_next` returns the current step's contract and advances the cursor. Mount it beside the domain service and the ledger in any gated deployment. The advance is decided by disk state rather than by self-report, so a step whose declared outputs never landed is refused with the missing paths named. `yxspec_next` stays the only sanctioned way to move the flow forward, and a frozen ❄ step comes back marked.

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

Register the two tools; the agent then walks the flow through them and nothing else.

### When to choose it

Choose it for any deployment where an agent is expected to follow the stage model itself, because it is the seam that hands out what to do next. A deployment that only enforces the gates without driving the agent can omit it, but then no step contract is ever rendered and the flow has no cursor. Its default behaviour needs no configuration; set `defaultStage` only when a call omitting `stage` should start somewhere other than the first declared stage.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-step'
  config:
    defaultStage: SWE.1
```

| Field | Default | Meaning |
|---|---|---|
| `defaultStage` | first declared stage | The stage the driver starts on when a call omits one |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec-step) is the exhaustive source for every accepted field.

### Where the step contract comes from

`yxspec_next` renders the contract from the deployment's own stage model and the skill cells under `.agents/skills/yxspec-<stage>/steps`, and the same call records the step as the calling agent's active one. That write is what the [stage gate](../yxspec-gate/README.md) and the [freeze point](../yxspec-freeze/README.md) read on the next tool call, which is why advancing through this package is what arms the gates.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin declares `inject = ['tools', 'yxspec', 'yxspecArtifacts']` and registers two tools. `yxspec_status` is read-only: it walks `ctx.yxspec.stages()` and asks `ctx.yxspec.status(stage.id, p => ctx.yxspecArtifacts.landed(p))` for each, so progress is derived from the filesystem rather than from any prior claim, then reports the identity, the root, and one row per stage.

`yxspec_next` resolves a target step — the explicit `step` argument when given, otherwise the successor of the current one — and then applies the advance gate. `stepOutputs(step)` returns `step.requiredInputs` rather than a separate output list, so a step's outputs are the artifacts the next step lists as its inputs and there is one source of truth; a terminal step has no successors and therefore no gate to satisfy. The leaving step's outputs are checked through `ctx.yxspecArtifacts.missingOf`, and a non-empty result refuses the advance and names every absent path instead of accepting the agent's word. The resulting contract is rendered from the stage and step records with the cell directory, and the target is recorded as the calling agent's active step when the execution carries one — per-agent rather than global, so a fan-out workflow's workers do not gate on each other's progress.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The two tools, the step-output rule, and the contract renderer |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the stage model these tools walk and the `yxspec/artifact-write` event they observe.
- [Domain service](../yxspec/README.md) — the stage model and per-agent active step this driver writes.
- [Artifact ledger](../yxspec-artifact/README.md) — the landing check behind every advance decision.
- [Stage gate](../yxspec-gate/README.md) — the hook that reads the active step this driver records.
- [Freeze point](../yxspec-freeze/README.md) — the confirmation the `frozen` flag routes to a human.
- [Tools subsystem](../../../docs/subsystems/tools.md) — the registration and pipeline the two tools travel through.

-----

<a id="model-experience"></a>
## Model Experience

### Step contract

#### What the model sees

`yxspec_next` returns one contract per call, rendered from the deployment's stage model and returned as the tool result's text. The body is package-owned Chinese prose laid out as labelled lines, and the frozen marker is part of that literal rather than a separate notice; this is the only place the driver tells the model what a step consists of. The status report is a second, read-only shape: one JSON document naming the identity, the root, and one row per stage with `currentStep`, `complete`, and `stepCount`.

#### Token effect

Zero direct tokens until the first call. `yxspec_next` then adds one contract body — bounded by the number of declared inputs and the presence of a gate script — and `yxspec_status` adds one JSON row per stage. Nothing here is prepended to a request, so the cost is paid only by the turns that ask.

#### KV Cache effect

Append-only. Both results are ordinary additions to the Session log and do not rewrite the system prompt, the tool offering, or any earlier message, so provider cache reuse of the conversation so far survives. Re-reading status with the same arguments produces a new block rather than a modification of the previous one.

### Advance refusal

#### What the model sees

A refused advance is returned as an `ok: false` payload rather than as a tool error, so the model reads the reason as data it can act on. The refusal names the step being left and every missing path, which is the difference between "you may not advance" and "these two files are why". A step that turns out to be the last one in its stage is reported the same way, with `complete: true`.

##### Missing-outputs refusal

```markdown
{
  "ok": false,
  "stage": "SWE.1",
  "blockedAt": "SWE.1.2",
  "missing": ["project/inputs/requirements.md"],
  "error": "上一步 SWE.1.2 的产物未落盘，不得推进。"
}
```

#### Token effect

Zero direct tokens beyond the refusal payload itself, which is one short JSON document naming each missing path. The model then chooses between producing the artifacts and stopping, and either choice costs a further request.

#### KV Cache effect

Append-only, like any other tool result. A refusal adds a block and rewrites nothing earlier, so it does not itself invalidate a reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A step's outputs are its successor's inputs** — `stepOutputs` returns `requiredInputs`, so an artifact a step produces but no later step declares cannot be gated on, and a terminal step has no gate at all.
- **Existence is the whole advance criterion** — the ledger answers whether a path is a readable file, so a step whose output was created empty still passes its gate.
- **The gate on the leaving step is defence in depth** — `status()` only names a step whose own inputs have landed and `stepOutputs` is that same list, so the guard's `missing` list is empty by construction today; it stays because the two rules are stated in different places.
- **Active steps are in-memory only** — the recorded active step is not persisted, so a Host restart forgets the cursor and the next call re-derives it from disk.
- **The cell directory is fixed** — the contract renders `.agents/skills/yxspec-<stage>/steps` with no configuration, so a deployment that keeps its cells elsewhere gets a path that does not resolve.
- **The contract text is not localized** — the rendered body is fixed Chinese prose, so an English-only deployment shows the operator and the model Chinese text.
- **Jumping to an explicit step still uses the same gate** — passing `step` skips ahead but does not bypass the check, so a jump cannot be used to escape a blocked predecessor.
- **A stage id resolves once per call** — the target stage is looked up before any awaiting, so a stage model mutated mid-call would not be re-read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
