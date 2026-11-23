---
description: "Host Remote owner publishing the YXSpec stage model, each stage's artifact landing status, and one project's declared build servers to the desktop client."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-api

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-api` to show the YXSpec process in the desktop client: it publishes the declared stage model, each stage's artifact landing status, and one project's declared build servers over the `yxspec` and `yxspecRemote` Remote namespaces. Mount it wherever the process panel renders. The controllers own no rules — every value comes from `ctx.yxspec` and `ctx.yxspecArtifacts`, the same seams the gates enforce against, so the panel cannot disagree with the gate. Both are read-only: advancing a step stays a tool call, which travels through the gate. A missing seam surfaces as a typed error or an empty list.

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

Load the package where the browser should see the process, and let the Web client read the two namespaces it publishes.

### When to choose it

Choose it for any deployment whose Web bundle mounts the [process panel](../../client/ui-yxspec/README.md). The panel calls `status`, `documents`, `declaredArtifacts`, and `declaredArtifactsOf` on the `yxspec` namespace and the onboarding wizard calls `servers` on the `yxspecRemote` namespace; without this package neither namespace exists and both surfaces render their unavailable state. A headless deployment that never shows the process needs no Remote owner.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-api'
```

| Field | Default | Meaning |
|---|---|---|
| (none) | — | The package declares no `Config` fields |

This package declares no `Config`: the two seams it projects are read per call through `ctx.get`, so mounting it costs nothing beyond the controllers themselves.

### Projecting a missing seam

Neither controller declares an `inject` for the seam it reads, deliberately. Declaring one would hold the whole plugin pending, so `ctx.yxspecController` would be absent, the client's `yxspec` namespace would never appear, and the panel would vanish with no diagnostic instead of reporting what is missing. Reading through `ctx.get` instead turns both cases into visible state: `status` and `declaredArtifacts` throw `yxspec/service-unavailable` or `yxspec/ledger-unavailable`, and `servers` returns an empty list because `ctx.yxspecRemote` is optional by design.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`YxspecController` extends `TypertRemoteService` under the `yxspec` namespace and mounts `YxspecRemoteController` as a child plugin from its own constructor, because `src/index.ts` is the Loader entry the deployment names and each namespace is a separate Remote owner. Stage status is computed by flattening every step's `requiredInputs` across one stage and asking the ledger which are missing; the ledger re-stats on every query, so `landed` reflects the filesystem now rather than a cached set. The projected views carry `hasGateScript` rather than the script path, because the browser only needs to distinguish "this step has a deterministic check" from "it does not".

`readDocumentListing` is a bounded enumeration of the project's declared input and design directories, capped by depth and count; an unknown project, an absent directory, and an unmounted registry all yield an empty listing with the directories it searched, because "this project has no inputs yet" is a state the wizard renders rather than a failure. The search report travels in the same response as the candidates so both describe one filesystem state.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `yxspec` namespace owner and its four read methods |
| [`src/remote.ts`](src/remote.ts) | The `yxspecRemote` namespace owner and its build-server projection |
| [`src/documents.ts`](src/documents.ts) | The bounded candidate-document enumeration for the onboarding wizard |
| [`src/types.ts`](src/types.ts) | The projected view and listing types the client consumes |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the services this owner projects and the `yxspec/*` events.
- [Domain service](../yxspec/README.md) — the stage model every projected value comes from.
- [Artifact ledger](../yxspec-artifact/README.md) — the seam answering whether a declared path has landed.
- [Remote build service](../yxspec-remote/README.md) — the seam behind the build-server projection.
- [Process panel](../../client/ui-yxspec/README.md) — the browser surface that reads both namespaces.
- [Typert protocol](../../typert/protocol/README.md) — the Remote declaration and error-detail vocabulary this owner merges into.

-----

<a id="model-experience"></a>
## Model Experience

None, as the owner serves the browser client over Remote namespaces and registers no tool, prompt section, or Session event.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The panel cannot advance a step** — both namespaces are read-only by design, so moving the flow forward stays a tool call through the gate. A deployment wanting a UI button has no supported path, and adding one would create the second unguarded route this design exists to prevent.
- **A missing seam is visible, not fatal** — `status` and `declaredArtifacts` raise their typed errors and `servers` returns an empty list, so a partially deployed host shows an unavailable notice or an empty picker rather than failing to load.
- **Stage status is computed per call** — `status` re-stats every declared input of each requested stage, so a stage with many steps costs one filesystem stat per declared path per call. Omit `landedStages` only when the caller renders every stage.
- **The document listing is bounded** — candidate enumeration has a depth and entry ceiling, and the response reports whether truncation occurred instead of silently shortening the list.
- **Declared artifact paths are not validated** — `declaredArtifacts` returns whatever the stage model names, including paths a step's gate would never accept.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
