/**
 * Client-half verification.
 *
 * There is no browser control in this environment, so — per the plugin
 * verification guidance — this checks everything that is checkable without a
 * page: the bundle loads, the factory returns the documented Cordis plugin
 * shape, `apply()` performs the expected registrations, and the status reader
 * parses a real `/role-status` payload without throwing.
 *
 * What this CANNOT establish is what the strip looks like: rendering, theme
 * fidelity, and whether a client-callable Remote path exists at runtime all
 * remain unverified until a connected page is inspected.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Evaluate the browser bundle against a minimal loader + React surface.
 *
 * `state` pre-seeds `useState`, which lets a test render the component as it
 * would look once its async status read has resolved, without a DOM.
 */
function loadClientBundle({ state } = {}) {
  let definition = null
  const window = {
    __ModuleLoader__: {
      load: (value) => {
        definition = value
      },
    },
  }
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [state === undefined ? initial : state, () => {}],
    useEffect: () => {},
  }
  const requests = []
  const requireStub = (id) => {
    requests.push(id)
    if (id === 'react') return React
    throw new Error(`unexpected require("${id}")`)
  }

  new Function('window', readFileSync(join(root, 'client.js'), 'utf8'))(window)
  assert.ok(definition, 'the bundle must call window.__ModuleLoader__.load')

  return { definition, plugin: definition.factory(requireStub), requests }
}

/** Flatten every text node out of a stubbed React element tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out)
  }
  return out
}

/** Render the registered strip component with the given props. */
function renderStrip({ state, ...props } = {}) {
  const { plugin } = loadClientBundle({ state })
  const ctx = fakeClientCtx()
  plugin.apply(ctx)
  return textOf(ctx.registered[0].component(props)).join(' ')
}

function fakeClientCtx({ remote } = {}) {
  const registered = []
  const injectedSlots = []
  const effectLabels = []
  return {
    registered,
    injectedSlots,
    effectLabels,
    get(name) {
      if (name === 'remote') return remote
      if (name === 'styles') return { insert: () => () => {} }
      return undefined
    },
    effect(callback, label) {
      effectLabels.push(label)
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        effectLabels.push(`locale:${namespace}:${Object.keys(dictionaries).sort().join('+')}`)
        return () => {}
      },
    },
    slots: {
      inject(key, callback) {
        injectedSlots.push(key)
        return callback()
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

const REAL_STATUS_TEXT = [
  'Role Orchestrator — role "验证Agent" (source: orchestration)',
  '  context budget : 5000 tokens (section order 650)',
  '  allowed scopes : evidence, claim, verification',
  '  denied tools   : (none)',
  '  owned tasks    : t1',
  '  task guard     : enabled',
  '  approval gate  : enabled (ask)',
  '  orchestration  : enabled (pool: 验证Agent)',
  '  assignments    : 验证Agent <- a1',
  '  reservations   : t3 <- 审查Agent',
].join('\n')

test('client: the bundle registers a factory whose id is the package name', () => {
  const { definition } = loadClientBundle()
  assert.equal(definition.id, '@local/dsh-role-orchestrator')
  assert.equal(typeof definition.factory, 'function')
})

test('client: the factory returns the documented Cordis plugin shape', () => {
  const { plugin, requests } = loadClientBundle()
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.deepEqual(requests, ['react'], 'the bundle must require only React')
})

test('client: apply() registers a locale dictionary and one dock entry', () => {
  const { plugin } = loadClientBundle()
  const ctx = fakeClientCtx()
  plugin.apply(ctx)

  assert.ok(
    ctx.effectLabels.some((label) => label.startsWith('locale:role-orchestrator:en+zh')),
    `dictionaries must be registered, got ${JSON.stringify(ctx.effectLabels)}`,
  )
  assert.deepEqual(ctx.injectedSlots, ['conversation.composer.dock'])

  assert.equal(ctx.registered.length, 1)
  const entry = ctx.registered[0]
  assert.equal(entry.options.name, 'conversation.composer.dock')
  assert.equal(entry.options.id, 'role-orchestrator')
  assert.equal(entry.options.order, 30)
  assert.equal(entry.options.locale, 'role-orchestrator')
  assert.equal(typeof entry.component, 'function', 'the registration must supply a component')
})

test('client: the slot injects a status reader the component can call', async () => {
  const { plugin } = loadClientBundle()
  const ctx = fakeClientCtx()
  plugin.apply(ctx)

  const props = ctx.registered[0].options.inject()
  assert.equal(typeof props.readStatus, 'function')

  const status = await props.readStatus()
  assert.equal(status, null, 'no Remote path means no data, and no throw')
})

test('client: the status reader parses the real command output', async () => {
  const { plugin } = loadClientBundle()
  const calls = []
  const ctx = fakeClientCtx({
    remote: {
      commands: {
        async execute(name, args, signal) {
          calls.push({ name, args, signal })
          return { result: { text: REAL_STATUS_TEXT } }
        },
      },
    },
  })
  plugin.apply(ctx)

  const status = await ctx.registered[0].options.inject().readStatus()

  assert.deepEqual(calls, [{ name: 'role-status', args: [], signal: undefined }])
  assert.equal(status.role, '验证Agent')
  assert.equal(status.source, 'orchestration')
  assert.equal(status.budget, '5000 tokens (section order 650)')
  assert.equal(status.gate, 'enabled (ask)')
  assert.match(status.orchestration, /^enabled \(pool: 验证Agent\)$/)
  assert.equal(status.reservations, 't3 <- 审查Agent')
})

test('client: a failing or malformed Remote answer degrades to null', async () => {
  const cases = [
    { commands: { execute: async () => { throw new Error('offline') } } },
    { commands: { execute: async () => ({ result: { text: '' } }) } },
    { commands: { execute: async () => null } },
    {},
  ]
  for (const remote of cases) {
    const { plugin } = loadClientBundle()
    const ctx = fakeClientCtx({ remote })
    plugin.apply(ctx)
    const status = await ctx.registered[0].options.inject().readStatus()
    assert.equal(status, null)
  }
})

test('client: the reader also probes the ctx.remote property shape', async () => {
  const { plugin } = loadClientBundle()
  const calls = []
  const ctx = fakeClientCtx()
  // The generated Remote namespace may be injected as a property rather than
  // registered as a service, so both shapes are probed.
  ctx.remote = {
    commands: {
      async execute(name) {
        calls.push(name)
        return { result: { text: REAL_STATUS_TEXT } }
      },
    },
  }

  plugin.apply(ctx)
  const status = await ctx.registered[0].options.inject().readStatus()

  assert.deepEqual(calls, ['role-status'])
  assert.equal(status.role, '验证Agent')
  assert.equal(status.budget, '5000 tokens (section order 650)')
})

test('client: neither probe throwing is what makes the fallback safe', async () => {
  const { plugin } = loadClientBundle()
  const ctx = fakeClientCtx()
  ctx.get = () => {
    throw new Error('service unavailable')
  }
  Object.defineProperty(ctx, 'remote', {
    get() {
      throw new Error('not provided')
    },
  })

  plugin.apply(ctx)
  assert.equal(ctx.registered.length, 1)
  const status = await ctx.registered[0].options.inject().readStatus()
  assert.equal(status, null, 'throwing probes must degrade, not propagate')
})

// ---------------------------------------------------------------------------
// Rendered output (the stubbed React tree stands in for a DOM)
// ---------------------------------------------------------------------------

const TEAM = {
  members: [
    { id: 'lead', name: 'lead', role: 'lead' },
    { id: 'a1', name: 'alice', role: 'teammate' },
  ],
  tasks: [
    { id: 't1', subject: 'Reproduce the claim [role:验证Agent]', status: 'pending' },
    {
      id: 't2',
      subject: 'Review',
      description: '[role:审查Agent]',
      status: 'in_progress',
      ownerName: 'bob',
    },
    { id: 't3', subject: 'Finished [role:验证Agent]', status: 'completed' },
    { id: 't4', subject: 'Dropped [role:验证Agent]', status: 'deleted' },
    { id: 't5', subject: 'No marker here', status: 'pending' },
  ],
}

test('client: the strip renders live reservations from the agentTeam projection', () => {
  const text = renderStrip({
    useProjection: (key) => {
      assert.equal(key, 'agentTeam', 'the strip must read the client-visible team projection')
      return TEAM
    },
  })

  assert.match(text, /Role Orchestrator/)
  assert.match(text, /2 members/)
  assert.match(text, /2 reserved/)
  assert.match(text, /t1 → 验证Agent/)
  assert.doesNotMatch(text, /Run \/role-status/, 'real data means no fallback hint')
})

test('client: completed, deleted and unmarked tasks are not reservations', () => {
  const text = renderStrip({ useProjection: () => TEAM })
  assert.doesNotMatch(text, /t3/)
  assert.doesNotMatch(text, /t4/)
  assert.doesNotMatch(text, /t5/)
})

test('client: status chips render once the command reader has resolved', () => {
  const text = renderStrip({
    state: {
      role: '验证Agent',
      budget: '5000 tokens (section order 650)',
      gate: 'enabled (ask)',
    },
    readStatus: async () => null,
  })

  assert.match(text, /验证Agent/)
  assert.match(text, /5000 tokens \(section order 650\)/)
  assert.match(text, /enabled \(ask\)/)
  assert.doesNotMatch(text, /Run \/role-status/)
})

test('client: with no data at all it shows the localized fallback, never nothing', () => {
  const text = renderStrip({})
  assert.match(text, /Role Orchestrator/)
  assert.match(text, /active/)
  assert.match(text, /Run \/role-status for the full report\./)
})

test('client: the component never throws when every source misbehaves', () => {
  let text
  assert.doesNotThrow(() => {
    text = renderStrip({
      useProjection: () => {
        throw new Error('projection unavailable')
      },
      readStatus: () => {
        throw new Error('boom')
      },
    })
  })
  assert.match(text, /Role Orchestrator/, 'a broken source still yields a rendered strip')
})

test('client: a projection without tasks or members degrades to the fallback', () => {
  const text = renderStrip({ useProjection: () => ({ members: [], tasks: [] }) })
  assert.match(text, /Role Orchestrator/)
  assert.match(text, /Run \/role-status/)
})
