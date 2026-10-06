/**
 * Minimal Cordis-context double for unit-testing waterfall listeners without a
 * live Host. It reproduces only what the modules use: `on` (returning a
 * disposer), `get`, `logger`, and waterfall listener composition.
 */

import { normalizeConfig } from '../src/config.js'

export function makeCtx(services = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map()
  const logs = []
  const disposers = []
  const guards = []

  const ctx = {
    handlers,
    logs,
    guards,
    disposers,
    services,
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      const dispose = () => {
        handlers.set(name, (handlers.get(name) ?? []).filter((entry) => entry !== fn))
      }
      disposers.push(dispose)
      return dispose
    },
    get(name) {
      return services[name]
    },
    logger: {
      info: (message) => logs.push(`info:${message}`),
      warn: (message) => logs.push(`warn:${message}`),
    },
  }
  return ctx
}

/**
 * Dispatch a waterfall event through the registered listeners.
 * @param {*} ctx
 * @param {string} name
 * @param {unknown[]} args listener arguments before `next`
 * @param {unknown} terminal value returned by the terminating `next()`
 */
export async function fire(ctx, name, args = [], terminal = undefined) {
  const list = ctx.handlers.get(name) ?? []
  const run = (index) => {
    const fn = list[index]
    if (!fn) return Promise.resolve(terminal)
    return Promise.resolve(fn(...args, () => run(index + 1)))
  }
  return run(0)
}

/** Build a normalized config from partial raw sections. */
export function testConfig(overrides = {}) {
  return normalizeConfig(overrides).config
}

/** A `tools` service double that records guard registrations. */
export function fakeTools(ctx) {
  return {
    guard(fn) {
      ctx.guards.push(fn)
      const dispose = () => {
        const index = ctx.guards.indexOf(fn)
        if (index >= 0) ctx.guards.splice(index, 1)
      }
      return dispose
    },
    restrict(filter) {
      ctx.restrictions = ctx.restrictions ?? []
      ctx.restrictions.push(filter)
      return () => {
        ctx.restrictions = ctx.restrictions.filter((entry) => entry !== filter)
      }
    },
  }
}
