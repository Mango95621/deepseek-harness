/**
 * YXSpec process panel, node half. Pure UI plugin: the empty `apply` exists so the plugin
 * appears in the host loader graph, while the browser half ships via `exports["./client"]`
 * and is discovered through the package's `dsh.client` declaration.
 */

/** Host plugin body — no host-side behaviour for this surface plugin. */
export function apply(): void {}
