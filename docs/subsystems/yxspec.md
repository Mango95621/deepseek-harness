# YXSpec process gates

English | [中文](yxspec.zh.md)

YXSpec is the gated R&D flow a project walks to satisfy ASPICE software-process requirements. The [domain service](../../packages/yxspec/yxspec/README.md) owns the stage model, the dual-track map, and the spec identity; the enforcement plugins in this group gate on it. This page documents the vocabulary those packages exchange: the services, the artifact ledger, and the two events.

The stages, their steps, and each step's required inputs are deployment configuration. `Config.stages` replaces the default SWE.1–SWE.5 model wholesale, and a workspace's `yxspec.json` seeds the reported identity, so the page describes the shapes rather than one project's stage table. Mounting the domain service alone enforces nothing: every rule lives in a consumer that injects `ctx.yxspec`.

Four rules are enforced, each by one package. The [artifact ledger](../../packages/yxspec/yxspec-artifact/README.md) answers "has this path landed?" from the filesystem, so completion is read from disk and never from a claim. The [step driver](../../packages/yxspec/yxspec-step/README.md) advances the flow one step at a time and refuses to move while the leaving step's declared inputs are absent. The [stage gate](../../packages/yxspec/yxspec-gate/README.md) denies any tool call that would rewrite a frozen artifact or that runs while the active step's inputs are missing. The [freeze point](../../packages/yxspec/yxspec-freeze/README.md) routes a ❄ step's calls through `ctx.approval` and fails closed when no answerer grants them.

Two seams carry data outward. The [blind dispatcher](../../packages/yxspec/yxspec-dispatch/README.md) renders a worker prompt, lands it, hashes it, and returns only a handle, so a controller cannot leak the body into its own context. The [remote build service](../../packages/yxspec/yxspec-remote/README.md) declares build servers and runs compile recipes over the platform's own OpenSSH client. Both are consumed by the [process panel](../../packages/client/ui-yxspec/README.md), which renders stage state in the browser and gates a blank Conversation behind the onboarding wizard.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxyxspec--yxspecservice"></a>

### `ctx.yxspec` — `YxspecService`

The YXSpec domain service. Read-mostly: consumers gate on it, it does not gate on them.

```ts cordis-catalog
/**
 * Every declared stage, in business order (SWE.1 → SWE.5, then SUP/SPL when present).
 * @returns the stage model; never empty.
 */
stages(): readonly YxspecStage[]

/**
 * Resolve one stage by id.
 * @param id - the stage id.
 * @returns the stage, or `undefined` when the deployment declares no such stage.
 */
stage(id: string): YxspecStage | undefined

/**
 * Resolve one step across the whole model. Enumerated so a caller holding only a step id
 * (as a gate hook does) can find its stage and frozen-ness.
 * @param stepId - the step id, unique across the model by convention.
 * @returns the step and its owning stage, or `undefined`.
 */
step(stepId: string): { stage: YxspecStage; step: YxspecStep } | undefined

/**
 * Whether a step is a frozen ❄ point requiring main-session human confirmation.
 * @param stepId - the step id.
 * @returns true when the step is frozen; false when unknown or not frozen.
 */
isFrozenStep(stepId: string): boolean

/**
 * The step a given agent is currently on, as set by the step driver. The gate hook reads
 * this to decide which step's input contract to enforce; with no active step, no step
 * gate applies.
 *
 * Ownership is per-agent so a fan-out workflow's workers do not gate on each other's
 * progress.
 * @param agent - the agent whose active step to read.
 * @returns the active step and its stage, or `undefined` when the agent has none.
 */
activeStep(agent: object): { stage: YxspecStage; step: YxspecStep } | undefined

/**
 * Set the step an agent is working on. The step driver calls this when it hands out a
 * step; the gate hook reads it.
 * @param agent - the agent taking the step.
 * @param stepId - the step id, or `undefined` to clear.
 * @returns true when the step id resolved in the stage model.
 */
setActiveStep(agent: object, stepId: string | undefined): boolean

/**
 * The whole declarative model plus the read track map, for a UI or a step driver that
 * wants one call.
 * @returns an immutable snapshot.
 */
async snapshot(): Promise<YxspecSnapshot>

/**
 * The functional-domain → track map, read from the workspace's track-map file. Results are
 * cached for the process lifetime; the map is deployment configuration, not live state.
 * @returns the domain assignments; empty when the file is absent or malformed.
 */
async domains(): Promise<readonly YxspecDomainTarget[]>

/**
 * Assign a functional domain to its track.
 * @param domain - the domain key.
 * @returns the assigned track, defaulting to `both` when unmapped.
 */
async trackOf(domain: string): Promise<YxspecTrack>

/**
 * Progress of one stage, derived from the artifact ledger rather than from any agent
 * self-report. A stage is complete only when its terminal step's outputs have landed.
 *
 * This is the seam `yxspec-step` and `yxspec-artifact` cooperate on; the domain service
 * exposes the hook so a UI can read the same answer without duplicating the rule.
 * @param stageId - the stage id.
 * @param landed - predicate answering whether a workspace-relative path has landed.
 * @returns the stage's status.
 */
async status(stageId: string, landed: (path: string) => Promise<boolean>): Promise<YxspecStageStatus>

/**
 * Whether every declared input of a step has landed.
 * @param step - the step whose inputs to test.
 * @param landed - the path predicate.
 * @returns true when all inputs are present (or the step declares none).
 */
async inputsLanded(step: YxspecStep, landed: (path: string) => Promise<boolean>): Promise<boolean>
```

Source: [`packages/yxspec/yxspec/src/index.ts`](../../packages/yxspec/yxspec/src/index.ts)

<a id="ctxyxspecartifacts--yxspecartifactledger"></a>

### `ctx.yxspecArtifacts` — `YxspecArtifactLedger`

The artifact ledger. Answers existence queries against the workspace root the YXSpec service resolved, so every consumer shares one path base.

```ts cordis-catalog
/**
 * Whether a workspace-relative path has landed as a readable file. Re-stats on every
 * call; a path that vanished since an earlier call reads as absent.
 * @param rel - the workspace-relative path (POSIX separators).
 * @returns true when the path exists and is a file.
 */
async landed(rel: string): Promise<boolean>

/**
 * Which of the given paths have landed, in one pass.
 * @param rels - workspace-relative paths.
 * @returns the subset that exists on disk, in input order.
 */
async landedOf(rels: readonly string[]): Promise<readonly string[]>

/**
 * Which of the given paths are still missing.
 * @param rels - workspace-relative paths.
 * @returns the subset absent from disk, in input order.
 */
async missingOf(rels: readonly string[]): Promise<readonly string[]>

/**
 * Record an observed write. Called by the plugin's own `fs` observation hook; public so a
 * deployment can feed the ledger from an out-of-band watcher.
 * @param rel - the workspace-relative path written.
 * @returns the recorded observation, or `undefined` when the path is outside the workspace.
 */
async observe(rel: string): Promise<ArtifactWrite | undefined>

/**
 * Whether any stage step declares this path as a required input.
 * @param rel - the workspace-relative path.
 * @returns true when some step gates on it.
 */
isDeclared(rel: string): boolean
```

Source: [`packages/yxspec/yxspec-artifact/src/index.ts`](../../packages/yxspec/yxspec-artifact/src/index.ts)

<a id="ctxyxspeccontroller--yxspeccontroller"></a>

### `ctx.yxspecController` — `YxspecController`

Host service backing the generated `ctx.remote.yxspec` namespace. Read-only: the client renders process state, it does not advance it. Advancing a step is a tool call, which travels through the gate — the same path an agent takes.

```ts cordis-catalog
/**
 * The declared identity, stage model, and dual-track map in one call, plus each named
 * stage's landing status.
 * @param landedStages - stage ids to compute status for; omitted means every stage.
 * @returns the projected process state.
 * @throws RemoteError when the domain service or its ledger is not mounted.
 */
@Remote async status(landedStages?: string[]): Promise<YxspecStatusValue>

/**
 * Candidate specification documents for one project, for the onboarding wizard's first
 * step, together with the directories the host enumerated to find them. A bounded
 * enumeration of the project's declared input and design directories; an unknown project,
 * an absent directory, or an unmounted registry all yield an empty listing rather than an
 * error, because "this project has no inputs yet" is a state the wizard renders and not a
 * failure.
 *
 * The search report travels with the candidates rather than in a second call: a client that
 * asked twice could be answered by two different filesystem states, and the report is
 * exactly what makes the empty case legible.
 *
 * `extraDirectories` is how the operator widens the search beyond the project's own layout.
 * It is a parameter rather than host state, and this controller stays read-only: where the
 * operator looks is a property of one operator's search, not of the project, and storing it
 * here would make an unvalidated write path into durable state to answer a question the
 * caller already holds. The client persists its own additions per project and passes them
 * back on each call; the host validates and walks them exactly as it walks the project's own
 * directories.
 * @param workspaceId - the project whose candidate documents to list.
 * @param extraDirectories - absolute directories to search in addition to the project's own;
 *   omitted or empty means the project's layout decides the search.
 * @returns the candidates, the absolute directories searched, and whether the ceiling
 *   truncated the listing.
 */
@Remote async documents( workspaceId: string, extraDirectories?: string[], ): Promise<YxspecDocumentListing>

/**
 * Every workspace-relative path the domain model declares, so a client can render the
 * artifact tree without hardcoding the layout.
 * @returns the declared artifact paths, de-duplicated and sorted.
 * @throws RemoteError when the domain service is not mounted.
 */
@Remote declaredArtifacts(): string[]

/**
 * The declared artifact paths belonging to one stage. A client rendering a stage detail
 * view calls this instead of filtering {@link declaredArtifacts}.
 * @param stageId - the stage whose declared inputs to return.
 * @returns the stage's declared artifact paths, de-duplicated and sorted; empty when the
 *   stage id is unknown.
 * @throws RemoteError when the domain service is not mounted.
 */
@Remote declaredArtifactsOf(stageId: string): string[]
```

Source: [`packages/yxspec/yxspec-api/src/index.ts`](../../packages/yxspec/yxspec-api/src/index.ts)

<a id="ctxyxspecdispatch--yxspecdispatcher"></a>

### `ctx.yxspecDispatch` — `YxspecDispatcher`

The blind dispatcher. Exposes rendering and spawning; deliberately exposes no way to read a rendered prompt back.

```ts cordis-catalog
/**
 * Render one worker role prompt from its template and land it under the spawn directory.
 *
 * Templates use `{{name}}` anchors; every anchor present in the template must have a value
 * in `parameters`, and every value must be used. A leftover anchor fails the render rather
 * than dispatching a prompt with an unresolved placeholder — the same all-or-nothing rule
 * the original renderer enforced.
 *
 * @param role - the worker role (kebab-case), naming the `prompts/<role>.md` template.
 * @param workerId - per-worker unique id; two concurrent same-role dispatches must differ.
 * @param parameters - the authoritative run parameters filling the anchors.
 * @returns a handle carrying the file path and hash, never the body.
 */
async render(role: string, workerId: string, parameters: Readonly<Record<string, string>>): Promise<DispatchHandle>

/**
 * The diagnostic a controller receives instead of a prompt body: counts, never content.
 * @param handle - the handle to describe.
 * @returns a one-line diagnostic.
 */
describe(handle: DispatchHandle): string

/**
 * Build the spawn prompt for a worker. The prompt carries the file path and hash and
 * instructs the worker to verify the hash before acting; it never embeds the body.
 * @param request - the dispatch request.
 * @returns the spawn prompt string.
 */
buildSpawnPrompt(request: DispatchRequest): string
```

Source: [`packages/yxspec/yxspec-dispatch/src/index.ts`](../../packages/yxspec/yxspec-dispatch/src/index.ts)

<a id="ctxyxspecremote--yxspecremoteservice"></a>

### `ctx.yxspecRemote` — `YxspecRemoteService`

The remote build service. Owns declarations, executes recipes, and records every run.

```ts cordis-catalog
/**
 * Declare (or replace) a build server for one project.
 * @param workspaceId - the owning project.
 * @param server - the declaration; its `id` is the key within the project.
 * @param now - ISO-8601 stamp; defaults to the current instant.
 * @returns the stored record.
 */
async declare( workspaceId: string, server: YxspecRemoteServer, now: string = new Date().toISOString(), ): Promise<RemoteServerRecord>

/**
 * Remove a declaration. Recorded runs stay: they are evidence of work that
 * happened, and deleting the server does not un-happen the build.
 * @param workspaceId - the owning project.
 * @param serverId - the declaration to remove.
 * @returns true when a declaration existed.
 */
async forget(workspaceId: string, serverId: string): Promise<boolean>

/**
 * The servers one project declared, in declaration order.
 * @param workspaceId - the project to list.
 * @returns the stored declarations.
 */
async list(workspaceId: string): Promise<readonly RemoteServerRecord[]>

/**
 * Resolve one declaration.
 * @param workspaceId - the owning project.
 * @param serverId - the server id within that project.
 * @returns the record, or `undefined` when the project declares no such server.
 */
async server(workspaceId: string, serverId: string): Promise<RemoteServerRecord | undefined>

/**
 * Probe a declared server: SSH handshake, platform, and whether the declared
 * directories are there.
 *
 * A probe never throws for an unreachable server — reachability is the value
 * being reported, and a caller rendering a picker needs the negative answer as
 * much as the positive one. It throws only when the project declares no such
 * server, which is a caller mistake rather than a connectivity fact.
 *
 * The project directory is read, never created: a declaration naming a tree
 * that is not there is a misconfiguration to report, and a probe that made an
 * empty directory would turn it into a run that compiles nothing. The output
 * directory is only reported — a build creates it — so its absence is a fact
 * about the machine, not a failure of the probe.
 * @param workspaceId - the owning project.
 * @param serverId - the server to probe.
 * @param signal - cancellation.
 * @returns the probe outcome.
 * @throws when the project declares no such server.
 */
async probe( workspaceId: string, serverId: string, signal?: AbortSignal, ): Promise<YxspecRemoteProbe>

/**
 * List the directories under one path on a server, for the wizard's directory picker.
 *
 * One round trip: `cd` into the requested directory (or the login directory when none was named),
 * print where that landed, and list the directories under it. The shell's own answer is the truth
 * here — home is whatever the login shell says it is, and a path that only resolves inside a
 * profile is still the one the operator means.
 *
 * An empty listing is an answer, not an exception: a directory with no children, a path that is
 * not there, and a client that refused to start are three states a picker renders differently, so
 * each comes back as `error` beside whatever the listing did produce. Nothing is stored and
 * nothing outside the named directory is read.
 * @param request - the destination, the directory to list, and optional client and budget.
 * @param signal - cancellation.
 * @returns the listing, with `error` set when it could not be produced.
 * @throws when the request names a directory that is not absolute, which is a caller mistake.
 */
async browse(request: YxspecRemoteBrowseRequest, signal?: AbortSignal): Promise<YxspecRemoteBrowse>

/**
 * Run one declared recipe in the declared project directory.
 *
 * A failed build is returned, not thrown: a compile error is the answer the
 * caller asked for, and what a failure *means* belongs to the flow's gate, not
 * to the transport. Only a transport-level impossibility (undeclared server or
 * recipe, no SSH client, a product path that could leave the output directory)
 * throws.
 * @param workspaceId - the owning project.
 * @param request - the server, recipe, and optional products to fetch back.
 * @param signal - cancellation.
 * @returns the run outcome, also recorded in the ledger.
 * @throws when the declaration is missing, the recipe is undeclared, or a fetch path is refused.
 */
async run( workspaceId: string, request: YxspecRemoteRunRequest, signal?: AbortSignal, ): Promise<YxspecRemoteRunResult>

/**
 * The recorded runs for one project, newest first.
 * @param workspaceId - the project to read.
 * @param limit - maximum entries to return.
 * @returns the stored run records.
 */
async runsFor(workspaceId: string, limit: number = 20): Promise<readonly RemoteRunRecord[]>

/**
 * The most recent run of one recipe that exited zero. The question a gate asks
 * before letting a later stage start.
 * @param workspaceId - the project to read.
 * @param serverId - the server the run targeted.
 * @param recipe - the recipe id.
 * @returns that run, or `undefined` when the recipe has never passed.
 */
async lastSuccess( workspaceId: string, serverId: string, recipe: string, ): Promise<RemoteRunRecord | undefined>
```

Source: [`packages/yxspec/yxspec-remote/src/index.ts`](../../packages/yxspec/yxspec-remote/src/index.ts)

<a id="ctxyxspecremotecontroller--yxspecremotecontroller"></a>

### `ctx.yxspecRemoteController` — `YxspecRemoteController`

Host service backing the generated `ctx.remote.yxspecRemote` namespace.

Mounted unconditionally by this package, but its data source is not: when `ctx.yxspecRemote` is absent the list is empty rather than an error. A wizard step asking "which build server?" shows its empty state, which is the truth on a deployment that mounts no remote plugin.

```ts cordis-catalog
/**
 * The build servers one project declared, as the client renders them.
 * @param workspaceId - the project whose declarations to list.
 * @returns the declared servers in declaration order; empty when the remote plugin is
 *   not mounted or the project declared none.
 */
@Remote async servers(workspaceId: string): Promise<YxspecRemoteServerView[]>

/**
 * List the directories under one path on a server, so the wizard can offer them.
 *
 * This is the one call on this surface that names a destination instead of a declaration, and it
 * has to be: the operator picks the directory *before* the declaration that would name it exists,
 * which is what turns "type the path from memory" into "connect and choose". Nothing is stored —
 * the answer is a listing, and the declaration written afterwards is where a choice becomes state.
 *
 * A host that cannot answer is an answer: an unreachable machine, a path that is not there, and a
 * directory with no children all come back as a listing whose `error` or emptiness says which.
 * Only a missing build-server service, or a path the service refuses, raises.
 * @param request - the destination to reach and the directory to list.
 * @returns the listing, with `error` set when it could not be produced.
 * @throws RemoteError when no build-server service is mounted, or the service refused the request.
 */
@Remote async browseServer(request: YxspecRemoteBrowseRequest): Promise<YxspecRemoteBrowse>

/**
 * Test one declared server and report what the build host answered.
 *
 * The wizard asks this when the operator wants to know whether the declaration they just wrote
 * reaches anything. The outcome is stored on the declaration by the service, so the row a list
 * renders afterwards describes this attempt without asking again — which is why the answer is
 * returned *and* persisted rather than only returned.
 *
 * An unreachable host is an answer, not a failure: it comes back as `reachable: false` with the
 * client's own words. Only a missing project id, a deployment that mounts no build-server
 * service, or a server this project never declared raises.
 * @param workspaceId - the project that declared the server.
 * @param serverId - the declaration to test.
 * @returns what the probe concluded.
 * @throws RemoteError when no project was named, no build-server service is mounted, or the
 *   project declares no such server.
 */
@Remote async probeServer(workspaceId: string, serverId: string): Promise<YxspecRemoteProbe>

/**
 * Declare or replace one build server from the onboarding wizard.
 *
 * Unlike {@link servers}, an absent seam is a failure rather than an empty answer: listing
 * nothing and declaring nothing look the same to a caller that swallows the difference, and
 * an operator who filled in a form and saw the row simply not appear would have no way to
 * tell a deployment that cannot store declarations from one that refused this one.
 *
 * The refusal path carries the service's own message. Validation belongs to the operation
 * that writes the record — `declare` runs it for this call exactly as it does for the tool —
 * so re-raising its reason as a typed fault is what keeps the wizard's report actionable
 * instead of a generic failure.
 * @param workspaceId - the project the declaration belongs to.
 * @param draft - the declaration the operator submitted.
 * @returns the stored declaration, projected as the list renders it.
 * @throws RemoteError when no project was named, no build-server service is mounted, or the
 *   service refused the declaration.
 */
@Remote async declareServer( workspaceId: string, draft: YxspecRemoteServerDraft, ): Promise<YxspecRemoteServerView>
```

Source: [`packages/yxspec/yxspec-api/src/remote.ts`](../../packages/yxspec/yxspec-api/src/remote.ts)

<a id="yxspec-events"></a>

### `yxspec/*` events

<a id="yxspecartifact-write--emit"></a>

#### `yxspec/artifact-write` — emit

An artifact write was observed in the workspace. Emitted only when `emitIntervalMs` is positive; the ledger answers queries regardless.

```ts cordis-catalog
/**
 * An artifact write was observed in the workspace. Emitted only when
 * `emitIntervalMs` is positive; the ledger answers queries regardless.
 * @param write - the observed write.
 * @mode emit
 */
'yxspec/artifact-write'(write: ArtifactWrite): void
```

Source: [`packages/yxspec/yxspec-artifact/src/index.ts`](../../packages/yxspec/yxspec-artifact/src/index.ts)

<a id="yxspecremote-run--emit"></a>

#### `yxspec/remote-run` — emit

A remote build run settled. Emitted after the ledger write, so a listener reading `runsFor` sees the run it was told about.

```ts cordis-catalog
/**
 * A remote build run settled. Emitted after the ledger write, so a listener
 * reading `runsFor` sees the run it was told about.
 * @param result - the settled run.
 * @param workspaceId - the project the run belongs to.
 * @mode emit
 */
'yxspec/remote-run'(result: YxspecRemoteRunResult, workspaceId: string): void
```

Source: [`packages/yxspec/yxspec-remote/src/index.ts`](../../packages/yxspec/yxspec-remote/src/index.ts)
<!-- END GENERATED cordis-surface -->
