/**
 * Role-scoped attention compression.
 *
 * Verified mechanisms used here (DSH 0.2.0-rc.2):
 *   - `ctx.systemPrompt.section({ name, order, text, interpolate })` — per-agent
 *     prompt text registered on `agent.ctx`, so it is removed when the agent is
 *     disposed. `text` may be a function evaluated at assembly time.
 *   - `ctx.tools.restrict({ allow, deny })` — the weakest listed mechanism; it
 *     only removes tools, so it composes with every other plugin.
 *   - `agent/pre-step` waterfall returning `{ ...decision, messages }`.
 *
 * SAFETY INVARIANT: messages are never dropped. Tool-call/tool-result pairing is
 * an invariant of the transcript, so this module only ever shortens the text
 * blocks inside a message. Dropping a message could orphan a tool call and
 * break the turn.
 */

import { fitSections, truncate, estimateTokens } from './token-budget.js'

/**
 * @param {*} ctx plugin context
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{ resolveRoleFor: (agent: object) => { role: string, policy: object, source: string }, isEnabled: () => boolean }} deps
 * @returns {() => void}
 */
export function registerContextCompressor(ctx, config, deps) {
  const section = config.contextCompressor
  if (!section.enabled) return () => {}

  /** @type {(() => void)[]} */
  const disposers = []

  // Per-agent registrations: prompt context + tool restriction.
  const created = ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (!agent) return
    try {
      registerForAgent(agent, deps, section, disposers)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[role-orchestrator] per-agent context skipped (${message})`)
    }
  })
  disposers.push(created)

  // Per-step text elision under the role budget.
  const preStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!deps.isEnabled()) return decision
    if (!decision || decision.kind !== 'enter') return decision
    try {
      const { policy } = deps.resolveRoleFor(payload?.agent)
      const messages = elideOversizedMessages(decision.messages, policy, section)
      if (messages === decision.messages) return decision
      // Spread the decision so `startsRequestSeries` and future fields survive.
      return { ...decision, messages }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[role-orchestrator] pre-step compression skipped (${message})`)
      return decision
    }
  })
  disposers.push(preStep)

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* teardown must not throw */
      }
    }
  }
}

/**
 * Register the role charter as dynamic context and apply the role's tool scope.
 * Both are owned by `agent.ctx`, so disposal follows agent disposal.
 */
function registerForAgent(agent, deps, section, disposers) {
  const agentCtx = agent.ctx
  if (!agentCtx) return

  const systemPrompt = typeof agentCtx.get === 'function' ? agentCtx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    // `section()` is the documented way to add prompt TEXT; it is registered in
    // the agent's scope so a scoped section shadows any global of the same name
    // and is removed when the agent is disposed.
    const dispose = systemPrompt.section({
      name: 'role-orchestrator/role-context',
      order: section.sectionOrder,
      interpolate: false,
      text: () => {
        // Prompt assembly must never fail because of this plugin.
        try {
          const { role, policy } = deps.resolveRoleFor(agent)
          return buildRoleContext(agent, role, policy, section, deps)
        } catch {
          return ''
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  const tools = typeof agentCtx.get === 'function' ? agentCtx.get('tools') : undefined
  if (tools && typeof tools.restrict === 'function') {
    const { policy } = deps.resolveRoleFor(agent)
    const restriction = {}
    if (Array.isArray(policy.allowedTools) && policy.allowedTools.length > 0) {
      restriction.allow = policy.allowedTools
    }
    if (Array.isArray(policy.deniedTools) && policy.deniedTools.length > 0) {
      restriction.deny = policy.deniedTools
    }
    if (Object.keys(restriction).length > 0) {
      const dispose = tools.restrict(restriction)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  }
}

/**
 * Build the budgeted role context block.
 * @returns {string}
 */
function buildRoleContext(agent, role, policy, section, deps) {
  const parts = []
  if (typeof policy.charter === 'string' && policy.charter.length > 0) {
    parts.push(policy.charter)
  }

  // Project brief. A Team member is created with NO conversation history (see
  // CORRECTIONS.md F-19), so this is the only channel that carries shared context
  // to every role without the Lead re-explaining it per member.
  const briefing = typeof section.briefing === 'string' ? section.briefing.trim() : ''
  if (briefing.length > 0) {
    parts.push(`Project brief:\n${briefing}`)
  }

  const scopes = Array.isArray(policy.allowedScopes) ? policy.allowedScopes : []
  if (scopes.length > 0) {
    parts.push(`Allowed data scopes: ${scopes.join(', ')}.`)
  }
  parts.push(
    policy.crossBranchAccess
      ? 'You may read global and cross-branch summaries.'
      : 'Do not read other branches; work only from your own scope.',
  )

  const taskLine = describeOwnedTask(agent)
  if (taskLine) parts.push(taskLine)

  const reservedLine = describeReservedTasks(agent, deps)
  if (reservedLine) parts.push(reservedLine)

  const sections = parts.map((text, index) => ({
    name: `part-${index}`,
    text,
    priority: index,
  }))
  const budget = section.defaultTokenBudget
  const fitted = fitSections(sections, policy.tokenBudget || budget)
  const body = fitted.text
  const capped = truncate(body, section.maxCharsPerSection)
  return `<role-context role="${escapeAttribute(role)}">\n${capped.text}\n</role-context>`
}

/**
 * How much of a task's own description is folded into the role context.
 * Task text travels with the task, so a member that cannot inherit the Lead's
 * conversation still receives the acceptance criteria its work depends on.
 */
const RESERVED_DESCRIPTION_CHARS = 400
const OWNED_DESCRIPTION_CHARS = 200

/** A task description, budgeted and indented under its bullet. */
function indentedDetail(task, maxChars) {
  if (typeof task.description !== 'string') return ''
  const text = task.description.trim()
  if (text.length === 0) return ''
  const cut = truncate(text, maxChars).text
  return `\n    ${cut.replace(/\n+/g, '\n    ')}`
}

/**
 * Open tasks reserved for this agent's role — module 4's soft dispatch.
 *
 * Advisory by design: the plugin tells the agent which work is *its* role's, but
 * never claims anything on the agent's behalf. Claiming stays an explicit,
 * auditable tool call that the task guard can still reject.
 */
function describeReservedTasks(agent, deps) {
  if (typeof deps?.taskHintsFor !== 'function') return ''
  let hints
  try {
    hints = deps.taskHintsFor(agent)
  } catch {
    return ''
  }
  if (!Array.isArray(hints) || hints.length === 0) return ''
  const lines = hints.slice(0, 3).map((task) => {
    const subject = typeof task.subject === 'string' ? task.subject : '(no subject)'
    return `- ${task.id}: ${subject}${indentedDetail(task, RESERVED_DESCRIPTION_CHARS)}`
  })
  const more = hints.length > 3 ? `\n(+${hints.length - 3} more)` : ''
  return `Tasks reserved for your role — claim the one you should do:\n${lines.join('\n')}${more}`
}

/** Summarize the task this agent currently owns, when a team ledger is present. */
function describeOwnedTask(agent) {
  const teams = typeof agent.ctx?.get === 'function' ? agent.ctx.get('agentTeams') : undefined
  if (!teams || typeof teams.listTasks !== 'function') return ''
  let tasks
  try {
    tasks = teams.listTasks(agent)
  } catch {
    return ''
  }
  if (!Array.isArray(tasks)) return ''
  const mine = tasks.filter(
    (task) => task && task.status === 'in_progress' && (task.ownerName === undefined || isSameAgent(agent, task)),
  )
  if (mine.length === 0) return ''
  const lines = mine.slice(0, 3).map((task) => {
    const scopes = Array.isArray(task.writeScopes) && task.writeScopes.length > 0
      ? ` writeScopes=[${task.writeScopes.join(', ')}]`
      : ''
    return `- ${task.id} (rev ${task.revision}): ${task.subject}${scopes}${indentedDetail(task, OWNED_DESCRIPTION_CHARS)}`
  })
  return `Tasks you own now:\n${lines.join('\n')}`
}

function isSameAgent(agent, task) {
  const names = [agent?.name, agent?.memberName, agent?.ownerName].filter(
    (value) => typeof value === 'string' && value.length > 0,
  )
  return names.includes(task.ownerName)
}

/**
 * Shorten oversized text blocks inside messages without changing the message
 * list: the transcript keeps every role and every tool call/result pairing.
 *
 * @returns the original array reference when nothing changed
 */
function elideOversizedMessages(messages, policy, section) {
  if (!Array.isArray(messages)) return messages
  const perMessageCap = perMessageCharCap(policy, section)
  let changed = false
  const next = messages.map((message) => {
    const content = message?.content
    if (!Array.isArray(content)) return message
    let blockChanged = false
    const blocks = content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block
      if (block.text.length <= perMessageCap) return block
      blockChanged = true
      return { ...block, text: truncate(block.text, perMessageCap).text }
    })
    if (!blockChanged) return message
    changed = true
    return { ...message, content: blocks }
  })
  return changed ? next : messages
}

/**
 * Per-message character cap derived from the role budget. A message may use at
 * most a quarter of the role's budget, so one huge tool result cannot crowd out
 * the rest of the step.
 */
function perMessageCharCap(policy, section) {
  const budget = policy.tokenBudget || section.defaultTokenBudget
  const characters = Math.floor(budget / 0.25)
  return Math.max(1000, Math.floor(characters / 4))
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

export { estimateTokens }
