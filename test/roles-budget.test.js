/**
 * Acceptance criterion 3 — every role sees different context, and the context
 * it receives is bounded.
 *
 * This iterates the whole built-in role table rather than one hand-picked role,
 * so a new role cannot be added without a budget check. The measured numbers are
 * printed by `scripts/token-report.mjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRoleTable, policyFor } from '../src/roles.js'
import { registerContextCompressor } from '../src/context-compressor.js'
import { makeCtx, fireAll, testConfig } from './helpers.js'

/** Render the exact section a role would receive, through the real compressor. */
async function renderFor(role, config, table) {
  const ctx = makeCtx()
  const captured = []
  registerContextCompressor(ctx, config, {
    resolveRoleFor: () => ({
      role,
      source: 'test',
      policy: policyFor(table, role, config.contextCompressor.defaultTokenBudget),
    }),
    isEnabled: () => true,
  })

  const agent = {
    id: `a-${role}`,
    name: role,
    ctx: {
      get: (name) =>
        name === 'systemPrompt'
          ? {
              section(section) {
                captured.push(section)
                return () => {}
              },
            }
          : undefined,
    },
  }

  await fireAll(ctx, 'agent/created', [{ agent }])
  return captured[0].text()
}

test('roles: every built-in role renders a distinct, in-budget section', async () => {
  const config = testConfig()
  const table = buildRoleTable(config.contextCompressor)
  const maxChars = config.contextCompressor.maxCharsPerSection
  const rendered = new Map()

  for (const role of Object.keys(table)) {
    const text = await renderFor(role, config, table)
    assert.ok(text.includes(`<role-context role="${role}">`), `${role} renders its own section`)
    assert.ok(text.length <= maxChars, `${role} must fit the ${maxChars}-char cap`)
    rendered.set(role, text)
  }

  assert.ok(rendered.size >= 5, `expected the built-in table, got ${rendered.size} roles`)
  assert.equal(
    new Set(rendered.values()).size,
    rendered.size,
    'no two roles may render identical context',
  )
})

test('roles: a role override changes the rendered section without a restart', async () => {
  const config = testConfig({
    contextCompressor: { rolePolicies: { 验证Agent: { charter: 'OVERRIDDEN CHARTER' } } },
  })
  const table = buildRoleTable(config.contextCompressor)
  const text = await renderFor('验证Agent', config, table)
  assert.match(text, /OVERRIDDEN CHARTER/)
})

test('roles: the section carries the scopes that gate the role', async () => {
  const config = testConfig()
  const table = buildRoleTable(config.contextCompressor)
  const text = await renderFor('文献检索Agent', config, table)
  assert.match(text, /Allowed data scopes: literature, query/)
  assert.match(text, /Do not read other branches/)

  const crossBranch = await renderFor('Claim分析Agent', config, table)
  assert.match(crossBranch, /may read global and cross-branch summaries/)
})
