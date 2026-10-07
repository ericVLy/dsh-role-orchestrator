import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createOrchestrationState,
  registerOrchestration,
  requiredRoleFor,
  reservedTaskHints,
  roleFromMarkers,
} from '../src/orchestration.js'
import { registerTaskGuard } from '../src/task-guard.js'
import { registerContextCompressor } from '../src/context-compressor.js'
import { buildRoleTable, policyFor } from '../src/roles.js'
import { makeCtx, fire, testConfig } from './helpers.js'

const table = buildRoleTable({})
const roleDeps = (role) => ({
  resolveRoleFor: () => ({ role, source: 'test', policy: policyFor(table, role, 4000) }),
})

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

test('state: assign, release and role-taken tracking stay consistent', () => {
  const state = createOrchestrationState()
  assert.equal(state.roleOf('a1'), undefined)

  state.assign('a1', '验证Agent')
  assert.equal(state.roleOf('a1'), '验证Agent')
  assert.equal(state.isRoleTaken('验证Agent'), true)
  assert.deepEqual(state.assignments(), [{ agentId: 'a1', role: '验证Agent' }])

  // Re-assigning releases the previous role.
  state.assign('a1', '审查Agent')
  assert.equal(state.isRoleTaken('验证Agent'), false)
  assert.equal(state.isRoleTaken('审查Agent'), true)

  assert.equal(state.release('a1'), '审查Agent')
  assert.equal(state.roleOf('a1'), undefined)
  assert.equal(state.isRoleTaken('审查Agent'), false)
  assert.equal(state.release('a1'), undefined)
})

test('state: reservations are keyed by task id and readable', () => {
  const state = createOrchestrationState()
  assert.equal(state.reserve('t1', '验证Agent'), '验证Agent')
  assert.equal(state.reservationFor('t1'), '验证Agent')
  assert.equal(state.reservationFor('t2'), undefined)
  assert.deepEqual(state.reservations(), [['t1', '验证Agent']])
  assert.equal(state.reserve('', 'x'), undefined, 'empty ids are ignored')
})

test('assigning the same role twice is idempotent', () => {
  const state = createOrchestrationState()
  state.assign('a1', 'r')
  state.assign('a1', 'r')
  assert.deepEqual(state.assignments(), [{ agentId: 'a1', role: 'r' }])
})

// ---------------------------------------------------------------------------
// Marker parsing
// ---------------------------------------------------------------------------

test('markers: parses [role:X] case-insensitively and ignores other text', () => {
  const section = testConfig().orchestration
  assert.equal(roleFromMarkers(section, 'Fix the bug [role:验证Agent]'), '验证Agent')
  assert.equal(roleFromMarkers(section, '[ROLE:审查Agent] review'), '审查Agent')
  assert.equal(roleFromMarkers(section, 'no marker here'), undefined)
  assert.equal(roleFromMarkers(section, undefined, 'second [role:r2]'), 'r2')
})

test('markers: can be disabled and customised', () => {
  const off = { ...testConfig().orchestration, reserveFromMarkers: false }
  assert.equal(roleFromMarkers(off, '[role:验证Agent]'), undefined)

  const custom = { ...testConfig().orchestration, markerPattern: '<<([a-z]+)>>' }
  assert.equal(roleFromMarkers(custom, 'do it <<reviewer>>'), 'reviewer')
})

test('markers: an invalid pattern falls back to the default instead of throwing', () => {
  const broken = { ...testConfig().orchestration, markerPattern: '([unclosed' }
  assert.equal(roleFromMarkers(broken, '[role:验证Agent]'), '验证Agent')
})

// ---------------------------------------------------------------------------
// Reservation precedence
// ---------------------------------------------------------------------------

test('requiredRoleFor: observed > orchestration config > legacy config > marker > field', () => {
  const state = createOrchestrationState()
  const config = testConfig()
  const task = { id: 't1', subject: 'x [role:from-marker]', requiredRole: 'from-field' }

  assert.equal(requiredRoleFor(state, config, task), 'from-marker', 'marker beats the plain field')

  config.orchestration.taskReservations = { t1: 'from-orch-config' }
  assert.equal(requiredRoleFor(state, config, task), 'from-orch-config')

  config.taskGuard.roleReservations = { t1: 'from-legacy-config' }
  assert.equal(requiredRoleFor(state, config, task), 'from-orch-config', 'orchestration wins over legacy')

  state.reserve('t1', 'from-observation')
  assert.equal(requiredRoleFor(state, config, task), 'from-observation', 'an observed reservation wins')
})

test('requiredRoleFor: undefined for an unreserved task and for junk input', () => {
  const state = createOrchestrationState()
  const config = testConfig()
  assert.equal(requiredRoleFor(state, config, { id: 't9', subject: 'plain' }), undefined)
  assert.equal(requiredRoleFor(state, config, undefined), undefined)
  assert.equal(requiredRoleFor(state, config, 'nope'), undefined)
})

test('reservedTaskHints: open tasks only, filtered by role', () => {
  const state = createOrchestrationState()
  const config = testConfig()
  const tasks = [
    { id: 't1', subject: 'a', description: '[role:验证Agent]' },
    { id: 't2', subject: 'b', description: '[role:审查Agent]' },
    { id: 't3', subject: 'c', description: '[role:验证Agent]', status: 'completed' },
    { id: 't4', subject: 'd', description: '[role:验证Agent]', status: 'deleted' },
  ]
  const hints = reservedTaskHints(state, config, '验证Agent', tasks)
  assert.deepEqual(hints.map((task) => task.id), ['t1'])
})

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function orchestrationCtx(services = {}) {
  return makeCtx({
    agentTeams: { tryMembership: () => ({ role: 'teammate' }) },
    ...services,
  })
}

test('registration: a configured role is recorded on agent/created', () => {
  const ctx = orchestrationCtx()
  const state = createOrchestrationState()
  registerOrchestration(ctx, testConfig(), { state, explicitRoleFor: () => '验证Agent' })

  return fire(ctx, 'agent/created', [{ agent: { id: 'a1' } }]).then(() => {
    assert.equal(state.roleOf('a1'), '验证Agent')
  })
})

test('registration: pool assignment hands out the first free role, one per agent', async () => {
  const ctx = orchestrationCtx()
  const state = createOrchestrationState()
  const config = testConfig({ orchestration: { rolePool: ['验证Agent', '审查Agent'] } })
  registerOrchestration(ctx, config, { state, explicitRoleFor: () => undefined })

  await fire(ctx, 'agent/created', [{ agent: { id: 'a1' } }])
  await fire(ctx, 'agent/created', [{ agent: { id: 'a2' } }])
  await fire(ctx, 'agent/created', [{ agent: { id: 'a3' } }])

  assert.equal(state.roleOf('a1'), '验证Agent')
  assert.equal(state.roleOf('a2'), '审查Agent')
  assert.equal(state.roleOf('a3'), undefined, 'the pool is exhausted, so nothing is assigned')
})

test('registration: the Lead is skipped unless assignToLead is set', async () => {
  const services = { agentTeams: { tryMembership: () => ({ role: 'lead' }) } }
  const config = testConfig({ orchestration: { rolePool: ['验证Agent'] } })

  const skipped = createOrchestrationState()
  const ctx = orchestrationCtx(services)
  registerOrchestration(ctx, config, { state: skipped, explicitRoleFor: () => undefined })
  await fire(ctx, 'agent/created', [{ agent: { id: 'lead' } }])
  assert.equal(skipped.roleOf('lead'), undefined, 'the Lead is not a pool member by default')

  const allowed = createOrchestrationState()
  const ctx2 = orchestrationCtx(services)
  registerOrchestration(
    ctx2,
    testConfig({ orchestration: { rolePool: ['验证Agent'], assignToLead: true } }),
    { state: allowed, explicitRoleFor: () => undefined },
  )
  await fire(ctx2, 'agent/created', [{ agent: { id: 'lead' } }])
  assert.equal(allowed.roleOf('lead'), '验证Agent')
})

test('registration: agent/disposed releases the role', async () => {
  const ctx = orchestrationCtx()
  const state = createOrchestrationState()
  registerOrchestration(ctx, testConfig(), { state, explicitRoleFor: () => '验证Agent' })

  await fire(ctx, 'agent/created', [{ agent: { id: 'a1' } }])
  await fire(ctx, 'agent/disposed', [{ agent: { id: 'a1' } }])
  assert.equal(state.roleOf('a1'), undefined)
})

test('registration: a created task with a marker is reserved by observation', async () => {
  const ctx = orchestrationCtx()
  const state = createOrchestrationState()
  registerOrchestration(ctx, testConfig(), { state, explicitRoleFor: () => undefined })

  const exec = { name: 'team_task_create' }
  const result = { isError: false, value: { id: 't7', subject: 'Audit [role:审查Agent]' } }
  const decision = await fire(ctx, 'tools/post-execute', [exec, result], 'PASSTHROUGH')

  assert.equal(decision, 'PASSTHROUGH', "the guard must not alter next()'s decision")
  assert.equal(state.reservationFor('t7'), '审查Agent')
})

test('registration: post-execute ignores errors, other tools and unmarked tasks', async () => {
  const ctx = orchestrationCtx()
  const state = createOrchestrationState()
  registerOrchestration(ctx, testConfig(), { state, explicitRoleFor: () => undefined })

  await fire(ctx, 'tools/post-execute', [{ name: 'team_task_create' }, { isError: true, value: { id: 't1', subject: '[role:x]' } }], 'D')
  await fire(ctx, 'tools/post-execute', [{ name: 'read' }, { isError: false, value: { id: 't2', subject: '[role:x]' } }], 'D')
  await fire(ctx, 'tools/post-execute', [{ name: 'team_task_create' }, { isError: false, value: { id: 't3', subject: 'plain' } }], 'D')

  assert.deepEqual(state.reservations(), [])
})

test('registration: disabling orchestration registers no listeners', () => {
  const ctx = orchestrationCtx()
  const dispose = registerOrchestration(ctx, testConfig({ orchestration: { enabled: false } }), {
    state: createOrchestrationState(),
    explicitRoleFor: () => undefined,
  })
  assert.equal(ctx.handlers.get('agent/created'), undefined)
  assert.equal(ctx.handlers.get('tools/post-execute'), undefined)
  assert.doesNotThrow(() => dispose())
})

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

test('integration: a marker reservation denies the wrong role at claim time', async () => {
  const ctx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, status: 'pending', subject: 'Audit [role:审查Agent]' }),
      listTasks: () => [],
    },
  })
  const state = createOrchestrationState()
  const config = testConfig()

  registerTaskGuard(ctx, config, {
    ...roleDeps('文献检索Agent'),
    requiredRoleFor: (task) => requiredRoleFor(state, config, task),
  })

  const exec = {
    name: 'team_task_update',
    arguments: { task_id: 't1', expected_revision: 1, action: 'claim' },
    agent: { id: 's1', name: 'bob' },
  }
  const decision = await fire(ctx, 'tools/pre-execute', [exec], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /reserved for role "审查Agent"/)

  // The matching role is allowed through.
  const okCtx = makeCtx({
    agentTeams: {
      getTask: () => ({ id: 't1', revision: 1, status: 'pending', subject: 'Audit [role:审查Agent]' }),
      listTasks: () => [],
    },
  })
  registerTaskGuard(okCtx, config, {
    ...roleDeps('审查Agent'),
    requiredRoleFor: (task) => requiredRoleFor(state, config, task),
  })
  assert.equal(await fire(okCtx, 'tools/pre-execute', [exec], 'ALLOWED'), 'ALLOWED')
})

test('integration: reserved tasks are advertised in the role context section', async () => {
  const ctx = makeCtx()
  const captured = { sections: [] }
  const agent = {
    id: 's1',
    name: '验证Agent',
    ctx: {
      get(name) {
        if (name === 'systemPrompt') {
          return {
            section(section) {
              captured.sections.push(section)
              return () => {}
            },
          }
        }
        if (name === 'agentTeams') return { listTasks: () => [] }
        return undefined
      },
    },
  }

  registerContextCompressor(ctx, testConfig(), {
    ...roleDeps('验证Agent'),
    taskHintsFor: () => [{ id: 't4', subject: 'Reproduce the claim' }],
  })

  await fire(ctx, 'agent/created', [{ agent }])
  const text = captured.sections[0].text()
  assert.match(text, /Tasks reserved for your role/)
  assert.match(text, /t4: Reproduce the claim/)
})

test('integration: no hints means no extra section text', async () => {
  const ctx = makeCtx()
  const captured = { sections: [] }
  const agent = {
    id: 's2',
    name: '验证Agent',
    ctx: {
      get(name) {
        if (name === 'systemPrompt') {
          return {
            section(section) {
              captured.sections.push(section)
              return () => {}
            },
          }
        }
        return undefined
      },
    },
  }

  registerContextCompressor(ctx, testConfig(), {
    ...roleDeps('验证Agent'),
    taskHintsFor: () => [],
  })

  await fire(ctx, 'agent/created', [{ agent }])
  assert.doesNotMatch(captured.sections[0].text(), /Tasks reserved for your role/)
})
