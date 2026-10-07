/**
 * Regression tests for plugin activation order.
 *
 * These reproduce the real failure observed in the live Host: a plugin that
 * declares no `inject` has `apply()` called before another plugin's service has
 * been provided. `ctx.get(name)` returns `undefined` in that window without
 * throwing, so an apply-time service read silently does nothing forever.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { serviceOf, whenService } from '../src/services.js'
import { registerStatusTool } from '../src/status-tool.js'
import { makeCtx, testConfig } from './helpers.js'

test('serviceOf: reports undefined for a service that is not yet provided', () => {
  const ctx = makeCtx({})
  assert.equal(serviceOf(ctx, 'tools'), undefined)
})

test('serviceOf: prefers ctx.get, then falls back to a property read', () => {
  assert.equal(serviceOf(makeCtx({ tools: { id: 'via-get' } }), 'tools').id, 'via-get')
  assert.equal(serviceOf({ tools: { id: 'via-property' } }, 'tools').id, 'via-property')
  assert.equal(serviceOf(undefined, 'tools'), undefined)
})

test('whenService: runs immediately when the service already exists', () => {
  const ctx = makeCtx({ tools: { marker: 1 } })
  let seen
  whenService(ctx, 'tools', (service) => {
    seen = service.marker
  })
  assert.equal(seen, 1)
})

test('whenService: defers until the service is provided (the apply-order fix)', () => {
  const deferred = []
  const ctx = {
    get: () => undefined,
    inject(deps, callback) {
      deferred.push({ deps, callback })
      return { dispose() {} }
    },
  }

  let registered = null
  whenService(ctx, 'tools', (tools) => {
    registered = tools.name
    return () => {}
  })

  assert.equal(registered, null, 'must not register before the service exists')
  assert.equal(deferred.length, 1)
  assert.deepEqual(deferred[0].deps, ['tools'], 'the dependency must be declared')

  // Cordis now provides the service and runs the deferred callback.
  deferred[0].callback({ get: () => ({ name: 'tools' }) })
  assert.equal(registered, 'tools')
})

test('whenService: without ctx.inject it attempts immediately and never throws', () => {
  const ctx = makeCtx({})
  let called = false
  const dispose = whenService(ctx, 'tools', () => {
    called = true
  })
  assert.equal(called, false)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('status tool: registers even when the tool registry is not yet provided', () => {
  const deferred = []
  const ctx = {
    get: () => undefined,
    inject(deps, callback) {
      deferred.push(callback)
      return { dispose() {} }
    },
  }
  const deps = {
    resolveRoleFor: () => ({ role: 'default', source: 'test', policy: { tokenBudget: 4000 } }),
    ownedTasksFor: () => [],
  }

  registerStatusTool(ctx, testConfig(), deps)
  assert.equal(deferred.length, 1, 'registration must be deferred, not dropped')

  const registered = []
  deferred[0]({
    get: () => ({
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    }),
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'role_orchestrator_status')
})

test('status tool: a service without register() is tolerated', () => {
  const ctx = makeCtx({ tools: {} })
  assert.doesNotThrow(() =>
    registerStatusTool(ctx, testConfig(), {
      resolveRoleFor: () => ({ role: 'default', source: 't', policy: {} }),
      ownedTasksFor: () => [],
    }),
  )
})
