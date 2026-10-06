/**
 * Role -> context policy mapping.
 *
 * A "role" here is a plugin-owned label, not a Harness primitive: on 0.2.0-rc.2
 * the Host `Agent` contract exposes only `id`, so a role is resolved from
 * configuration (preset/member-name assignment) and falls back to a default
 * policy. See CORRECTIONS.md, finding F-4.
 *
 * @typedef {object} ContextPolicy
 * @property {number} tokenBudget        Approximate token ceiling for injected role context.
 * @property {string[]} allowedScopes    Logical data scopes this role may see.
 * @property {string[]} priorityFields   Fields kept first when trimming context.
 * @property {boolean} crossBranchAccess Whether the role may read global/branch summaries.
 * @property {string} charter            Short role instructions injected as prompt text.
 */

/** @type {Record<string, ContextPolicy>} */
export const BUILTIN_POLICIES = {
  default: {
    tokenBudget: 4000,
    allowedScopes: ['task'],
    priorityFields: ['task_id', 'status', 'goal'],
    crossBranchAccess: false,
    charter: 'You own exactly the task you claimed. Keep updates short and factual.',
  },
  文献检索Agent: {
    tokenBudget: 4000,
    allowedScopes: ['literature', 'query'],
    priorityFields: ['title', 'abstract', 'relevance_score'],
    crossBranchAccess: false,
    deniedTools: ['write', 'edit'],
    charter:
      'You are the literature retrieval role. Return ranked sources with title, abstract and relevance only; do not interpret evidence.',
  },
  Claim分析Agent: {
    tokenBudget: 6000,
    allowedScopes: ['claim', 'evidence', 'literature'],
    priorityFields: ['claim_text', 'strongest_evidence', 'confidence'],
    crossBranchAccess: true,
    charter:
      'You are the claim-analysis role. For each claim, state the strongest supporting evidence, the strongest counter-evidence, and a confidence value.',
  },
  验证Agent: {
    tokenBudget: 5000,
    allowedScopes: ['evidence', 'claim', 'verification'],
    priorityFields: ['claim_text', 'reproduction_steps', 'verdict'],
    crossBranchAccess: true,
    charter:
      'You are the verification role. Independently reproduce the claim before judging it; report inconclusive rather than guessing.',
  },
  审查Agent: {
    tokenBudget: 5000,
    allowedScopes: ['claim', 'evidence', 'review'],
    priorityFields: ['artifact_ref', 'open_questions', 'risk_notes'],
    crossBranchAccess: true,
    charter:
      'You are the review role. Look for defects, missing verification and unstated assumptions; you do not write the artifact you review.',
  },
}

/**
 * Build the effective role policy table from built-ins plus user overrides.
 * @param {{ rolePolicies?: Record<string, object>, defaultRole?: string }} section
 */
export function buildRoleTable(section = {}) {
  /** @type {Record<string, ContextPolicy>} */
  const table = {}
  for (const [name, policy] of Object.entries(BUILTIN_POLICIES)) {
    table[name] = { ...policy }
  }
  const overrides = section.rolePolicies
  if (overrides && typeof overrides === 'object') {
    for (const [name, policy] of Object.entries(overrides)) {
      if (!policy || typeof policy !== 'object') continue
      table[name] = { ...(table[name] ?? BUILTIN_POLICIES.default), ...policy }
    }
  }
  return table
}

/** Identity fields that may carry a role label on an Agent-like object. */
const IDENTITY_FIELDS = ['role', 'roleName', 'name', 'memberName', 'title', 'preset', 'agentPreset']

/**
 * Resolve the role label for an agent.
 *
 * Resolution order:
 *   1. `roleAssignments[<any identity field value>]`
 *   2. an identity field that already names a known role
 *   3. `defaultRole`
 *
 * @param {object|undefined} agent
 * @param {{ roleAssignments?: Record<string, string>, defaultRole?: string }} section
 * @param {Record<string, ContextPolicy>} table
 * @returns {{ role: string, source: string, candidates: string[] }}
 */
export function resolveRole(agent, section, table) {
  const candidates = []
  if (agent && typeof agent === 'object') {
    for (const field of IDENTITY_FIELDS) {
      const value = agent[field]
      if (typeof value === 'string' && value.length > 0) candidates.push(value)
    }
    if (typeof agent.id === 'string' && agent.id.length > 0) candidates.push(agent.id)
  }
  const assignments = section?.roleAssignments ?? {}
  for (const candidate of candidates) {
    const assigned = assignments[candidate]
    if (typeof assigned === 'string' && assigned.length > 0) {
      return { role: assigned, source: `assignment:${candidate}`, candidates }
    }
  }
  for (const candidate of candidates) {
    if (Object.hasOwn(table, candidate)) {
      return { role: candidate, source: 'identity', candidates }
    }
  }
  const fallback = typeof section?.defaultRole === 'string' ? section.defaultRole : 'default'
  return { role: Object.hasOwn(table, fallback) ? fallback : 'default', source: 'default', candidates }
}

/**
 * @param {Record<string, ContextPolicy>} table
 * @param {string} role
 * @param {number} defaultTokenBudget
 * @returns {ContextPolicy}
 */
export function policyFor(table, role, defaultTokenBudget) {
  const policy = table[role] ?? table.default ?? BUILTIN_POLICIES.default
  return {
    ...policy,
    tokenBudget:
      Number.isFinite(policy.tokenBudget) && policy.tokenBudget > 0
        ? policy.tokenBudget
        : defaultTokenBudget,
  }
}
