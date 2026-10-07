import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig, DEFAULT_CONFIG } from '../src/config.js'
import { buildRoleTable, policyFor, resolveRole } from '../src/roles.js'
import { estimateTokens, truncate, fitSections, charsForBudget } from '../src/token-budget.js'
import { evaluateRisk } from '../src/risk-rules.js'
import { classifyOwnership, readTaskId, agentIdentities } from '../src/ownership.js'

test('config: defaults are complete and stable', () => {
  const { config, warnings } = normalizeConfig(undefined)
  assert.deepEqual(warnings, [])
  assert.equal(config.contextCompressor.enabled, true)
  assert.equal(config.contextCompressor.sectionOrder, 650)
  assert.equal(config.approvalGate.mode, 'ask')
  assert.equal(config.approvalGate.mediumAction, 'ask')
  assert.ok(config.taskGuard.claimTools.includes('team_task_update'))
  assert.ok(config.taskGuard.claimTools.includes('agent_teams_claim_task'))
})

test('config: unknown keys and wrong types warn instead of throwing', () => {
  const { config, warnings } = normalizeConfig({
    contextCompressor: { enabled: 'yes', nope: 1, defaultTokenBudget: -5 },
  })
  assert.equal(config.contextCompressor.enabled, true, 'bad type falls back to default')
  assert.equal(config.contextCompressor.defaultTokenBudget, 4000)
  assert.equal(warnings.length >= 3, true, `expected warnings, got ${JSON.stringify(warnings)}`)
})

test('config: non-object config is rejected with a warning', () => {
  const { warnings } = normalizeConfig('nonsense')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /must be an object/)
})

test('roles: assignment beats identity beats default', () => {
  const table = buildRoleTable({})
  const section = { roleAssignments: { s1: '验证Agent' }, defaultRole: 'default' }

  assert.equal(resolveRole({ id: 's1', name: '文献检索Agent' }, section, table).role, '验证Agent')
  assert.equal(resolveRole({ id: 's2', name: '文献检索Agent' }, section, table).role, '文献检索Agent')
  assert.equal(resolveRole({ id: 's3' }, section, table).role, 'default')
  assert.equal(resolveRole(undefined, section, table).role, 'default')
})

test('roles: policyFor always yields a positive budget', () => {
  const table = buildRoleTable({})
  assert.equal(policyFor(table, '文献检索Agent', 4000).tokenBudget, 4000)
  assert.equal(policyFor(table, 'unknown-role', 4000).tokenBudget, 4000)
})

test('token-budget: matches the Harness 4-chars-per-token heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('a'.repeat(400)), 100)
  assert.equal(charsForBudget(100), 400)
  assert.equal(charsForBudget(0), 0)
})

test('token-budget: truncate keeps head and tail and flags the elision', () => {
  const long = 'H'.repeat(500) + 'T'.repeat(500)
  const cut = truncate(long, 200)
  assert.equal(cut.truncated, true)
  assert.equal(cut.originalChars, 1000)
  assert.ok(cut.text.length <= 200)
  assert.ok(cut.text.includes('[elided]'))
  assert.ok(cut.text.startsWith('H'))
  assert.ok(cut.text.endsWith('T'))

  const short = truncate('small', 200)
  assert.equal(short.truncated, false)
  assert.equal(short.text, 'small')
})

test('token-budget: fitSections keeps priority order and never exceeds the budget', () => {
  const sections = [
    { name: 'low', text: 'x'.repeat(4000), priority: 9 },
    { name: 'high', text: 'y'.repeat(100), priority: 0 },
  ]
  const fitted = fitSections(sections, 100) // 4 chars/token => 400 chars
  assert.deepEqual(fitted.included, ['high', 'low'], 'higher priority is placed first')
  assert.deepEqual(fitted.truncated, ['low'], 'the lowest-priority section absorbs the cut')
  assert.ok(fitted.text.length <= 400, 'the budget is never exceeded')
  assert.ok(fitted.text.startsWith('y'))
})

test('token-budget: fitSections drops a section once the budget is spent', () => {
  const sections = [
    { name: 'first', text: 'a'.repeat(400), priority: 0 },
    { name: 'second', text: 'b'.repeat(400), priority: 1 },
  ]
  const fitted = fitSections(sections, 100) // exactly 400 chars
  assert.deepEqual(fitted.included, ['first'])
  assert.deepEqual(fitted.dropped, ['second'])
  assert.deepEqual(fitted.truncated, [])
})

test('risk-rules: configured tool lists win', () => {
  const section = { highRiskTools: ['my_tool'], mediumRiskTools: [], extraRules: [] }
  assert.equal(evaluateRisk('my_tool', {}, section).level, 'high')
  assert.equal(evaluateRisk('read', {}, section).level, 'low')
})

test('risk-rules: destructive shell and credential patterns are high risk', () => {
  const section = { highRiskTools: [], mediumRiskTools: [], extraRules: [] }
  assert.equal(evaluateRisk('pwsh', { command: 'Remove-Item -Recurse C:\\x' }, section).level, 'high')
  assert.equal(evaluateRisk('pwsh', { command: 'Get-Content ~/.credentials.yaml' }, section).level, 'high')
  assert.equal(evaluateRisk('pwsh', { command: 'Get-ChildItem' }, section).level, 'low')
})

test('risk-rules: deleting a shared task is high risk, other updates are not', () => {
  const section = { highRiskTools: [], mediumRiskTools: [], extraRules: [] }
  const update = (action) => ({ task_id: 't1', expected_revision: 1, action })

  assert.equal(evaluateRisk('team_task_update', update('delete'), section).level, 'high')
  assert.equal(evaluateRisk('team_task_update', update('reassign'), section).level, 'medium')

  // Ordinary board traffic must stay ungated: a bare tool-name rule here would
  // have made every status update require approval.
  assert.equal(evaluateRisk('team_task_update', update('claim'), section).level, 'low')
  assert.equal(evaluateRisk('team_task_update', update('complete'), section).level, 'low')
  assert.equal(evaluateRisk('team_task_update', update('edit'), section).level, 'low')
  assert.equal(evaluateRisk('team_task_create', { subject: 'x' }, section).level, 'low')
})

test('risk-rules: the deletion rule matches regardless of argument key order', () => {
  const section = { highRiskTools: [], mediumRiskTools: [], extraRules: [] }
  assert.equal(
    evaluateRisk('team_task_update', { action: 'delete', task_id: 't1', expected_revision: 2 }, section)
      .level,
    'high',
  )
})

test('risk-rules: plugin_manager and member removal are high risk', () => {
  const section = { highRiskTools: [], mediumRiskTools: [], extraRules: [] }
  assert.equal(evaluateRisk('plugin_manager', { action: 'install_bundle' }, section).level, 'high')
  assert.equal(evaluateRisk('workflow', { script: 'x' }, section).level, 'medium')
})

test('ownership: classifies unowned, mine, other and unknown', () => {
  const fields = ['ownerName', 'assignee']
  assert.equal(classifyOwnership({}, { name: 'bob' }, fields).state, 'unowned')
  assert.equal(classifyOwnership({ ownerName: 'bob' }, { name: 'bob' }, fields).state, 'mine')
  assert.equal(classifyOwnership({ ownerName: 'alice' }, { name: 'bob' }, fields).state, 'other')
  assert.equal(classifyOwnership({ assignee: 'alice' }, { id: 's1' }, fields).state, 'other')
  assert.equal(classifyOwnership({ ownerName: 'alice' }, {}, fields).state, 'unknown')
})

test('ownership: reads nested owner objects and both task-id spellings', () => {
  const fields = ['ownerName', 'assignee']
  assert.equal(classifyOwnership({ assignee: { name: 'alice' } }, { name: 'alice' }, fields).state, 'mine')
  assert.equal(readTaskId({ task_id: 't1' }), 't1')
  assert.equal(readTaskId({ taskId: 't2' }), 't2')
  assert.equal(readTaskId({ id: 't3' }), 't3')
  assert.equal(readTaskId({ nothing: true }), undefined)
  assert.deepEqual(agentIdentities({ name: 'a', id: 'b' }).sort(), ['a', 'b'])
})

test('config: documented defaults survive an empty section merge', () => {
  const { config } = normalizeConfig({ taskGuard: { enabled: false } })
  assert.equal(config.taskGuard.enabled, false)
  assert.deepEqual(config.taskGuard.ownershipFields, DEFAULT_CONFIG.taskGuard.ownershipFields)
})
