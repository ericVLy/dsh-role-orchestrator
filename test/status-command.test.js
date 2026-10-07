import test from 'node:test'
import assert from 'node:assert/strict'

import { registerStatusCommand, formatStatus } from '../src/status-command.js'
import { buildStatus } from '../src/status-tool.js'
import { makeCtx, testConfig } from './helpers.js'

function commandRegistry() {
  const registered = []
  return {
    registered,
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
}

const deps = {
  resolveRoleFor: () => ({
    role: '文献检索Agent',
    source: 'identity',
    policy: { tokenBudget: 4000, allowedScopes: ['literature'], deniedTools: ['write'] },
  }),
  ownedTasksFor: () => ['t1'],
}

test('command: registers a slash command with no leading slash in its name', () => {
  const registry = commandRegistry()
  const ctx = makeCtx({ commands: registry })
  registerStatusCommand(ctx, testConfig(), deps)

  assert.equal(registry.registered.length, 1)
  const definition = registry.registered[0]
  assert.equal(definition.name, 'role-status')
  assert.doesNotMatch(definition.name, /^\//, 'the registry adds the slash itself')
  assert.equal(typeof definition.handler, 'function')
  assert.ok(definition.description.length > 0)
})

test('command: the handler returns a success result describing the role', () => {
  const registry = commandRegistry()
  const ctx = makeCtx({ commands: registry })
  registerStatusCommand(ctx, testConfig(), deps)

  const result = registry.registered[0].handler({ agent: { id: 's1' }, rawInput: '', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /role "文献检索Agent"/)
  assert.match(result.text, /context budget : 4000 tokens/)
  assert.match(result.text, /allowed scopes : literature/)
  assert.match(result.text, /denied tools   : write/)
  assert.match(result.text, /owned tasks    : t1/)
  assert.match(result.text, /approval gate  : enabled \(ask\)/)
})

test('command: a throwing state read becomes an error result, never a rejected promise', () => {
  const registry = commandRegistry()
  const ctx = makeCtx({ commands: registry })
  registerStatusCommand(ctx, testConfig(), {
    resolveRoleFor: () => {
      throw new Error('boom')
    },
    ownedTasksFor: () => [],
  })

  const result = registry.registered[0].handler({ agent: {} })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /boom/)
})

test('command: registration is deferred while the registry is absent', () => {
  const deferred = []
  const ctx = {
    get: () => undefined,
    inject(deps2, callback) {
      deferred.push({ deps: deps2, callback })
      return { dispose() {} }
    },
  }
  registerStatusCommand(ctx, testConfig(), deps)
  assert.equal(deferred.length, 1)
  assert.deepEqual(deferred[0].deps, ['commands'])

  const registry = commandRegistry()
  deferred[0].callback({ get: () => registry })
  assert.equal(registry.registered.length, 1)
  assert.equal(registry.registered[0].name, 'role-status')
})

test('command: a commands service without register() is tolerated', () => {
  const ctx = makeCtx({ commands: {} })
  assert.doesNotThrow(() => registerStatusCommand(ctx, testConfig(), deps))
})

test('formatStatus: renders empty collections as (none)', () => {
  const status = buildStatus(testConfig(), { resolveRoleFor: () => ({ role: 'default', source: 'd', policy: {} }), ownedTasksFor: () => [] }, undefined)
  const text = formatStatus(status)
  assert.match(text, /allowed scopes : \(none\)/)
  assert.match(text, /denied tools   : \(none\)/)
  assert.match(text, /owned tasks    : \(none\)/)
  assert.match(text, /task guard     : enabled/)
})
