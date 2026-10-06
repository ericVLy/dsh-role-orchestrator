import test from 'node:test'
import assert from 'node:assert/strict'

import { registerStatusTool } from '../src/status-tool.js'
import { makeCtx, testConfig } from './helpers.js'

function fakeRegistry() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
}

test('status tool: registers and reports role, policy and owned tasks', async () => {
  const registry = fakeRegistry()
  const ctx = makeCtx({ tools: registry })
  const deps = {
    resolveRoleFor: () => ({
      role: '文献检索Agent',
      source: 'identity',
      policy: { tokenBudget: 4000, allowedScopes: ['literature'], deniedTools: ['write'] },
    }),
    ownedTasksFor: () => ['t1'],
  }
  registerStatusTool(ctx, testConfig(), deps)

  assert.equal(registry.registered.length, 1)
  const definition = registry.registered[0]
  assert.equal(definition.name, 'role_orchestrator_status')
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.render, 'function')

  const value = await definition.execute({}, { agent: { id: 's1' } })
  assert.equal(value.role, '文献检索Agent')
  assert.equal(value.roleSource, 'identity')
  assert.deepEqual(value.allowedScopes, ['literature'])
  assert.deepEqual(value.deniedTools, ['write'])
  assert.deepEqual(value.ownedTasks, ['t1'])
  assert.equal(value.approvalMode, 'ask')
  assert.equal(value.sectionOrder, 650)

  const blocks = definition.output.render({}, value)
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /文献检索Agent/)
})

test('status tool: a missing tools service is a no-op, not a throw', () => {
  const ctx = makeCtx()
  const dispose = registerStatusTool(ctx, testConfig(), {
    resolveRoleFor: () => ({}),
    ownedTasksFor: () => [],
  })
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})
