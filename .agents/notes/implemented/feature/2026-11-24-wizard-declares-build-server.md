# Agent Note: The onboarding wizard declares build servers through the service that owns them

Status: implemented

English | [中文](2026-11-24-wizard-declares-build-server.zh.md)

## Problem

The wizard's fourth step showed the build servers a project had declared and offered two ways to leave it — "skip server setup" and "next" — which called the same completion. The card invited the operator to look for a difference that did not exist, and the button that named the step's real question was the one that read like an escape hatch.

An operator who reached the step with nothing declared could not declare anything there. The copy told them to ask an agent for a `remote_server_declare` call — in a Conversation the gate was withholding, since the gate withholds exactly the surface the tool is reached through. A walk whose fourth question can only be answered by leaving the walk is not a walk.

`@deepseek-ai/dsh-yxspec-api` documented the step as read-only: "a UI that could write a declaration directly would be a second, unvalidated path into durable state". That reasoning names the real hazard — a client-side writer that constructs the record itself — but it does not follow that the wizard may not declare at all, only that a declaration must travel the one path that validates it.

## Decision

`yxspecRemote.declareServer(workspaceId, draft)` accepts a declaration from the browser and forwards it to `ctx.yxspecRemote.declare`, the same service method `remote_server_declare` calls. One service method, two front doors: the record's type, its validation, and its durable write stay in `@deepseek-ai/dsh-yxspec-remote`, and neither door admits a declaration the other refuses. The alternative reading of "one path" — a controller that re-implements `validateServer` — would have made two validators that could disagree, which is the failure the original stance was protecting against.

The draft is a separate wire type rather than the service's own server interface, because the two differ in exactly one place: `recipes` is an ordered list on the wire and an id-keyed map in the record. The form that fills it is a list of rows, and a map would give a repeated id nowhere to live — the second row would silently overwrite the first while both stayed on screen. `declareServer` performs that conversion, and the host resolves the optional fields rather than the form: a blank label becomes the id, an omitted timeout the 900000 ms default, a blank recipe `outputDirectory` stays absent (so the run resolves the default per recipe rather than storing a stale copy of it), a blank `sshExecutable` stays absent, a repeated recipe id keeps the last command — each of which is what the tool path already does. Resolving them in one place is what keeps the wizard and the tool agreeing about what an unspecified field means.

Two failures are typed rather than silent, because a write that landed nowhere must not look like one that landed. `yxspecRemote/service-unavailable` reports a deployment that mounts no build-server service, and `yxspecRemote/rejected` carries the service's own message, which the wizard renders over the still-open form so the operator corrects the field the host named instead of retyping the declaration. `servers` keeps the opposite behavior — an absent seam reads as "none declared" — because a list that finds nothing may say so, and a form the operator just filled in may not.

The wizard's step carries the form, and forward is one control whose label follows the state: "skip server setup" while nothing is declared, "next" once something is. Declaring nothing and continuing is one act either way; the label is the only thing the state changes. The step reads its list back from the host after each write instead of appending what was typed, so a re-declaration under an existing id replaces its row, and the summary step reads the declaration back too: a confirmation that recited the form would confirm a server the host may not hold.

Advancing the ASPICE pointer stays a tool call through the gate. A declaration is not a process step — it describes where the project compiles, it is not evidence of a stage, and the `yxspec` namespace still publishes no write. The surface's second write is a connection test's outcome: `probeServer` runs the seam's existing probe and stores what it found on the declaration, so a list rendered afterwards describes the last attempt rather than the last success. The step tests a declaration once as soon as it lands and offers the control per row; the status is read back from the host, which is why a reload and a second browser agree.

The connection is two fields rather than one destination: the operator names the user they log in as and the machine to reach, and the form joins them into the OpenSSH destination the record and the service take. A person assembling `user@host` by hand is being asked to get a syntax right for a tool they are not running, and half of it — a user with no host — is refused rather than sent.

The compile directory is chosen rather than typed: `browseServer` lists a directory over the same SSH client the runs will use, starting at the login directory, and the operator descends by clicking. Typing it was the field operators got wrong — the share they browse their tree through and the path that machine sees are different strings — and connecting first settles both questions at once, since the connection that proves the destination is also the one that can show what is on the other side. A listing is not state: nothing is stored until the declaration is written.

## Alternatives considered

**Keep the step read-only and keep pointing at the tool.** This is the status quo the Problem describes: the gate withholds the Conversation, so the instruction sends the operator out of the walk to answer one of its five questions. It also leaves the two-button problem, since both controls would still complete the step identically.

**Let the client write the durable record directly.** The controller would construct the record and either duplicate `validateServer` in the browser or drop it; the durable table's zod schema is the last line, and it would report a mistyped declaration as a storage failure rather than as a field to fix.

**Have the wizard send a prefilled prompt to the Conversation instead of writing.** A model round trip for a form the operator is already looking at, and it needs a Session the gate is deliberately withholding — the same reason the tool cannot be the answer.

**Make `declareServer` take the service's own server interface.** No conversion, no second type — and a recipe map on the wire, which loses the row order the form renders and hides the duplicate id the operator typed.

**Probe the server from the step, so "declared" means "reachable".** Reachability needs the credentials path and a network round trip, and the wizard recording "answered" rather than "reachable" is what keeps a blank home's first paint free of a network wait. A run is the only caller that has to reach the server.

## Consequences

- The `yxspecRemote` namespace is no longer uniformly read-only. The package README states which single write it carries and why that write is not a process step, so the removed claim cannot be restored by reading the old rationale.
- A declaration made in the wizard is indistinguishable in the record from one made by an agent: same table, same key, same fields, and no author — records carry `declaredAt`, not who wrote them. Two front doors onto one service method is what makes that true rather than a hope.
- The wizard can now produce a declaration that no run has ever used. The step's copy says the server compiles pushed source; only `remote_build` proves it does, and the summary step's server line reports what is declared rather than what is proven.
- The step's declaration list, summary line, and form copy are locale-owned: six new dictionaries' worth of strings, including placeholders and the field labels, so a deployment that translates the wizard translates the form with it.
