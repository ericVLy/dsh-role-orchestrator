/**
 * Wiring smoke test: `apply()` must compose every module against a realistic
 * context and return a working disposer. Unit tests cover each module in
 * isolation, so this is the test that catches a broken deps hand-off, a missing
 * import, or a registration that silently no-ops.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../index.js'
import { makeCtx } from './helpers.js'

function pluginCtx() {
  const registered = []
  const guards = []
  const ctx = makeCtx({
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    agentTeams: {
      listTasks: () => [],
      tryMembership: () => undefined,
      getTask: () => {
        throw new Error('not a member')
      },
    },
  })
  return { ctx, registered, guards }
}

test('plugin: exposes a stable name', () => {
  assert.equal(name, 'role-orchestrator')
})

test('plugin: apply() registers every seam and returns a disposer', () => {
  const { ctx, registered } = pluginCtx()
  const dispose = apply(ctx, { orchestration: { rolePool: ['验证Agent'] } })

  assert.equal(typeof dispose, 'function')
  for (const event of [
    'agent/created',
    'agent/disposed',
    'agent/pre-step',
    'tools/pre-execute',
    'tools/post-execute',
  ]) {
    assert.ok((ctx.handlers.get(event)?.length ?? 0) > 0, `${event} should have a listener`)
  }

  const names = registered.map((entry) => entry.name).sort()
  assert.deepEqual(names, ['role-status', 'role_orchestrator_status'])
  assert.ok(ctx.logs.some((line) => line.startsWith('info:')), 'apply logs an activation line')
})

test('plugin: the disposer unregisters everything it registered', () => {
  const { ctx } = pluginCtx()
  const dispose = apply(ctx, {})
  dispose()
  for (const event of [
    'agent/created',
    'agent/disposed',
    'agent/pre-step',
    'tools/pre-execute',
    'tools/post-execute',
  ]) {
    assert.equal(ctx.handlers.get(event)?.length ?? 0, 0, `${event} listener should be removed`)
  }
})

test('plugin: an invalid config warns instead of throwing', () => {
  const { ctx } = pluginCtx()
  const dispose = apply(ctx, 'nonsense')
  assert.ok(ctx.logs.some((line) => line.includes('must be an object')))
  assert.doesNotThrow(() => dispose())
})

test('plugin: works with no optional service at all (no Agent Teams in profile)', () => {
  const ctx = makeCtx({ tools: { register: () => () => {}, guard: () => () => {} } })
  const dispose = apply(ctx, undefined)
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('plugin: a pool assignment flows through to the resolved role', async () => {
  const { ctx, registered } = pluginCtx()
  apply(ctx, { orchestration: { rolePool: ['验证Agent'] } })

  const agent = { id: 'a1' }
  // `agent/created` is what performs the assignment.
  const created = ctx.handlers.get('agent/created')[0]
  await created({ agent })

  const command = registered.find((entry) => entry.name === 'role-status')
  const result = command.handler({ agent })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /role "验证Agent"/)
  assert.match(result.text, /source: orchestration/)
  assert.match(result.text, /orchestration  : enabled/)
})
