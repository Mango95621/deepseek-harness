---
description: "Host-level interception for the YXSpec step gates: deny a tool call that would rewrite a frozen artifact or that runs while the active step's declared inputs are missing."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-gate

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-gate` to make the ASPICE step gates real: a write to a frozen ❄ artifact is denied, and any tool call made while the active step's declared inputs are absent is denied with the missing paths named. Mount it beside the domain service and the ledger in any gated deployment. The rules run as a `tools/pre-execute` hook, so they catch every model tool call rather than asking each step cell to check itself, and there is no path around them. An optional deterministic gate script can run in addition, routed on its exit code.

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

Register the hook; every model tool call then passes through the two structural checks.

### When to choose it

Choose it for any deployment that runs a gated YXSpec flow and wants the gates enforced rather than documented. It is the consumer that turns the stage model into interception, so leaving it out leaves each step cell's prose as the only rule. A workspace where Python is unavailable still gates correctly on artifact existence alone, because `runGateScripts` is off by default.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-gate'
  config:
    runGateScripts: true
```

| Field | Default | Meaning |
|---|---|---|
| `writeTools` | `write`, `edit`, `multi_edit`, `apply_patch`, `str_replace` | Tools whose calls may write files and therefore pass the frozen-artifact check |
| `runGateScripts` | `false` | Whether to execute a step's `gateScript` in addition to the structural checks |
| `gateTimeoutMs` | `30000` | Timeout for one gate-script invocation, in milliseconds |

A deployment with a custom writer adds its name to `writeTools`. `gateTimeoutMs` exists because a gate that cannot answer inside the budget is treated as a failure rather than a pass: the hook resolves exit code `124` when its timer fires.

### What the two checks do

The frozen-artifact check reads the call's target paths from `file_path`, `path`, `filePath`, and `target`, relativizes each against the workspace root, and denies the call when any lands on a path some frozen step declares as an input. The denial names the path and points at the change-request route, because rewriting a signed-off artifact in place is what a CR exists to prevent.

The input gate reads `ctx.yxspec.activeStep(agent)` for the calling agent and asks the ledger which of that step's `requiredInputs` are missing. A non-empty list denies the call and names the absent paths. When `runGateScripts` is on, the step's `gateScript` runs with the workspace root as its working directory and a non-zero exit code denies the call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin declares `inject = ['tools', 'yxspec', 'yxspecArtifacts']` and registers one `tools/pre-execute` listener in `apply`. It reads the workspace root once at registration, because the stage model it relativizes against is fixed for the plugin's lifetime.

The two array defaults are materialized in the schemastery `Config` rather than left to a `?? DEFAULT_WRITE_TOOLS` fallback at the read site. Schemastery resolves a bare `z.array(z.string())` to `[]`, which is truthy, so a read-site fallback would be unreachable and the frozen check would silently stop applying to every tool. Declaring the default in the schema keeps the resolved configuration honest and inspectable in the config catalog.

`frozenPaths` walks the whole stage model on each write call and returns the declared inputs of every frozen step. It is recomputed per call rather than cached because the stage model is read-only in practice but the cost is one pass over a small table, and a stale frozen set would be a silent security regression. `runGateScript` spawns the script with `stdio: 'ignore'` and resolves the exit code from `close`, mapping a spawn error to `127` and a timeout to `124`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The pre-execute hook, its target extraction, and the frozen-path and gate-script checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the gate's contract and the services it gates on.
- [Domain service](../yxspec/README.md) — the stage model and per-agent active step the hook reads.
- [Artifact ledger](../yxspec-artifact/README.md) — the landing check behind the input gate.
- [Freeze point](../yxspec-freeze/README.md) — the human-confirmation gate that runs after this one.
- [Tools subsystem](../../../docs/subsystems/tools.md) — the guarded execution pipeline the hook runs inside.

-----

<a id="model-experience"></a>
## Model Experience

### Tool-call denial

#### What the model sees

A denied call becomes the failed call's content, carrying this package's reason verbatim. Two reasons exist: a frozen-artifact denial names the relativized path and the change-request route, and an input-gate denial names the stage, the step, and every missing path. A gate-script denial names the script and its exit code. The denial follows the ordinary tool-call projection, so the model reads it exactly as it reads any other failed call.

##### Frozen-artifact denial

```markdown
产物已冻结：<path>。冻结点产物不得就地改写；请走变更请求（CR）流程。
```

##### Input-gate denial

```markdown
gate: 阶段 <stageId> 步骤 <stepId> 的输入缺失 → <missing paths, comma-separated>
```

#### Token effect

No cost while every call is allowed. A denial replaces the tool body's result with one short reason line, so it costs less than the call it prevented — but the model then retries, and each retry pays a full request.

#### KV Cache effect

Append-only; a denial is an ordinary tool result in the Session log and does not rewrite the reusable prefix. Denials that the model never sees because the turn ends are not added at all.

### Gate-script exit code

#### What the model sees

When `runGateScripts` is enabled and a step declares a `gateScript`, a non-zero exit denies the call with a reason naming the script and the code. The script's own output is discarded: it runs with `stdio: 'ignore'`, so nothing it prints reaches the model.

#### Token effect

One short reason line per failing script, in place of the tool body's result.

#### KV Cache effect

Append-only, like any other denial.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Target extraction is key-name based** — the frozen check reads `file_path`, `path`, `filePath`, and `target` from the call arguments, so a write tool using a different argument name is not checked unless its name is added to `writeTools` and its key exists in that list.
- **The frozen set is derived from step inputs** — a path is frozen when some frozen step declares it as a required input, so an artifact a ❄ step produces but no later step declares is not protected.
- **Gate scripts run untrusted commands** — a step's `gateScript` executes as a child process with the workspace root as its working directory, with no sandbox of its own. Enable `runGateScripts` only for a repository whose scripts are trusted, and keep `gateTimeoutMs` bounded.
- **A timed-out script is a denial** — the hook resolves `124` when the timer fires rather than allowing the call, so a slow gate blocks the flow instead of silently passing it.
- **Paths outside the workspace are only normalized** — a target that resolves outside the workspace root is compared as written rather than rejected, so the check protects declared paths and does not confine writes.
- **The step gate needs an active step** — with no active step for the calling agent, the input gate and the gate script are both skipped, so a call made before the driver hands out a step is unconstrained.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
