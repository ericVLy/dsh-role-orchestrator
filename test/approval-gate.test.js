import test from 'node:test'
import assert from 'node:assert/strict'

import { registerApprovalGate } from '../src/approval-gate.js'
import { makeCtx, fire, testConfig } from './helpers.js'

const exec = (name, extra = {}) => ({
  name,
  arguments: {},
  agent: { id: 'session-1' },
  callId: 'call-1',
  signal: undefined,
  ...extra,
})

test('ask mode: high risk produces an ask decision with bilingual display text', async () => {
  const ctx = makeCtx()
  registerApprovalGate(ctx, testConfig({ approvalGate: { highRiskTools: ['danger'] } }))

  const decision = await fire(ctx, 'tools/pre-execute', [exec('danger')], undefined)
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /highRiskTools/)
  assert.equal(typeof decision.displayReason.en, 'string')
  assert.equal(typeof decision.displayReason.zh, 'string')
})

test('ask mode: low risk falls through to the next listener', async () => {
  const ctx = makeCtx()
  registerApprovalGate(ctx, testConfig())
  const decision = await fire(ctx, 'tools/pre-execute', [exec('read')], 'ALLOWED')
  assert.equal(decision, 'ALLOWED')
})

test('ask mode: medium risk asks by default and follows mediumAction overrides', async () => {
  const ctx = makeCtx()
  registerApprovalGate(ctx, testConfig())
  const asked = await fire(ctx, 'tools/pre-execute', [exec('workflow')], 'ALLOWED')
  assert.equal(asked.kind, 'ask')

  const allowCtx = makeCtx()
  registerApprovalGate(allowCtx, testConfig({ approvalGate: { mediumAction: 'allow' } }))
  assert.equal(await fire(allowCtx, 'tools/pre-execute', [exec('workflow')], 'ALLOWED'), 'ALLOWED')

  const denyCtx = makeCtx()
  registerApprovalGate(denyCtx, testConfig({ approvalGate: { mediumAction: 'deny' } }))
  const denied = await fire(denyCtx, 'tools/pre-execute', [exec('workflow')], 'ALLOWED')
  assert.equal(denied.kind, 'deny')
})

test('direct mode: allowed-once proceeds, every other outcome denies', async () => {
  const outcomes = ['allowed-once', 'rejected', 'cancelled', 'unavailable']
  for (const outcome of outcomes) {
    const ctx = makeCtx({ approval: { async request() { return outcome } } })
    registerApprovalGate(ctx, testConfig({ approvalGate: { mode: 'direct', highRiskTools: ['danger'] } }))
    const decision = await fire(ctx, 'tools/pre-execute', [exec('danger')], 'ALLOWED')
    if (outcome === 'allowed-once') {
      assert.equal(decision, 'ALLOWED', `${outcome} must proceed`)
    } else {
      assert.equal(decision.kind, 'deny', `${outcome} must deny`)
      assert.match(decision.reason, new RegExp(outcome))
    }
  }
})

test('direct mode: a throwing approval call fails closed', async () => {
  const ctx = makeCtx({ approval: { async request() { throw new Error('no open turn') } } })
  registerApprovalGate(ctx, testConfig({ approvalGate: { mode: 'direct', highRiskTools: ['danger'] } }))
  const decision = await fire(ctx, 'tools/pre-execute', [exec('danger')], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /no open turn/)
})

test('direct mode: missing approval service denies when configured fail-closed', async () => {
  const ctx = makeCtx()
  registerApprovalGate(ctx, testConfig({ approvalGate: { mode: 'direct', highRiskTools: ['danger'] } }))
  const decision = await fire(ctx, 'tools/pre-execute', [exec('danger')], 'ALLOWED')
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /no approval answerer/)
})

test('a disabled gate registers nothing', async () => {
  const ctx = makeCtx()
  registerApprovalGate(ctx, testConfig({ approvalGate: { enabled: false, highRiskTools: ['danger'] } }))
  assert.equal(ctx.handlers.get('tools/pre-execute'), undefined)
})
