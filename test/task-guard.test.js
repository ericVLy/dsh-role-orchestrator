import test from 'node:test'
import assert from 'node:assert/strict'

import { registerTaskGuard } from '../src/task-guard.js'
import { makeCtx, fire, testConfig, fakeTools } from './helpers.js'

const deps = { resolveRoleFor: () => ({ role: 'default', source: 'test' }) }

function claims(exec = {}) {
  return { name: 'team_task_update', arguments: { task_id: 't1', expected_revision: 1, action: 'claim' }, agent: { id: 's1', name: 'bob' }, ...exec }
}

test('guard: claiming a task owned by another member is denied with the owner named', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, status: 'in_progress', ownerName: 'alice', writeScopes: [] }),
      listTasks: () => [],
    },
  })
  registerTaskGuard(ctx, testConfig(), deps)
  const decision = await fire(ctx, 'tools/pre-execute', [claims()], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /already owned by "alice"/)
  assert.match(decision.reason, /exactly one owner/)
})

test('guard: an unowned task and an already-owned-by-me task both pass', async () => {
  for (const task of [
    { id: 't1', revision: 1, status: 'pending' },
    { id: 't1', revision: 1, status: 'in_progress', ownerName: 'bob' },
  ]) {
    const ctx = makeCtx({ agentTeams: { getTask: () => task, listTasks: () => [] } })
    registerTaskGuard(ctx, testConfig(), deps)
    assert.equal(await fire(ctx, 'tools/pre-execute', [claims()], 'ALLOWED'), 'ALLOWED')
  }
})

test('guard: only claim actions are policed', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, ownerName: 'alice' }),
      listTasks: () => [],
    },
  })
  registerTaskGuard(ctx, testConfig(), deps)
  const complete = claims({ arguments: { task_id: 't1', expected_revision: 1, action: 'complete' } })
  assert.equal(await fire(ctx, 'tools/pre-execute', [complete], 'ALLOWED'), 'ALLOWED')
})

test('guard: unrelated tools are ignored', async () => {
  const ctx = makeCtx({ agentTeams: { getTask: () => { throw new Error('must not be called') } } })
  registerTaskGuard(ctx, testConfig(), deps)
  assert.equal(await fire(ctx, 'tools/pre-execute', [claims({ name: 'pwsh' })], 'ALLOWED'), 'ALLOWED')
})

test('guard: write-scope overlap with another in-progress task is denied', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 2, status: 'pending', writeScopes: ['src'] }),
      listTasks: () => [{ id: 't2', status: 'in_progress', writeScopes: ['src/a.js'], ownerName: 'carol' }],
    },
  })
  registerTaskGuard(ctx, testConfig(), deps)
  const decision = await fire(ctx, 'tools/pre-execute', [claims({ arguments: { task_id: 't1', expected_revision: 2, action: 'claim' } })], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /write scope "src"/)
})

test('guard: stale revision denies only in strict mode', async () => {
  const services = {
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 7, status: 'pending' }),
      listTasks: () => [],
    },
  }
  const lax = makeCtx(services)
  registerTaskGuard(lax, testConfig(), deps)
  assert.equal(await fire(lax, 'tools/pre-execute', [claims()], 'ALLOWED'), 'ALLOWED')

  const strict = makeCtx(services)
  registerTaskGuard(strict, testConfig({ taskGuard: { strict: true } }), deps)
  const decision = await fire(strict, 'tools/pre-execute', [claims()], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /revision 1 is stale/)
})

test('guard: strict mode also registers an order-independent tools.guard()', async () => {
  const services = {
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, status: 'in_progress', ownerName: 'alice' }),
      listTasks: () => [],
    },
  }
  const ctx = makeCtx(services)
  ctx.get = (name) => (name === 'tools' ? fakeTools(ctx) : services[name])
  registerTaskGuard(ctx, testConfig({ taskGuard: { strict: true } }), deps)

  assert.equal(ctx.guards.length, 1)
  const reason = ctx.guards[0](claims())
  assert.match(reason, /single-owner invariant/)
  // Non-claim tools and unowned tasks pass the guard.
  assert.equal(ctx.guards[0](claims({ name: 'read' })), undefined)
})

test('guard: unknown task ids never throw out of the listener', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => { throw new Error('TEAM_TASK_NOT_FOUND') },
      listTasks: () => [],
    },
  })
  registerTaskGuard(ctx, testConfig(), deps)
  assert.equal(await fire(ctx, 'tools/pre-execute', [claims()], 'ALLOWED'), 'ALLOWED')
})

test('guard: role reservations bind a task to one role', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, status: 'pending' }),
      listTasks: () => [],
    },
  })
  registerTaskGuard(
    ctx,
    testConfig({ taskGuard: { roleReservations: { t1: '验证Agent' } } }),
    { resolveRoleFor: () => ({ role: '文献检索Agent', source: 'test' }) },
  )
  const decision = await fire(ctx, 'tools/pre-execute', [claims()], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /reserved for role "验证Agent"/)
})
