---
description: "The YXSpec capability seam: the ASPICE stage model, dual-track (MCU/MPU) domain map, and spec identity that the host-enforced process gates read."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec` as the one place a YXSpec flow's shape is declared: the ASPICE stages, the steps inside each, the artifacts a step must have before it runs, and the frozen ❄ points that need a human. It also owns spec identity and the dual-track (MCU/MPU) domain map. Mount it in any deployment that runs the gated flow; the gate, freeze, step-driver, and ledger packages all inject `ctx.yxspec`, and the browser panel reads the same model. The service enforces nothing by itself — it answers queries. Per-agent step ownership keeps a fan-out workflow's workers from gating on each other's progress.

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

Mount the service and declare your stage model; the enforcement packages read it.

### When to choose it

Choose it for every deployment that runs a gated YXSpec flow, because it is the seam the enforcement packages inject — without it they stay pending and no rule is enforced. Its default stage model mirrors the SWE.1–SWE.5 stages the shipped `yxspec-swe-*` skills implement, so a project that follows that layout needs no `stages` config at all. A deployment running a different process replaces the list wholesale; a workspace carrying a `yxspec.json` seeds identity from the project's own file rather than restating it in the composition.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec'
  config:
    workspaceRoot: .
    projectConfigPath: yxspec.json
```

| Field | Default | Meaning |
|---|---|---|
| `workspaceRoot` | cwd | The workspace root the flow operates in; a relative path resolves against cwd |
| `identity` | from `yxspec.json` | The spec identity to report; an explicit value wins over the file |
| `trackMapPath` | `swe-track-map.json` | Workspace-relative dual-track map; a missing file yields an empty domain list rather than a failure |
| `projectConfigPath` | — | The project's own `yxspec.json`, whose identity fields seed `identity` |
| `stages` | `DEFAULT_STAGES` | The declared stage model; replacing it is how a deployment runs its own process |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec) is the exhaustive source for every accepted field.

### Per-agent step ownership

`ctx.yxspec.activeStep(agent)` reads the step one agent is on, and the [step driver](../yxspec-step/README.md) is the only writer. Ownership is per-agent rather than global because a fan-out workflow's workers must not gate on each other's progress: two workers on different steps each enforce their own input contract. A gate hook with no active step enforces no step gate at all.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The service extends Cordis `Service` under the `yxspec` key and holds three pieces of state: the resolved stage model, the resolved identity, and a per-agent active-step map. `Config.stages` is validated as `z.array(z.any())` because a stage is deployment data whose shape is already fixed by the exported `YxspecStage` type; the default list is used when the array is empty, so an accidental `stages: []` behaves like an absent key rather than silently declaring no process.

`snapshot()` reads the dual-track map from `trackMapPath` on every call and treats an unreadable file as an empty domain list, so a workspace that has not yet run SWE.1 still resolves its stage model. Identity fields resolve in precedence order: an explicit `Config.identity` value, then the project's `yxspec.json`, then the defaults. `status()` is the one method that takes a landing predicate rather than reading the filesystem itself — that inversion is what keeps this package free of an I/O dependency on the ledger, and it lets a deployment compute landing from something other than a stat.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service, its configuration, and the default SWE.1–SWE.5 stage model |
| [`src/types.ts`](src/types.ts) | The stage, step, identity, domain, and status vocabulary consumers read |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — every gate's contract and the `yxspec/*` events.
- [Artifact ledger](../yxspec-artifact/README.md) — the landing predicate `status()` is driven with.
- [Step driver](../yxspec-step/README.md) — the only writer of per-agent active steps.
- [Stage gate](../yxspec-gate/README.md) — the hook that turns this model into interception.
- [Process panel](../../client/ui-yxspec/README.md) — the browser view of this model.
- [Adding a package](../../../docs/cookbook/adding-a-package.md) — the seam/provider/consumer topology this package follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as the domain service answers stage, step, and status queries for its consumers and registers no tool, prompt section, or Session event.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The model is deployment data, not schema** — `Config.stages` validates only that it is an array, so a malformed stage or step fails at the consumer that indexes it rather than at load. A deployment editing the stage model has no schema error to guide it.
- **The dual-track map is read per snapshot** — `snapshot()` re-reads `trackMapPath` on every call, and an unreadable or malformed file yields an empty domain list rather than a diagnostic, so a typo in the map is indistinguishable from a workspace that has not produced one yet.
- **Active steps live only in memory** — per-agent step ownership is not persisted, so a Host restart forgets where each agent was. The ledger remains the source of truth for what has landed, and a driver re-derives the position from disk on the next call.
- **Identity precedence is not reported** — the resolved identity does not record which source supplied each field, so a composition debugging a surprising spec id must inspect the project file and the config separately.
- **Step ids are assumed unique across the model** — `step(stepId)` scans for the first match, so two stages declaring the same step id silently shadow one another rather than raising.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
