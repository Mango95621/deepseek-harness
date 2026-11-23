---
description: "The YXSpec process panel for the browser: a session section listing the ASPICE stages and each stage's artifact landing state, plus the onboarding wizard that withholds a blank Conversation until the project, its repositories, a specification, and a build server are settled."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-yxspec

English | [中文](README.zh.md)

## Summary

Use `dsh-client-ui-yxspec` to put the process in front of the operator: a session-panel section listing every declared ASPICE stage with its step count, its ❄ markers, and whether its declared inputs have landed, and an onboarding wizard that keeps a blank Conversation closed until the project, its roots, a specification, and a build server are settled. Mount it in a Web bundle beside the Remote owner that publishes the state it reads. The section cannot advance a step, which stays a tool call through the host gate, and a missing namespace or empty directory renders as a quiet empty state.

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

Mount it where the browser should show the process; the section and the wizard both install.

### When to choose it

Choose it for any Web deployment whose operator follows the gated flow, because the wizard is what tells the operator what the host expects before a prompt can be typed — discovering the missing inputs from a failed tool call inverts the process. A deployment whose flow is driven entirely from the command line needs neither surface. The two registrations are independent of each other only in principle: this package always installs both, because the gate is what makes the section's process model meaningful.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-client-ui-yxspec'
```

| Field | Default | Meaning |
|---|---|---|
| (none) | — | The package declares no `Config` fields |

The package declares no `Config`: which project it gates and which namespaces it reads are resolved from the client context at render time, not from a composition row.

### The five onboarding prerequisites

The wizard walks a closed list in order — `project`, `repositories`, `specification`, `server`, `ready` — and the order is forced by the data, because the specification candidates are files inside the project's own roots and there is nothing to enumerate before the roots are declared. Completion is recorded per project in browser storage rather than globally, so a second project in the same browser is not gated on the first one's answers.

The first two steps divide the work by what the host can answer at each point. Step one is where the project *comes into existence*: the operator supplies a name and nothing else, and the wizard creates a project over no directory — a state the host models, not a partial one. Step two then attaches repositories to that project one at a time, each pick a durable `addRoot` command against the project rather than an entry in a draft that a later create would carry. Appending is what makes the first directory primary: a root added to a rootless project lands at index 0 and is the session working directory without any promotion step, and `addRoot` never promotes, so adding a second repository cannot shift the working directory under the operator.

A project created over no directory has no path for the host's idempotent `create` to match on, so it cannot be found by path afterwards. The wizard therefore records the id step one received in its own persisted slot (`yxspec-onboarding-target`) and resolves it ahead of the session and workspace catalogues — otherwise the walk would drop the step that created the project between the create and the next catalogue frame, and a reload would silently create a second one. A target that is no longer registered falls through to the catalogue rule rather than gating a project that is gone.

Step three also lets the operator widen the search. A specification tree often lives beside the repositories rather than inside one — a shared document folder, a delivered package, a process-input archive — and nothing in the project's layout names it, so the host's own walk cannot reach it. The step's "Add a search directory" control picks one, and the additions are recorded on the project's progress record as `searchPaths`, written as each edit is made rather than with the eventual document choice: an operator who adds a directory and reloads before picking a document keeps the path. Every listing call then carries them to the host as an argument, so the client holds the answer and the host stays read-only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is a two-half plugin: `src/index.ts` is an empty `apply` that keeps it on the host loader roster, and the browser half ships through `exports["./client"]`, discovered from the package's `dsh.client` declaration. The client entry declares `inject` for the Remote carrier plus the two namespace keys as services in their own right — `remote.yxspec` and `remote.yxspecRemote` are installed by the Gateway as separate `remote.<namespace>` services, and Cordis only lets a plugin read a service it named. The comment in source records why naming them matters: omitting one does not fail loudly at load, because the read throws `cannot get property without inject`, which inside the surface's own loader collapses into the same unavailable branch as a genuinely unmounted host.

The section registers on `conversation.session.panel.section` and loads once on mount. It deliberately owns no subscription: a stale read is corrected by the next mount, because a live subscription would add host-to-client traffic for a table that changes only when an agent advances a step. The wizard registers on `conversation.hero.frame` at `order: -100`, making it the outermost layer, and while the project is not onboarded it replaces the frame's children rather than wrapping them — those children are the scroll body holding the composer seat, so declining to render them is the gate, with no disabled input box and no second code path that could disagree.

Progress persists through `createSnapshotStore` keyed by project inside one record, and the whole record is rewritten on save because the stored shape is read-only and the identifier is only resolved at the call site. Naming the project is one injected call rather than a create followed by a save: the project's id does not exist until the create answers and the record is keyed by that id, so doing it in the component would mean writing under an identifier its own render never saw. The seam receives the project the host answered with, writes both the target slot and the step's record under it, and renames the project instead of creating a second one when step one is reached again from a recorded walk. Step two's list is read straight off the resolved project row rather than kept as a draft, so a root edited from any other project surface is visible here too.

The specification step keeps its own additions in local state mirrored from the recorded answers, and re-runs its read whenever they change — the list is a dependency of the read, so adding a directory to it re-runs the call rather than requiring a second control that re-fetches. A pick that is cancelled or that names a directory already on the list changes nothing and re-runs nothing, and a refused picker renders its message without disturbing the search. The additions are held by the client rather than the host because they are a property of one operator's search rather than of the project: they gate nothing, no other surface reads them, and storing them host-side would add a second write path into durable state to answer a question the caller already holds.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The host half: an empty `apply` that keeps the plugin on the loader roster |
| [`src/client/index.ts`](src/client/index.ts) | The browser half: the section and wizard registrations, their injections, and the defensive Remote reads |
| [`src/client/YxspecPanel.tsx`](src/client/YxspecPanel.tsx) | The session-panel section and its stage rows |
| [`src/client/OnboardingWizard.tsx`](src/client/OnboardingWizard.tsx) | The gate over the hero frame and the five-step wizard |
| [`src/client/onboarding.ts`](src/client/onboarding.ts) | The pure wizard state transitions, the answers shape, and the walk's target record |
| [`src/client/project.ts`](src/client/project.ts) | Resolving the project the wizard gates, preferring the one a recorded walk created |
| [`src/client/slots.ts`](src/client/slots.ts) | The section's registration values and full props |
| [`src/client/locales.ts`](src/client/locales.ts) | The section's and wizard's copy in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [YXSpec subsystem](../../../docs/subsystems/yxspec.md) — the process this panel renders and the services behind it.
- [Remote owner](../../yxspec/yxspec-api/README.md) — publishes the `yxspec` and `yxspecRemote` namespaces this package reads.
- [Remote build service](../../yxspec/yxspec-remote/README.md) — the seam behind the wizard's server step.
- [Workspace controller](../../api/workspace-controller/README.md) — the service the wizard creates and adopts projects through.
- [Web client architecture](../../../docs/subsystems/web-client.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the browser panel and the onboarding gate render host-held process state without registering a tool, a prompt section, or a Session event.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The panel cannot advance a step** — the section is read-only by design, so moving the flow forward stays a tool call through the host gate. A deployment wanting a UI control has no supported path, and adding one would create the second unguarded route this design exists to remove.
- **The section loads once and does not refresh** — no subscription or polling backs it, so a step an agent advances while the panel is open shows only after a remount.
- **Onboarding progress is per browser, not per host** — the record lives in browser storage keyed by project, so a different browser or a cleared store asks the operator again.
- **The gate depends on settled project identity** — the wizard resolves the project from the walk's own target record and, failing that, from the standard session and workspace kit at render time. A target whose project has since been deleted is deliberately not honoured, so the walk falls back to the catalogues and, when those cannot name a project either, comes back.
- **A step-one refusal is retried, not rolled back** — a refused create or rename renders its message and leaves the step open with the name the operator typed; there is no partial project to clean up, since the create either answered with an id or did not happen.
- **A deployment missing the namespaces degrades silently** — an unmounted host and a refused call both render as an unavailable notice or an empty list rather than an error, which is intentional but means a healthy host with a misconfigured mount looks the same as an absent one.
- **An added search directory is not validated as a directory** — the picker returns a path and the step records it; the host then walks it and reports it among `searched` even when nothing is there. A path that is not a directory at all, or one that is not absolute, contributes no candidates rather than an error, so the operator's diagnosis is the search report rather than a refusal.
- **The additions are per browser, not per host** — like the rest of the wizard's progress they live in browser storage keyed by project, so a second browser starts from the project's own layout again.
- **`ready` is not a probe** — finishing the server step records that the question was answered, not that the declared server was reachable; the wizard does not probe.
- **The copy ships in eight languages but the flow's own text does not** — the panel and wizard are localized, while the step contracts and denial reasons the model sees remain fixed Chinese prose.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
