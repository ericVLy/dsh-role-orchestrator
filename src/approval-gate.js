/**
 * Human approval gate for high-risk tool calls.
 *
 * Verified contract (DSH 0.2.0-rc.2):
 *   - `PreToolDecision = allow | { deny, reason, info? } | cancel | { ask, reason?, displayReason? }`.
 *   - The `ask` outcome is resolved by the framework through the session approval
 *     policy and composed answerers; a missing or throwing answerer yields
 *     `'unavailable'` and the documentation states "missing approval support
 *     turns `ask` into denial" (fail closed).
 *   - `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
 *     and only `'allowed-once'` is a grant. `ctx.approval.request(req)` requires an
 *     open turn and otherwise rejects; `ctx.get('approval')` is the documented
 *     optional accessor that returns `undefined` when the service is absent.
 *
 * Two modes, because they trade differently:
 *   'ask'    (default) — return `{ kind: 'ask' }`. Idiomatic: composes with the
 *            session approval policy and always produces a visible decision card.
 *            The listener does NOT learn the outcome; the framework does.
 *   'direct' — await `ctx.approval.request(...)` inline, so the gate can deny
 *            with the exact outcome text, but the gate then also depends on an
 *            open turn and on answerers being present.
 */

import { evaluateRisk } from './risk-rules.js'
import { serviceOf } from './services.js'

/** @param {*} ctx @param {import('./config.js').NormalizedConfig} config */
export function registerApprovalGate(ctx, config) {
  const section = config.approvalGate
  if (!section.enabled) return () => {}

  const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string') return next()

    let verdict
    try {
      verdict = evaluateRisk(toolName, exec.arguments, section)
    } catch (error) {
      ctx.logger?.warn?.(`[role-orchestrator] risk evaluation failed: ${describe(error)}`)
      return next()
    }
    if (verdict.level === 'low') return next()

    const reason = `${verdict.reason} (rule: ${verdict.rule})`

    if (verdict.level === 'medium') {
      if (section.mediumAction === 'allow') {
        ctx.logger?.warn?.(`[role-orchestrator] medium risk allowed: ${toolName} — ${reason}`)
        return next()
      }
      if (section.mediumAction === 'deny') {
        return { kind: 'deny', reason: `Blocked by role-orchestrator: ${reason}` }
      }
      return askDecision(reason)
    }

    // High risk.
    if (section.mode === 'ask') {
      ctx.logger?.warn?.(`[role-orchestrator] high risk requires approval: ${toolName} — ${reason}`)
      return askDecision(reason)
    }

    const approval = serviceOf(ctx, 'approval')
    if (!approval || typeof approval.request !== 'function') {
      if (section.denyOnUnavailableApproval) {
        return {
          kind: 'deny',
          reason: `Blocked by role-orchestrator: no approval answerer is available for ${toolName}. ${reason}`,
        }
      }
      return next()
    }

    let outcome
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName,
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
    } catch (error) {
      // No open turn or the audit append failed: fail closed.
      return {
        kind: 'deny',
        reason: `Blocked by role-orchestrator: approval could not be requested (${describe(error)}). ${reason}`,
      }
    }
    if (outcome === 'allowed-once') {
      ctx.logger?.warn?.(`[role-orchestrator] high risk approved once: ${toolName}`)
      return next()
    }
    return {
      kind: 'deny',
      reason: `Blocked by role-orchestrator: approval outcome was "${String(outcome)}" for ${toolName}. ${reason}`,
    }
  })

  return dispose
}

function askDecision(reason) {
  return {
    kind: 'ask',
    reason,
    displayReason: {
      en: `Role Orchestrator: this operation is high risk and needs your approval. ${reason}`,
      zh: `角色编排器：该操作属于高风险，需要你确认后再执行。${reason}`,
    },
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
