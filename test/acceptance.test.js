/**
 * Phase 3 — end-to-end acceptance suite.
 *
 * This drives the REAL modules through `apply()` (not each module in isolation)
 * against a simulated Host, and it models the one piece of the framework the
 * plugin depends on but does not own: the task ledger's transactional
 * compare-and-set.
 *
 * The CAS is modelled on the verified built-in implementation
 * (`dsh-experimental-agent-team`): a per-team promise-chain lock, a revision
 * precondition, and the `TEAM_TASK_STALE_REVISION` / `TEAM_TASK_ALREADY_CLAIMED`
 * rejections. Testing concurrent claims against this model verifies that the
 * plugin's added policy never lets two agents through, rather than re-testing
 * the framework's own guarantee (which is established by reading its source —
 * see CORRECTIONS.md F-6).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'
import { estimateTokens } from '../src/token-budget.js'
import { makeCtx, fire, fireAll } from './helpers.js'

// ---------------------------------------------------------------------------
// Simulated task ledger with the framework's transactional CAS semantics
// ---------------------------------------------------------------------------

function createTaskLedger() {
  const tasks = new Map()
  const members = new Map()
  let seq = 0
  /** per-team promise chain — the in-process lock `withTeamLock` provides */
  let chain = Promise.resolve()

  const withLock = (fn) => {
    const run = chain.then(() => fn())
    chain = run.then(
      () => {},
      () => {},
    )
    return run
  }

  const project = (task) => ({
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ...(task.ownerId === undefined ? {} : { ownerName: members.get(task.ownerId) ?? task.ownerId }),
    ready: true,
    writeScopeWarnings: [],
  })

  const fail = (code, message) => {
    const error = new Error(message)
    error.code = code
    return error
  }

  return {
    addMember(agent) {
      members.set(agent.id, agent.name ?? agent.id)
    },

    createTask({ subject = '', description = '', writeScopes = [] } = {}) {
      seq += 1
      const task = {
        id: `t${seq}`,
        revision: 1,
        subject,
        description,
        status: 'pending',
        blockedBy: [],
        writeScopes,
        ownerId: undefined,
      }
      tasks.set(task.id, task)
      return project(task)
    },

    getTask(_caller, id) {
      const task = tasks.get(id)
      if (task === undefined) throw fail('TEAM_TASK_NOT_FOUND', `team task "${id}" not found`)
      return project(task)
    },

    listTasks() {
      return [...tasks.values()].filter((task) => task.status !== 'deleted').map(project)
    },

    tryMembership(agent) {
      return { role: agent?.membershipRole ?? 'teammate' }
    },

    /** Mirrors `agentTeams.updateTask`: lock → revision check → authorize → apply. */
    updateTask(caller, request) {
      return withLock(() => {
        const task = tasks.get(request.taskId)
        if (task === undefined) throw fail('TEAM_TASK_NOT_FOUND', `team task "${request.taskId}" not found`)
        if (task.revision !== request.expectedRevision) {
          throw fail(
            'TEAM_TASK_STALE_REVISION',
            `stale team task "${task.id}" revision ${request.expectedRevision}; current revision is ${task.revision}`,
          )
        }
        switch (request.action) {
          case 'claim':
            if (task.ownerId !== undefined && task.ownerId !== caller.id) {
              throw fail('TEAM_TASK_ALREADY_CLAIMED', `team task "${task.id}" is owned by another member`)
            }
            if (task.status !== 'pending') {
              throw fail('TEAM_TASK_BLOCKED', `team task "${task.id}" is not ready to claim`)
            }
            task.status = 'in_progress'
            task.ownerId = caller.id
            break
          case 'complete':
            task.status = 'completed'
            break
          default:
            throw fail('TEAM_TASK_INVALID_TRANSITION', `unsupported action ${request.action}`)
        }
        task.revision += 1
        return project(task)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Host double
// ---------------------------------------------------------------------------

function createSystemPromptCapture() {
  const sections = []
  return {
    sections,
    service: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      context(entry) {
        sections.push(entry)
        return () => {}
      },
    },
  }
}

function createHarness(rawConfig) {
  const ledger = createTaskLedger()
  const registered = []
  const prompts = new Map()

  const ctx = makeCtx({
    agentTeams: ledger,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard() {
        return () => {}
      },
      restrict() {
        return () => {}
      },
    },
    commands: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  })

  const dispose = apply(ctx, rawConfig)

  /** A teammate whose agent-scoped context captures its prompt sections. */
  const makeAgent = (id, name, membershipRole = 'teammate') => {
    const capture = createSystemPromptCapture()
    prompts.set(id, capture)
    const agent = {
      id,
      name,
      membershipRole,
      ctx: {
        get(serviceName) {
          if (serviceName === 'systemPrompt') return capture.service
          if (serviceName === 'tools') return { restrict: () => () => {} }
          if (serviceName === 'agentTeams') return ledger
          return undefined
        },
      },
    }
    ledger.addMember(agent)
    return agent
  }

  return { ctx, ledger, registered, prompts, makeAgent, dispose }
}

/** Run the pre-execute waterfall, then apply the call when it is allowed. */
async function dispatchClaim(harness, caller, taskId, expectedRevision) {
  const exec = {
    name: 'team_task_update',
    arguments: { task_id: taskId, expected_revision: expectedRevision, action: 'claim' },
    agent: caller,
    callId: `call-${taskId}-${caller.id}`,
  }
  const decision = await fire(harness.ctx, 'tools/pre-execute', [exec], { kind: 'allow' })
  if (decision.kind !== 'allow') return decision
  try {
    const view = await harness.ledger.updateTask(caller, {
      taskId,
      expectedRevision,
      action: 'claim',
    })
    return { kind: 'allow', view }
  } catch (error) {
    return { kind: 'error', code: error.code, message: error.message }
  }
}

const POOL_CONFIG = {
  orchestration: { rolePool: ['验证Agent', '审查Agent'] },
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test('acceptance: teammates take distinct roles from the pool, Lead is skipped', async () => {
  const h = createHarness(POOL_CONFIG)
  const lead = h.makeAgent('lead', 'captain', 'lead')
  const a1 = h.makeAgent('a1', 'alice')
  const a2 = h.makeAgent('a2', 'bob')

  for (const agent of [lead, a1, a2]) {
    await fireAll(h.ctx, 'agent/created', [{ agent }])
  }

  const command = h.registered.find((entry) => entry.name === 'role-status')
  const roleOf = (agent) => command.handler({ agent }).text.match(/role "(.*?)"/)[1]

  assert.equal(roleOf(lead), 'default', 'the Lead keeps the default role')
  assert.equal(roleOf(a1), '验证Agent')
  assert.equal(roleOf(a2), '审查Agent')
  assert.notEqual(roleOf(a1), roleOf(a2), 'no two teammates share a role')

  h.dispose()
})

test('acceptance: a marked task is reserved, then only its role may claim it', async () => {
  const h = createHarness(POOL_CONFIG)
  const verifier = h.makeAgent('a1', 'alice')
  const reviewer = h.makeAgent('a2', 'bob')
  await fireAll(h.ctx, 'agent/created', [{ agent: verifier }])
  await fireAll(h.ctx, 'agent/created', [{ agent: reviewer }])

  // The model creates a task carrying a role marker.
  const task = h.ledger.createTask({ subject: 'Reproduce the claim [role:验证Agent]' })
  await fire(
    h.ctx,
    'tools/post-execute',
    [{ name: 'team_task_create' }, { isError: false, value: task }],
    'PASSTHROUGH',
  )

  // The reservation is visible before anyone claims.
  const command = h.registered.find((entry) => entry.name === 'role-status')
  assert.match(command.handler({ agent: verifier }).text, new RegExp(`reservations   : ${task.id} <- 验证Agent`))

  // The wrong role is refused by policy, before the dispatch.
  const denied = await dispatchClaim(h, reviewer, task.id, task.revision)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /reserved for role "验证Agent"/)
  assert.equal(h.ledger.getTask(reviewer, task.id).status, 'pending', 'the task is untouched')

  // The matching role proceeds, and the CAS applies it.
  const allowed = await dispatchClaim(h, verifier, task.id, task.revision)
  assert.equal(allowed.kind, 'allow')
  assert.equal(allowed.view.status, 'in_progress')
  assert.equal(allowed.view.ownerName, 'alice')

  h.dispose()
})

test('acceptance: concurrent claims yield exactly one winner', async () => {
  const h = createHarness(POOL_CONFIG)
  const agents = Array.from({ length: 6 }, (_, index) => h.makeAgent(`a${index}`, `agent${index}`))
  for (const agent of agents) await fireAll(h.ctx, 'agent/created', [{ agent }])

  // Unreserved, so every agent passes policy and only the CAS decides.
  const task = h.ledger.createTask({ subject: 'Shared work' })

  const results = await Promise.all(agents.map((agent) => dispatchClaim(h, agent, task.id, 1)))

  const winners = results.filter((result) => result.kind === 'allow')
  const losers = results.filter((result) => result.kind !== 'allow')

  assert.equal(winners.length, 1, `exactly one agent may own the task, got ${winners.length}`)
  assert.equal(losers.length, agents.length - 1)

  // Every loser is rejected by the ledger, not by this plugin's policy: the
  // guard runs before dispatch, when the task is still unowned, so it allows all
  // six. Atomicity is the framework's guarantee, which is exactly why this
  // plugin does not implement a lock of its own (CORRECTIONS.md F-6).
  assert.equal(results.filter((result) => result.kind === 'deny').length, 0)

  for (const loser of losers) {
    assert.equal(loser.kind, 'error')
    // The verified ledger checks the revision BEFORE ownership, and each loser
    // captured revision 1 before the winner committed revision 2 — so the
    // revision is what rejects them. `TEAM_TASK_ALREADY_CLAIMED` is unreachable
    // on this path and fires only when a claim arrives with a current revision.
    assert.equal(loser.code, 'TEAM_TASK_STALE_REVISION')
  }

  // The ownership rejection is real and reachable with a fresh revision.
  const other = agents.find((agent) => agent.name !== winners[0].view.ownerName)
  const current = h.ledger.getTask(other, task.id)
  await assert.rejects(
    () => h.ledger.updateTask(other, { taskId: task.id, expectedRevision: current.revision, action: 'claim' }),
    (error) => error.code === 'TEAM_TASK_ALREADY_CLAIMED',
  )

  const view = h.ledger.getTask(agents[0], task.id)
  assert.equal(view.status, 'in_progress')
  assert.equal(view.ownerName, winners[0].view.ownerName)

  h.dispose()
})

test('acceptance: a stale revision is caught before dispatch in strict mode', async () => {
  const h = createHarness({ taskGuard: { strict: true } })
  const agent = h.makeAgent('a1', 'alice')
  await fireAll(h.ctx, 'agent/created', [{ agent }])

  const task = h.ledger.createTask({ subject: 'Work' })
  await h.ledger.updateTask(agent, { taskId: task.id, expectedRevision: 1, action: 'claim' })

  const decision = await dispatchClaim(h, agent, task.id, 1) // stale: now revision 2
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /revision 1 is stale/)
  assert.match(decision.reason, /team_task_get/)

  h.dispose()
})

// ---------------------------------------------------------------------------
// Per-role context
// ---------------------------------------------------------------------------

test('acceptance: each role gets its own charter, budget and reserved-work hint', async () => {
  const h = createHarness(POOL_CONFIG)
  const verifier = h.makeAgent('a1', 'alice')
  const reviewer = h.makeAgent('a2', 'bob')
  await fireAll(h.ctx, 'agent/created', [{ agent: verifier }])
  await fireAll(h.ctx, 'agent/created', [{ agent: reviewer }])

  const task = h.ledger.createTask({ subject: 'Reproduce [role:验证Agent]' })
  await fire(
    h.ctx,
    'tools/post-execute',
    [{ name: 'team_task_create' }, { isError: false, value: task }],
    'PASSTHROUGH',
  )

  const textFor = (id) => h.prompts.get(id).sections[0].text()

  const verifierText = textFor('a1')
  const reviewerText = textFor('a2')

  assert.match(verifierText, /<role-context role="验证Agent">/)
  assert.match(verifierText, /verification role/)
  assert.match(verifierText, /Tasks reserved for your role/)
  assert.match(verifierText, new RegExp(`${task.id}: Reproduce`))

  assert.match(reviewerText, /<role-context role="审查Agent">/)
  assert.match(reviewerText, /review role/)
  assert.doesNotMatch(reviewerText, /Tasks reserved for your role/)

  assert.notEqual(verifierText, reviewerText, 'roles must not see identical context')

  h.dispose()
})

test('acceptance: oversized message text is compressed to the role budget', async () => {
  const h = createHarness(POOL_CONFIG)
  const agent = h.makeAgent('a1', 'alice')
  await fireAll(h.ctx, 'agent/created', [{ agent }])

  const original = 'x'.repeat(40000)
  const messages = [{ role: 'tool', content: [{ type: 'text', text: original }] }]
  const decision = await fire(
    h.ctx,
    'agent/pre-step',
    [{ agent }],
    { kind: 'enter', messages, startsRequestSeries: true },
  )

  const compressed = decision.messages[0].content[0].text
  const before = estimateTokens(original)
  const after = estimateTokens(compressed)

  assert.equal(decision.startsRequestSeries, true, 'decision fields survive the rewrite')
  assert.equal(decision.messages.length, 1, 'no message is ever dropped')
  assert.ok(after < before, `expected a reduction, got ${before} -> ${after} tokens`)
  assert.ok(
    after <= before * 0.3,
    `expected at least a 70% reduction, got ${before} -> ${after}`,
  )

  h.dispose()
})

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

test('acceptance: a high-risk call asks, and proceeds only when approval grants once', async () => {
  const h = createHarness({ approvalGate: { mode: 'direct', highRiskTools: ['danger_tool'] } })
  const agent = h.makeAgent('a1', 'alice')

  const exec = { name: 'danger_tool', arguments: {}, agent, callId: 'c1' }

  const denied = await fire(h.ctx, 'tools/pre-execute', [exec], 'ALLOWED')
  assert.equal(denied.kind, 'deny', 'no approval service means fail closed')
  assert.match(denied.reason, /no approval answerer/)

  h.dispose()

  // With an approving answerer the same call proceeds.
  const h2 = createHarness({ approvalGate: { mode: 'direct', highRiskTools: ['danger_tool'] } })
  h2.ctx.services.approval = { request: async () => 'allowed-once' }
  const agent2 = h2.makeAgent('a1', 'alice')
  const allowed = await fire(
    h2.ctx,
    'tools/pre-execute',
    [{ name: 'danger_tool', arguments: {}, agent: agent2, callId: 'c1' }],
    'ALLOWED',
  )
  assert.equal(allowed, 'ALLOWED')

  h2.dispose()
})

test('acceptance: ask mode surfaces a bilingual decision card for high risk', async () => {
  const h = createHarness({ approvalGate: { highRiskTools: ['danger_tool'] } })
  const agent = h.makeAgent('a1', 'alice')

  const decision = await fire(
    h.ctx,
    'tools/pre-execute',
    [{ name: 'danger_tool', arguments: {}, agent, callId: 'c1' }],
    'ALLOWED',
  )
  assert.equal(decision.kind, 'ask')
  assert.equal(typeof decision.displayReason.en, 'string')
  assert.equal(typeof decision.displayReason.zh, 'string')

  h.dispose()
})

test('acceptance: a low-risk call is untouched end to end', async () => {
  const h = createHarness(POOL_CONFIG)
  const agent = h.makeAgent('a1', 'alice')
  await fireAll(h.ctx, 'agent/created', [{ agent }])

  const decision = await fire(
    h.ctx,
    'tools/pre-execute',
    [{ name: 'read', arguments: { file_path: 'x' }, agent, callId: 'c1' }],
    'ALLOWED',
  )
  assert.equal(decision, 'ALLOWED')

  h.dispose()
})

test('acceptance: the disposer leaves no listener behind', async () => {
  const h = createHarness(POOL_CONFIG)
  const agent = h.makeAgent('a1', 'alice')
  await fireAll(h.ctx, 'agent/created', [{ agent }])
  h.dispose()

  for (const event of ['agent/created', 'agent/disposed', 'agent/pre-step', 'tools/pre-execute', 'tools/post-execute']) {
    assert.equal(h.ctx.handlers.get(event)?.length ?? 0, 0, `${event} should be released`)
  }
})
