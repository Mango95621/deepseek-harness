---
description: "The YXSpec package group: the ASPICE stage model, its host-enforced gates, blind dispatch, and remote build verification."
kind: "package-group"
---

# yxspec/ — gated ASPICE R&D flow

English | [中文](README.zh.md)

## Summary

The YXSpec package family turns an ASPICE software-process flow from prose each step asks the agent to honour into host-enforced interception. The domain service owns the stage model, the dual-track map, and spec identity; the other packages gate, advance, dispatch, and verify against it. Completion is read from artifacts on disk rather than from the agent's report, so a step whose outputs never landed cannot advance and a frozen artifact cannot be rewritten without a change request. Choose these packages when a project must leave an auditable trail; the browser panel renders the same model the gates enforce.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`yxspec/`](yxspec/README.md) | Owns the ASPICE stage model, the dual-track map, and spec identity; enforces nothing by itself | `ctx.yxspec` |
| [`yxspec-artifact/`](yxspec-artifact/README.md) | Answers whether a declared artifact has landed, re-statting on every query | `ctx.yxspecArtifacts` |
| [`yxspec-step/`](yxspec-step/README.md) | Exposes `yxspec_status` and `yxspec_next`: one step at a time, refused while outputs are missing | registers on `ctx.tools` |
| [`yxspec-gate/`](yxspec-gate/README.md) | Denies tool calls that would rewrite a frozen artifact or run with missing step inputs | registers on `ctx.tools` |
| [`yxspec-freeze/`](yxspec-freeze/README.md) | Routes ❄ step calls through `ctx.approval`, failing closed when nobody answers | registers on `ctx.tools` |
| [`yxspec-api/`](yxspec-api/README.md) | Publishes the stage model and build-server list to the desktop client | `ctx.yxspecController`, `ctx.yxspecRemoteController` |
| [`yxspec-dispatch/`](yxspec-dispatch/README.md) | Renders and lands a worker prompt, returning a hash handle instead of the body | `ctx.yxspecDispatch` |
| [`yxspec-remote/`](yxspec-remote/README.md) | Declares build servers and runs compile recipes over OpenSSH | `ctx.yxspecRemote` |
| [`ui-yxspec`](../client/ui-yxspec/README.md) | Renders the stage panel and gates a blank Conversation behind onboarding | — (browser) |

-----

<a id="related-documentation"></a>
## Related documentation

- [YXSpec subsystem](../../docs/subsystems/yxspec.md) — the services, the artifact ledger vocabulary, and the `yxspec/*` events.
- [Tools](../../docs/subsystems/tools.md) — the guarded execution pipeline every gate hook runs inside.
- [User approval](../../docs/subsystems/approval.md) — the one-shot grant a freeze point requires, and its `unavailable` outcome.
- [Subprocess](../../docs/subsystems/subprocess.md) — the seam the remote build service drives OpenSSH through.
- [Adding a package](../../docs/cookbook/adding-a-package.md) — the group and package layout this family follows.

<a id="dev-note"></a>
## Dev Note

None.
