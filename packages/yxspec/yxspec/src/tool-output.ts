/**
 * The canonical output contract for every YXSpec tool that returns a JSON record.
 *
 * `yxspec_status`/`yxspec_next` in `@deepseek-ai/dsh-yxspec-step` and the three
 * build-server tools in `@deepseek-ai/dsh-yxspec-remote/tools` all report
 * structured data rather than prose, and none of them owns a presentation card
 * of its own. They therefore share one contract: an open object, rendered as
 * pretty-printed JSON. Declaring it once is what keeps the five tools agreeing
 * on the shape the model sees — five copies would let a later edit to one tool
 * silently change only that tool's rendering.
 *
 * This is a subpath rather than part of the entry because a plugin entry may
 * export only what the Loader loads (see `docs/defensive-patterns/package-surface.md`),
 * and a subpath rather than `./project` because the two answer unrelated
 * questions: one is a predicate over the tree, this is a model-facing contract.
 * It imports nothing, so a tool package depends on it without also depending on
 * the domain service.
 * @module @deepseek-ai/dsh-yxspec/tool-output
 */

/**
 * The shared output declaration: an open object rendered as indented JSON.
 *
 * The schema stays a literal with no `ToolOutputDefinition` annotation on
 * purpose. `defineTool` infers each tool's declared result type from this node,
 * and that interface's own `schema` is the *compiled* JSON Schema — not a node
 * the author-facing DSL accepts — so annotating with it would erase every
 * caller's inference to `never`. `as const` is what pins `type`/`additionalProperties`
 * to their literal spellings, which is what the DSL's own `ValueSchemaSpec`
 * requires.
 */
export const JSON_TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true } as const,
  render(_args: unknown, value: unknown) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) } as const]
  },
}
