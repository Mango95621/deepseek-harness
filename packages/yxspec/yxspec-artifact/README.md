---
description: "The YXSpec artifact ledger: the on-disk completion criterion that decides whether a flow step finished, replacing the agent's self-report."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-artifact

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-artifact` as the one place the flow asks whether a step's work actually happened: it answers existence queries for the workspace-relative paths a stage model declares, and every query re-stats the filesystem. Mount it beside the domain service in any deployment that runs a gated flow; the step driver and both gate hooks inject `ctx.yxspecArtifacts`. Because the answer comes from disk rather than from the agent's word, a step whose outputs never landed cannot advance, and deleting a file out of band sends its step back to failing its gate. It optionally emits an observation event per write.

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

Mount the ledger beside the domain service and let the gates ask it what landed.

### When to choose it

Choose it whenever the flow is gated, because it is the only component that decides completion from real state — the [step driver](../yxspec-step/README.md), the [stage gate](../yxspec-gate/README.md), and the [Remote owner](../yxspec-api/README.md) all consume it. A deployment that only wants the stage model rendered without any gate has no use for it. The ledger holds no accumulated state to warm, so mounting it costs nothing at startup.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-artifact'
  config:
    emitIntervalMs: 0
```

| Field | Default | Meaning |
|---|---|---|
| `emitIntervalMs` | `0` | Emission interval for the `yxspec/artifact-write` event; zero disables emission while queries keep working |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec-artifact) is the exhaustive source for every accepted field.

### Asking what landed

`landed(rel)` answers for one path, `landedOf(rels)` and `missingOf(rels)` answer for a batch in input order. Both batch methods call the single-path check per entry rather than issuing one filesystem walk, because the paths a stage declares are not necessarily under a common directory and a partial answer would be worse than a slower one.

`isDeclared(rel)` reports whether any stage step names the path as a required input, which is what lets a deployment distinguish an artifact the flow cares about from an ordinary file write. `observe(rel)` records one write and is public so an out-of-band watcher can feed the ledger; the plugin's own hook calls it for writes the harness performs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`YxspecArtifactLedger` extends Cordis `Service` under the `yxspecArtifacts` key and resolves its root from `ctx.yxspec.root`, so every path it answers for is relative to the same base the gates relativize against. `landed` performs one `stat` inside a `try` and returns `false` for any failure, which folds "absent", "a directory", and "unreadable" into one honest answer: the gate wants to know whether the artifact is there to be read, and all three mean it is not.

The class deliberately keeps no set of observed writes. An accumulated set would answer from history and report a deleted file as present, so `landed` re-stats on every call and `observe` exists only for the optional event and for the byte count it returns. `emitIntervalMs` is a positive-integer setting because the event is a diagnostic tap rather than a correctness mechanism; the ledger behaves identically at zero.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The ledger service, its existence queries, and the optional observation event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the ledger's vocabulary and the `yxspec/*` events.
- [Domain service](../yxspec/README.md) — the stage model whose declared inputs the ledger answers for.
- [Step driver](../yxspec-step/README.md) — the consumer that refuses to advance on a missing output.
- [Stage gate](../yxspec-gate/README.md) — the hook that denies a call while a step's inputs are absent.
- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — the harness seam whose writes the observation hook follows.

-----

<a id="model-experience"></a>
## Model Experience

None, as the ledger answers existence queries for its consumers and emits a log-only observation event that no model request reads.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Existence is the whole criterion** — the ledger answers whether a path is a readable file and nothing about its content, size, or freshness. A step gated on an artifact that was written but never filled in passes, because a stale file is still a file.
- **A batch check costs one stat per path** — `landedOf` and `missingOf` call the single-path check per entry, so a stage declaring many inputs pays that many stats on every call, and the Remote `status` route repeats it for each requested stage.
- **The observation hook sees only harness writes** — `yxspec/artifact-write` fires for writes the harness performs, so a file created by an out-of-band process is visible to `landed` but never produces an event. Feeding the event from a watcher requires calling `observe` directly.
- **Missing directories are indistinguishable from missing files** — a root that does not exist makes every path under it read as absent, so a misconfigured `workspaceRoot` looks exactly like a project that has produced nothing.
- **The event is opt-in and unbatched** — with `emitIntervalMs` positive the ledger emits one event per observed write and does not coalesce them, so a bulk write produces a burst.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
