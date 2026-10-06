import test from 'node:test'
import assert from 'node:assert/strict'

import { registerContextCompressor } from '../src/context-compressor.js'
import { buildRoleTable, policyFor } from '../src/roles.js'
import { makeCtx, fire, testConfig } from './helpers.js'

const table = buildRoleTable({})

/** A fake Agent whose `ctx.get` captures the registrations the module makes. */
function fakeAgent(role, id = 's1') {
  const captured = { sections: [], restrictions: [] }
  const ctx = {
    get(name) {
      if (name === 'systemPrompt') {
        return {
          section(section) {
            captured.sections.push(section)
            return () => {}
          },
        }
      }
      if (name === 'tools') {
        return {
          restrict(filter) {
            captured.restrictions.push(filter)
            return () => {}
          },
        }
      }
      if (name === 'agentTeams') return { listTasks: () => [] }
      return undefined
    },
  }
  return { agent: { id, name: role, ctx }, captured }
}

const depsFor = (role, budget = 4000) => ({
  resolveRoleFor: () => ({ role, source: 'test', policy: policyFor(table, role, budget) }),
  isEnabled: () => true,
})

test('compressor: agent/created registers a scoped role section at the configured order', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('文献检索Agent'))

  const { agent, captured } = fakeAgent('文献检索Agent')
  await fire(ctx, 'agent/created', [{ agent }])

  assert.equal(captured.sections.length, 1)
  const section = captured.sections[0]
  assert.equal(section.name, 'role-orchestrator/role-context')
  assert.equal(section.order, 650)
  assert.equal(section.interpolate, false, 'interpolate off avoids variable-render failures')

  const text = section.text()
  assert.match(text, /<role-context role="文献检索Agent">/)
  assert.match(text, /literature retrieval role/)
  assert.match(text, /Allowed data scopes: literature, query/)
  assert.match(text, /Do not read other branches/)
})

test('compressor: a read-only role is restricted and the default role is not', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('文献检索Agent'))

  const restricted = fakeAgent('文献检索Agent')
  await fire(ctx, 'agent/created', [{ agent: restricted.agent }])
  assert.deepEqual(restricted.captured.restrictions, [{ deny: ['write', 'edit'] }])
})

test('compressor: crossBranchAccess changes the rendered instruction', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('Claim分析Agent'))
  const { agent, captured } = fakeAgent('Claim分析Agent')
  await fire(ctx, 'agent/created', [{ agent }])
  assert.match(captured.sections[0].text(), /may read global and cross-branch summaries/)
})

test('compressor: oversized message text is elided without changing the message list', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('文献检索Agent'))

  const message = { role: 'user', content: [{ type: 'text', text: 'A'.repeat(20000) }] }
  const terminal = { kind: 'enter', messages: [message], startsRequestSeries: true }
  const decision = await fire(ctx, 'agent/pre-step', [{ agent: { id: 's1' }, messages: [message] }], terminal)

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.startsRequestSeries, true, 'decision fields must survive the rewrite')
  assert.equal(decision.messages.length, 1, 'messages are never dropped')
  const text = decision.messages[0].content[0].text
  assert.ok(text.length < 20000, `expected elision, got ${text.length} chars`)
  assert.ok(text.length <= 4000)
  assert.ok(text.includes('[elided]'))
})

test('compressor: a message under the cap keeps its original array reference', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('文献检索Agent'))
  const message = { role: 'user', content: [{ type: 'text', text: 'short' }] }
  const messages = [message]
  const terminal = { kind: 'enter', messages }
  const decision = await fire(ctx, 'agent/pre-step', [{ agent: { id: 's1' } }], terminal)
  assert.equal(decision.messages, messages, 'no rewrite when nothing exceeds the cap')
})

test('compressor: non-text blocks and a reject decision are left untouched', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('文献检索Agent'))

  const reject = { kind: 'reject' }
  assert.equal(await fire(ctx, 'agent/pre-step', [{ agent: { id: 's1' } }], reject), reject)

  const toolMessage = { role: 'tool', content: [{ type: 'tool-result', text: 'x'.repeat(9000) }] }
  const terminal = { kind: 'enter', messages: [toolMessage] }
  const decision = await fire(ctx, 'agent/pre-step', [{ agent: { id: 's1' } }], terminal)
  assert.equal(decision.messages[0], toolMessage, 'only text blocks are eligible')
})

test('compressor: disabling the module registers no listeners', () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig({ contextCompressor: { enabled: false } }), depsFor('default'))
  assert.equal(ctx.handlers.get('agent/created'), undefined)
  assert.equal(ctx.handlers.get('agent/pre-step'), undefined)
})

test('compressor: a throwing registration never escapes agent/created', async () => {
  const ctx = makeCtx()
  registerContextCompressor(ctx, testConfig(), depsFor('default'))
  const broken = { id: 'x', ctx: { get() { throw new Error('boom') } } }
  await fire(ctx, 'agent/created', [{ agent: broken }])
  assert.ok(ctx.logs.some((line) => line.startsWith('warn:') && line.includes('boom')))
})
