---
description: "Remote compile verification for a YXSpec flow: declare a build server, then run one named recipe against an uploaded copy of the project tree and read back the exit code, log, and tree digest."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-remote

English | [中文](README.zh.md)

## Summary

Use `dsh-yxspec-remote` to make "the build passed" mean something a transcript cannot: declare a build server, run one of its named recipes against an uploaded copy of the project tree, and get back the exit code, the log, and the tree's SHA-256. Mount it where a later stage requires a green compile. Source never lives on the server: a run archives the local tree, streams it into a per-project scratch directory, compiles, and returns. Recipes are declared rather than typed, so the model picks an id, and every run is recorded as durable evidence.

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

Declare a server once, then run its recipes as the flow reaches each verification point.

### When to choose it

Choose it when the build needs a machine the agent's host is not — an AOSP or Yocto tree on a Linux farm reached from Windows, or any compile whose toolchain the developer machine cannot host. A deployment that builds locally needs nothing here, and the [process panel](../../client/ui-yxspec/README.md)'s onboarding wizard still renders its "no server declared yet" state, because the [Remote owner](../yxspec-api/README.md) treats this seam as optional. Credentials are never part of the configuration: the destination is an OpenSSH destination resolved against the host's own `~/.ssh/config`, so the operator's existing keys, agent, and jump hosts apply unchanged.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-remote'
  config:
    pushSource: true
```

| Field | Default | Meaning |
|---|---|---|
| `excludes` | `.git`, `node_modules`, `build`, `out`, `dist`, `target`, `.gradle`, `.idea`, `.vscode`, `__pycache__`, `*.pyc` | Archive exclusions applied when pushing a project tree |
| `pushSource` | `true` | Whether a run uploads the tree first; `false` runs against whatever is already on the server |
| `tarExecutable` | probed platform default | Absolute local `tar` to use for archiving |
| `logMaxBytes` | `2097152` | Output budget for a run's returned log, in bytes |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec-remote) is the exhaustive source for every accepted field.

### Declaring a server

A declaration names a destination, a base directory, and a recipe map; a probe confirms the handshake and that the base directory exists. Only recipes the map names can ever run, which is what makes the model's choice a selection rather than a command. The service also exposes `list`, `server`, `forget`, `probe`, `run`, `runsFor`, and `lastSuccess` to host consumers, and `runsFor` is what a later stage reads to confirm a recipe was verified against a given tree.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three model-facing tools sit in front of the service — `remote_server_list`, `remote_server_declare`, and `remote_build` — and they are the only path an agent has to a build server. That is deliberate: a build is a tool call, so it passes through the same `tools` pipeline the [stage gate](../yxspec-gate/README.md) hooks, and a stage can therefore require a green remote build before a later stage begins. The service itself declares `inject = ['subprocess', 'workspaceRegistry', 'storageDomain', 'tools']`, and both durable tables live in a storage domain rather than in the project's own JSON, because a verification record must not be editable by the agent it audits.

`ssh.ts` takes the other road on Windows, where dsh's own SSH runtime refuses any non-Linux, non-macOS client: it invokes the platform's own OpenSSH client once per step and reads the exit facts back through `ctx.subprocess`. Three independently diagnosable steps run in order — `tar` archives the local tree, one `ssh` pipes that archive into a server-side `tar -x`, and a second `ssh` runs the recipe in the extracted tree. The archive travels as a byte stream over the client's stdin rather than as a command argument, because a tree that does not fit in `ARG_MAX` is the normal case rather than an edge one.

`paths.ts` derives the server-side directory from the project id and title. The slug is the one string here that must survive both a hostile title and a second project arriving with the same readable name, so its character class admits no path separator and no shell metacharacter, and collapsing runs of dots removes any `..` component. `recipe.ts` is the only place a remote command line is built: `renderRecipe` substitutes `{cwd}`, prepends `set -e` so a template written as `a; b` stops at the first failure rather than reporting the last command's status, and adds an explicit `cd` so a recipe no longer depends on ssh's login directory.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service, its configuration, and the three model-facing tools |
| [`src/spec.ts`](src/spec.ts) | The storage-domain declaration for build servers and the run ledger |
| [`src/ssh.ts`](src/ssh.ts) | The `tar`/`ssh` transport and the subprocess capabilities it drives |
| [`src/paths.ts`](src/paths.ts) | Server-side directory naming for one project |
| [`src/recipe.ts`](src/recipe.ts) | The single command-line renderer |
| [`src/types.ts`](src/types.ts) | The declared-server, run-request, run-result, and probe vocabulary |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the `yxspecRemote` service and the `yxspec/remote-run` event.
- [Remote owner](../yxspec-api/README.md) — the read-only namespace that projects declarations to the browser.
- [Stage gate](../yxspec-gate/README.md) — the hook a build call passes through, which is what lets a stage require a green run.
- [Storage domains](../../storage/storage-domain/README.md) — the durable tables the declarations and run ledger live in.
- [Subprocess](../../subprocess/subprocess/README.md) — the seam the OpenSSH transport drives.
- [Adding a package](../../../docs/cookbook/adding-a-package.md) — the seam/provider/consumer topology this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### Build-server tools

#### What the model sees

The three registered tools are the only model-facing surface. Their descriptions are fixed prose the model reads on every request that offers them, and their results arrive as the canonical JSON the shared renderer emits, so the model reads one stable shape per tool rather than a hand-formatted sentence; a failing build is returned as data rather than as a tool error, because reading `exitCode` and `log` is the point of running it. The `remote_build` result is the shape a stage's evidence rests on.

##### Successful run result

```markdown
{
  "ok": true,
  "workspaceId": "ws_01",
  "serverId": "aosp-builder",
  "recipe": "ninja-full",
  "remoteDirectory": "/srv/builds/mcu-tree-01/ws_01",
  "command": "set -e; cd '/srv/builds/mcu-tree-01/ws_01'; ninja -C {cwd}/out",
  "exitCode": 0,
  "log": "…",
  "truncated": false,
  "timedOut": false,
  "durationMs": 40213,
  "treeDigest": "9f2c…",
  "logSha256": "41ab…",
  "runId": "run_7"
}
```

#### Token effect

Zero direct tokens beyond the tool descriptions already in the offered set. Each call then returns one JSON document whose `log` is capped by `logMaxBytes`, with `truncated` reporting that the head was dropped, so a build's noise cannot grow the result without bound.

#### KV Cache effect

Append-only. A tool result is an ordinary addition to the Session log and does not rewrite a reusable prefix, so provider cache reuse of the earlier conversation survives. Nothing this package contributes changes the system prompt or the tool offering itself.

### Declared-server declaration tool

#### What the model sees

`remote_server_declare` is the write path, and it is deliberately narrow: the model supplies a destination, a base directory, and the recipe map, and it never supplies a credential. The description states that credentials are neither passed nor stored, which is the boundary the operator needs to trust before pointing an agent at a build host. Its result is a confirmation naming the server id and the recipe ids that took effect.

##### Declaration confirmation

```markdown
{
  "ok": true,
  "workspaceId": "ws_01",
  "serverId": "aosp-builder",
  "recipes": ["ninja-full", "ninja-incremental"]
}
```

#### Token effect

Zero direct tokens beyond the description already in the offered set. The confirmation is one short JSON document, and a malformed recipe list fails the whole declaration rather than dropping a recipe a stage gate might have been told to require.

#### KV Cache effect

Append-only, like any other tool result. Neither the declaration nor its confirmation touches the system prompt, so no reusable prefix is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only OpenSSH is implemented** — `transport` is declared as the single literal `'ssh'`, so a build farm reached another way needs a new transport rather than a configuration change.
- **Windows drives the platform client, not dsh's own runtime** — the transport invokes an OpenSSH executable per step and resolves it by name, so a deployment with a bundled client must pin `tarExecutable` and the per-server `sshExecutable` itself.
- **A run pushes a whole tree** — exclusions are extension- and directory-name based, so a large artifact under an unlisted path is uploaded every time; a pre-synced tree avoids it only by turning `pushSource` off, which trades the tree digest away.
- **The log is tail-truncated, never paged** — a run returns the last `logMaxBytes` bytes and a `truncated` flag, with no way to fetch the dropped head other than re-running the recipe.
- **`extraArgs` is unsandboxed shell text** — the parameter is appended verbatim to the rendered recipe, so a one-off flag is also a one-off command fragment on a shared build host.
- **The ledger answers about runs, not about correctness** — a stored record proves which tree was compiled and what exit code came back; it does not verify that the recipe tests what a stage claims it tests.
- **A timeout is reported, not retried** — `timedOut` marks a run whose command outlived `timeoutMs`, and the caller owns any retry policy.
- **Declarations are per project** — a server is keyed by `${workspaceId}:${serverId}`, so two projects sharing one build host declare it twice and probe it separately.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
