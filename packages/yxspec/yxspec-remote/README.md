---
description: "Remote compile verification for a YXSpec flow: declare a build server, then run one named recipe inside the checkout that machine already holds and read back the exit code, log, source revision, and any products asked for."
kind: "package-reference"
---

# @deepseek-ai/dsh-yxspec-remote

English | [中文](README.zh.md)

## Summary
Use `dsh-yxspec-remote` to make "the build passed" mean something a transcript cannot: declare a build server, run one of its named recipes inside the checkout that machine already holds, and get back the exit code, the log, the source revision, and any products the caller names. Nothing is uploaded — an automotive tree is hundreds of gigabytes — so the harness never creates, replaces, or deletes the tree it builds in. Mount it where a later stage requires a green compile: recipes are declared, not typed, and every run is recorded as durable evidence.

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

Declare a server once — naming a checkout that already exists on the build machine — then run its recipes as the flow reaches each verification point.

### When to choose it

Choose it when the build needs a machine the agent's host is not — an AOSP or Yocto tree on a Linux farm reached from Windows, or any compile whose toolchain the developer machine cannot host — and that machine already holds the source, kept in step by whatever sync or CI the team already runs. A tree that exists only on the developer's machine is not this seam's case: fetching hundreds of gigabytes per run costs more than the build. A deployment that builds locally needs nothing here, and the [process panel](../../client/ui-yxspec/README.md)'s onboarding wizard still renders its "no server declared yet" state, because the [Remote owner](../yxspec-api/README.md) treats this seam as optional. Credentials are never part of the configuration: the destination is an OpenSSH destination resolved against the host's own `~/.ssh/config`, so the operator's existing keys, agent, and jump hosts apply unchanged.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-yxspec-remote'
```

| Field | Default | Meaning |
|---|---|---|
| `sshExecutable` | probed platform default | Local `ssh` every declaration uses unless it pins its own — the place a deployment points at a wrapper client |
| `tarExecutable` | probed platform default | Absolute local `tar` to use for expanding fetched products |
| `logMaxBytes` | `2097152` | Output budget for a run's returned log, in bytes |
| `probeTimeoutMs` | `60000` | Wall-clock budget for one connection test, independent of a declaration's per-run budget |
| `fetchMaxBytes` | `536870912` | Byte ceiling for one fetch, enforced while the archive streams |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-yxspec-remote) is the exhaustive source for every accepted field.

### Declaring a server

A declaration names a destination, the project directory to build in, and a recipe map; each recipe may name its own output directory. A probe — one round trip that reports the platform, whether the project directory is there, and whether the output directory exists yet — is what the wizard's "test connection" control calls, and its outcome is stored on the declaration so the row a list renders afterwards describes the last attempt instead of the last success.

A missing project directory is reported with the path that does exist: the probe also tests the same path under the login directory, because a declaration written from a Windows share spelling (`\\host\user\projects\x`) names a path the machine does not have — the share maps to that user's home — and the answer the operator needs is the one to type instead. When the path is not there either, the miss carries the login directory, so two spellings can be compared without a second session. Only recipes the map names can ever run, which is what makes the model's choice a selection rather than a command. The service also exposes `list`, `server`, `forget`, `probe`, `run`, `runsFor`, and `lastSuccess` to host consumers, and `runsFor` is what a later stage reads to confirm a recipe was verified against a given tree.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Three model-facing tools sit in front of the service — `remote_server_list`, `remote_server_declare`, and `remote_build` — and they are the only path an agent has to a build server. That is deliberate: a build is a tool call, so it passes through the same `tools` pipeline the [stage gate](../yxspec-gate/README.md) hooks, and a stage can therefore require a green remote build before a later stage begins. The service itself declares `inject = ['subprocess', 'storageDomain']` — it reads no local project, because the tree it builds is the server's — and both durable tables live in a storage domain rather than in the project's own JSON, because a verification record must not be editable by the agent it audits.

A declaration is written by choosing, not by typing: `browse` lists the directories under one path on a server, so the onboarding wizard can connect first and offer what is there. It names a destination rather than a declaration — the operator picks the directory before the declaration that would name it exists — and it reads one directory per round trip: `pwd` after a `cd`, then the child directories, with one entry past the ceiling requested so the answer can say whether it stopped early. Nothing is stored, and nothing outside the named directory is read.

`ssh.ts` takes the other road on Windows, where dsh's own SSH runtime refuses any non-Linux, non-macOS client: it invokes the platform's own OpenSSH client once per step and reads the exit facts back through `ctx.subprocess`. Three independently diagnosable steps run in order — one `ssh` reads the server-side source revision when the declaration asks for one, a second runs the recipe inside the project directory, and a third streams the named products back as a `tar.gz` that is expanded locally. Bytes cross in one direction only: products come back, source never goes out.

The directories are the operator's, so nothing derives them: a recipe's `outputDirectory` is resolved per run to `<projectDirectory>/out` when the recipe left it out, which keeps a moved convention out of every row written before it. It sits on the recipe rather than on the server because a whole build and a module build of one tree write their products to different places, so one directory per machine could only describe one of them. A fetch names paths relative to that output directory and the service refuses an absolute path, a `~`, or any `..` segment before the transfer starts, so returning products cannot become a way to read the machine. `recipe.ts` is the only place a remote command line is built: `renderRecipe` substitutes `{cwd}` and `{out}`, prepends `set -e` so a template written as `a; b` stops at the first failure rather than reporting the last command's status, and adds an explicit `cd` so a recipe does not depend on ssh's login directory — and so a project directory that is not there fails with the path named.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service, its configuration, and the three model-facing tools |
| [`src/spec.ts`](src/spec.ts) | The storage-domain declaration for build servers and the run ledger |
| [`src/ssh.ts`](src/ssh.ts) | The `ssh` transport, the revision read, the product fetch, and the subprocess capabilities it drives |
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
  "projectDirectory": "/srv/aosp",
  "outputDirectory": "/srv/aosp-out",
  "command": "set -e; cd '/srv/aosp'; ninja -C /srv/aosp-out",
  "exitCode": 0,
  "log": "…",
  "truncated": false,
  "timedOut": false,
  "durationMs": 40213,
  "revision": "a3f9c1e…",
  "revisionDigest": "7b1d…",
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

`remote_server_declare` is the write path, and it is deliberately narrow: the model supplies a destination, the project directory, and the recipe map — each recipe optionally with its own output directory — and it never supplies a credential. The description states that credentials are neither passed nor stored, which is the boundary the operator needs to trust before pointing an agent at a build host. Its result is a confirmation naming the server id and the recipe ids that took effect.

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
- **Windows drives the platform client, not dsh's own runtime** — the transport invokes an OpenSSH executable per step and resolves it by name, so a deployment with a bundled client pins `sshExecutable` (once, for every server that does not name its own) and `tarExecutable` itself.
- **Password-only login needs a client of the deployment's own** — every invocation carries `BatchMode=yes`, so a missing key fails immediately instead of hanging on an interactive prompt, and no declaration can carry a credential: the destination is an OpenSSH destination the host's own `~/.ssh/config` resolves. A build host reachable only by password is served by pointing `sshExecutable` at a wrapper that supplies the password from outside this seam (`sshpass`, PuTTY's `plink -pw`, a script reading the OS keychain); the wrapper receives the same argv the platform client would. Installing a key on the host is the shorter road when it is available.
- **The tree must already be on the machine** — a declaration names a directory, and a run neither creates nor syncs it. Keeping it current is the deployment's job, and a stale tree compiles stale source; the recorded revision is what makes that visible.
- **A fetch is the caller's list, not a manifest** — the products a run brings back are the paths the caller named, and the seam lists nothing on its own, so discovering a product name is the recipe's job (or the build log's).
- **The log is tail-truncated, never paged** — a run returns the last `logMaxBytes` bytes and a `truncated` flag, with no way to fetch the dropped head other than re-running the recipe.
- **`extraArgs` is unsandboxed shell text** — the parameter is appended verbatim to the rendered recipe, so a one-off flag is also a one-off command fragment on a shared build host.
- **The ledger answers about runs, not about correctness** — a stored record proves which command ran where, which revision was read, and what exit code came back; it does not verify that the recipe tests what a stage claims it tests, and the revision is absent unless the declaration asked for it.
- **A timeout is reported, not retried** — `timedOut` marks a run whose command outlived `timeoutMs`, and the caller owns any retry policy.
- **Declarations are per project** — a server is keyed by `${workspaceId}:${serverId}`, so two projects sharing one build host declare it twice and probe it separately.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
