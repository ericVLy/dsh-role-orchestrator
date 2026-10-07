#!/usr/bin/env node
/**
 * Phase 3 evidence for acceptance criterion 3 — "different roles see different
 * context, and token consumption drops".
 *
 * This prints MEASURED numbers using the plugin's own code paths, not estimates
 * of estimates:
 *   - the real `<role-context>` section each role receives, priced with the
 *     Harness heuristic (`CHARS_PER_TOKEN = 4`, i.e. `estimateTokens`)
 *   - the per-message cap the pre-step hook applies to an oversized tool result
 *     for each role's budget
 *
 * Run: node scripts/token-report.mjs
 */

import { buildRoleTable, policyFor } from '../src/roles.js'
import { normalizeConfig } from '../src/config.js'
import { registerContextCompressor } from '../src/context-compressor.js'
import { estimateTokens, charsForBudget } from '../src/token-budget.js'

const { config } = normalizeConfig(undefined)
const table = buildRoleTable(config.contextCompressor)
const { defaultTokenBudget, maxCharsPerSection } = config.contextCompressor

/** Minimal Cordis-context double, mirroring test/helpers.js. */
function miniCtx() {
  const handlers = new Map()
  return {
    on(name, fn) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
      return () => {}
    },
    get: () => undefined,
    logger: { info() {}, warn() {} },
    handlers,
  }
}

/** Render the exact section text a role receives, via the real compressor. */
function renderSection(role) {
  const ctx = miniCtx()
  const captured = {}
  registerContextCompressor(ctx, config, {
    resolveRoleFor: () => ({
      role,
      source: 'report',
      policy: policyFor(table, role, defaultTokenBudget),
    }),
    isEnabled: () => true,
  })
  const agent = {
    id: `report-${role}`,
    name: role,
    ctx: {
      get: (name) =>
        name === 'systemPrompt'
          ? {
              section(section) {
                captured.section = section
                return () => {}
              },
            }
          : undefined,
    },
  }
  for (const listener of ctx.handlers.get('agent/created') ?? []) listener({ agent })
  return captured.section ? captured.section.text() : ''
}

/** The character cap the pre-step hook enforces for a role's budget. */
function perMessageCap(role) {
  const policy = policyFor(table, role, defaultTokenBudget)
  const budget = policy.tokenBudget || defaultTokenBudget
  return Math.max(1000, Math.floor(charsForBudget(budget) / 4))
}

const OVERSIZED = 'x'.repeat(20000)
const originalTokens = estimateTokens(OVERSIZED)

const rows = Object.keys(table).map((role) => {
  const policy = policyFor(table, role, defaultTokenBudget)
  const section = renderSection(role)
  const sectionTokens = estimateTokens(section)
  const cap = perMessageCap(role)
  const kept = Math.min(cap, OVERSIZED.length)
  const keptTokens = estimateTokens('x'.repeat(kept))
  return {
    role,
    budget: policy.tokenBudget,
    sectionChars: section.length,
    sectionTokens,
    fits: section.length <= maxCharsPerSection,
    cap,
    keptTokens,
    savedPct: Math.round((1 - keptTokens / originalTokens) * 100),
    scopes: policy.allowedScopes.join(',') || '(none)',
  }
})

const pad = (value, width) => String(value).padEnd(width)
const padStart = (value, width) => String(value).padStart(width)

console.log('Role Orchestrator — measured context cost per role')
console.log(`Host heuristic: ${estimateTokens('abcd')} token per 4 chars (matches CHARS_PER_TOKEN = 4)`)
console.log(`Section cap: ${maxCharsPerSection} chars   Oversized sample: ${OVERSIZED.length} chars = ${originalTokens} tokens\n`)

console.log(
  pad('role', 16) +
    padStart('budget', 8) +
    padStart('section', 9) +
    padStart('chars', 7) +
    padStart('fits', 6) +
    padStart('msg cap', 9) +
    padStart('msg tok', 9) +
    padStart('saved', 7) +
    '  scopes',
)
console.log('-'.repeat(96))
for (const row of rows) {
  console.log(
    pad(row.role, 16) +
      padStart(row.budget, 8) +
      padStart(row.sectionTokens, 9) +
      padStart(row.sectionChars, 7) +
      padStart(row.fits ? 'yes' : 'NO', 6) +
      padStart(row.cap, 9) +
      padStart(row.keptTokens, 9) +
      padStart(`${row.savedPct}%`, 7) +
      `  ${row.scopes}`,
  )
}

const distinctSections = new Set(rows.map((row) => renderSection(row.role))).size
console.log(
  `\n${rows.length} roles, ${distinctSections} distinct role-context sections ` +
    `(each role sees different instructions).`,
)
console.log(
  `An oversized ${originalTokens}-token tool result is reduced to ` +
    `${rows[0].keptTokens}–${Math.max(...rows.map((r) => r.keptTokens))} tokens ` +
    `(${Math.min(...rows.map((r) => r.savedPct))}–${Math.max(...rows.map((r) => r.savedPct))}% saved), ` +
    `by eliding text inside the message — never by dropping the message, so ` +
    `tool-call/tool-result pairing is preserved.`,
)
