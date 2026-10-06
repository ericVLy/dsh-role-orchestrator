/**
 * Safe optional-service access.
 *
 * The verified Service access contract is:
 *   optional:       `ctx.get("approval")` — returns `undefined`, no throw
 *   hardDependency: `ctx.approval`        — requires `inject: ['approval']`
 *
 * This plugin declares no `inject`, so every service is optional here and must
 * be read through the non-throwing accessor. A bare property read for a service
 * that was never mounted is not safe, and a throwing read inside a
 * `tools/pre-execute` or `agent/pre-step` listener would break tool dispatch or
 * step entry.
 *
 * @param {*} ctx
 * @param {string} name
 * @returns {any | undefined}
 */
export function serviceOf(ctx, name) {
  if (!ctx) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined) return viaGet
    } catch {
      /* fall through to the property probe */
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}
