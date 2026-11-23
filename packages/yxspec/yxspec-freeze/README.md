---
description: "Routes the ASPICE ❄ human-signoff steps through ctx.approval so an unattended YXSpec flow fails closed instead of signing itself off."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-freeze

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-freeze` to make a ❄ freeze point mean what the flow says it means: a tool call belonging to a frozen step does not run until a human grants it through `ctx.approval`. Mount it beside the domain service in any gated deployment. The failure mode is the point — a flow with nobody at the keyboard stops at the freeze point rather than signing itself off, because every outcome but `allowed-once` denies the call. It runs after the structural gate, so a call that already fails on missing inputs is denied before the user is ever asked.

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

Register the hook; working a frozen step then requires a human grant.

### When to choose it

Choose it for any deployment that runs a gated YXSpec flow and must not let an unattended session approve its own frozen artifacts. Add it alongside the [stage gate](../yxspec-gate/README.md), which it deliberately runs behind. Set `enabled: false` to revert to the prose-only behaviour the original toolchain had, which is useful for a workspace whose frozen steps are not yet meaningful.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-freeze'
  config:
    enabled: true
```

| Field | Default | Meaning |
|---|---|---|
| `guardedTools` | `write`, `edit`, `multi_edit`, `apply_patch`, `str_replace`, `bash` | Tools that constitute working a frozen step and must therefore be confirmed |
| `enabled` | `true` | Whether the freeze hook is active; disabling it reverts to prose-only enforcement |

The default set includes `bash` alongside the writing family, because a frozen step's sign-off covers both the artifact it produces and the commands that produce it. A deployment whose steps freeze only written artifacts narrows the list.

### Why the outcome is not a boolean

`ctx.approval.request()` settles one of four outcomes, and only `allowed-once` lets the call proceed. `unavailable` means no answerer owned the request — the unattended case — and it denies exactly like `rejected` and `cancelled` do. Collapsing `unavailable` into an allow would make the gate silently disappear on precisely the deployment that needs it, so the hook denies on everything but the one-shot grant and names the outcome in the reason.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin declares `inject = ['tools', 'yxspec', 'approval']` and registers a second `tools/pre-execute` listener. Listener order is what puts it behind the [stage gate](../yxspec-gate/README.md): that plugin's structural checks run first, so a call failing on missing inputs is denied without troubling the user. The hook returns `next()` for every call that is not a guarded tool, that has no agent, or whose active step is not frozen, which keeps the ordinary path free of approval traffic.

`guardedTools` is defaulted in the schemastery `Config` rather than at the read site for the same reason the stage gate defaults its write list there: a bare `z.array(z.string())` resolves to `[]`, which would make a read-site fallback unreachable and silently exempt every tool from confirmation. `enabled` is checked before the listener is registered at all, so a disabled freeze point costs nothing per call.

The request carries the agent, the tool name, the call id, a Chinese reason naming the stage and step, and the call's own abort signal — so a cancelled call cancels its pending confirmation rather than leaving it to be answered after the fact.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The pre-execute hook, its guarded-tool set, and the approval request and denial |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the freeze point's contract and the services it reads.
- [Approval subsystem](../../../docs/subsystems/approval.md) — the one-shot grant seam, its answerer contract, and the `unavailable` outcome.
- [Domain service](../yxspec/README.md) — the frozen flag and per-agent active step the hook reads.
- [Stage gate](../yxspec-gate/README.md) — the structural hook that runs before this one.
- [Step driver](../yxspec-step/README.md) — the tool that hands out a step and can mark it frozen.

-----

<a id="model-experience"></a>
## Model Experience

### Freeze-point denial

#### What the model sees

A frozen-step call whose confirmation is not granted becomes the failed call's content. The reason names the outcome and the stage and step, so the model can tell a human refusal from an absent approval channel. The confirmation prompt itself is shown to the human, not the model.

##### Freeze not confirmed

```markdown
冻结点未获人工确认（<outcome>）：<stageId>/<stepId>
```

#### Token effect

No cost while no frozen step is active, or while a human grants each call. A denial replaces the tool body's result with one short reason line.

#### KV Cache effect

Append-only; a denial is an ordinary tool result in the Session log and does not rewrite the reusable prefix.

### Confirmation prompt

#### What the model sees

Nothing directly. The reason is carried on the `ApprovalRequest` the human reads, so it shapes what the user is asked rather than what the model is told. Under an `ask` policy the tools pipeline may additionally render its own approval prompt, which is that seam's text rather than this package's.

##### Confirmation reason

```markdown
❄ 冻结点：阶段 <stageId> 步骤 <stepId>（<stepTitle>）需主会话人工确认后方可继续。
```

#### Token effect

One short prompt string per guarded call on a frozen step, paid only on the human-facing approval channel. A call that a human grants adds no model-visible tokens.

#### KV Cache effect

No model request carries this text, so an already-reusable prefix is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The guarded set is a name list** — a custom write tool that is not named in `guardedTools` works a frozen step without confirmation, so a deployment adding a writer must extend the list in the same change.
- **Only the active step's frozen flag is read** — the hook asks `ctx.yxspec.activeStep(agent)` whether the current step is frozen, so a call made before the driver hands out a step is unguarded even when the next step is a freeze point.
- **Every guarded call is asked separately** — there is no per-step or per-turn memoization, so producing a frozen artifact through several edits asks the human once per call. Approval is a one-shot grant by design and is never reused.
- **A missing approval seam denies** — a composition with no answerer settles `unavailable` and the hook denies, which is intended for unattended runs and is worth knowing when a deployment mounts the flow without any approval channel.
- **The prompt text is not localized** — the confirmation reason is a fixed Chinese string, so an English-only deployment shows the operator Chinese text.
- **Disabling skips registration entirely** — `enabled: false` registers no listener, so the hook leaves no trace of having been configured and a later re-enable takes effect only on the next load.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
