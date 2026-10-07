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

/**
 * Run `callback(service)` as soon as `name` is available, and return a disposer.
 *
 * This matters because of plugin activation order: a plugin that declares no
 * `inject` may have `apply()` called **before** the service it needs has been
 * provided by another plugin's fiber. `ctx.get(name)` ("read a service from the
 * store without the inject requirement") returns `undefined` in that window —
 * it neither throws nor waits — so an apply-time service read silently does
 * nothing forever.
 *
 * `ctx.inject(deps, callback)` defers the callback until the dependency is
 * ready, which is the documented fix. When `inject` is unavailable (unit-test
 * doubles), the callback runs immediately against the current context.
 *
 * @param {*} ctx
 * @param {string} name
 * @param {(service: any) => (void | (() => void))} callback
 * @returns {() => void} disposer for both the registration and the fiber
 */
export function whenService(ctx, name, callback) {
  const run = (target) => {
    const service = serviceOf(target, name)
    if (service === undefined) return () => {}
    const dispose = callback(service)
    return typeof dispose === 'function' ? dispose : () => {}
  }

  if (ctx && typeof ctx.inject === 'function') {
    let inner = () => {}
    let handle
    try {
      handle = ctx.inject([name], (scoped) => {
        inner = run(scoped)
      })
    } catch {
      return run(ctx)
    }
    return () => {
      try {
        inner()
      } catch {
        /* teardown must not throw */
      }
      try {
        if (handle && typeof handle.dispose === 'function') handle.dispose()
        else if (typeof handle === 'function') handle()
      } catch {
        /* teardown must not throw */
      }
    }
  }

  return run(ctx)
}
