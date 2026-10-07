/**
 * Config normalization and validation.
 *
 * The bundle deliberately declares no `export const Config`, because a plugin
 * installed into a profile cannot resolve `@deepseek-ai/*` packages from the
 * DSH installation: profile `node_modules` contains only profile-installed
 * bundles. Passing raw `config` from `cordis.patch.yml` to `apply(ctx, config)`
 * and validating it here keeps the package dependency-free (zero imports).
 *
 * @typedef {object} NormalizedConfig
 * @property {ContextCompressorConfig} contextCompressor
 * @property {TaskGuardConfig} taskGuard
 * @property {ApprovalGateConfig} approvalGate
 */

/** @typedef {{ enabled: boolean, defaultTokenBudget: number, maxCharsPerSection: number, rolePolicies: Record<string, object>, roleAssignments: Record<string, string>, defaultRole: string }} ContextCompressorConfig */
/** @typedef {{ enabled: boolean, claimTools: string[], ownershipFields: string[], releaseTools: string[], strict: boolean }} TaskGuardConfig */
/** @typedef {{ enabled: boolean, highRiskTools: string[], mediumRiskTools: string[], denyOnUnavailableApproval: boolean, extraRules: object[] }} ApprovalGateConfig */

export const DEFAULT_CONFIG = {
  contextCompressor: {
    enabled: true,
    defaultTokenBudget: 4000,
    maxCharsPerSection: 8000,
    // Section order space (verified SECTION_ORDERS): DEPLOYMENT_PERSONA_PREFIX 0,
    // PLAN_POLICY 500, TEAM_POLICY 600, PTC_ONLY 800, FILE_REFERENCE 900.
    // 650 places the role charter after team policy and before tool sections.
    sectionOrder: 650,
    rolePolicies: {},
    roleAssignments: {},
    defaultRole: 'default',
  },
  taskGuard: {
    enabled: true,
    // Both team systems present in this profile. VERIFIED against the live
    // tool registry on 0.2.0-rc.2: the built-in Harness board exposes
    // `team_task_update` with `action: 'claim'` (there is NO `team_task_claim`
    // tool), and @nanmicoder/dsh-agent-teams exposes `agent_teams_claim_task`.
    claimTools: ['team_task_update', 'agent_teams_claim_task'],
    releaseTools: ['team_task_complete', 'team_task_release', 'agent_teams_update_task'],
    ownershipFields: ['ownerName', 'owner', 'assignee', 'assignedRole', 'claimedBy'],
    roleReservations: {},
    strict: false,
  },
  approvalGate: {
    enabled: true,
    mode: 'ask',
    mediumAction: 'ask',
    highRiskTools: [],
    mediumRiskTools: [],
    denyOnUnavailableApproval: true,
    extraRules: [],
  },
  orchestration: {
    enabled: true,
    // EMPTY BY DEFAULT: nothing is auto-assigned until an operator names the
    // roles worth handing out. Assignment only selects which configured policy
    // applies; it never widens access.
    rolePool: [],
    assignToLead: false,
    reserveFromMarkers: true,
    markerPattern: '\\[role:\\s*([^\\]\\s]+)\\s*\\]',
    taskReservations: {},
    taskCreateTools: ['team_task_create', 'agent_teams_create_task'],
  },
}

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function mergeSection(defaults, incoming, warnings, name) {
  if (incoming === undefined) return { ...defaults }
  if (!isPlainObject(incoming)) {
    warnings.push(`config.${name} must be an object; using defaults`)
    return { ...defaults }
  }
  const out = { ...defaults }
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in defaults)) {
      warnings.push(`config.${name}.${key} is not a recognized option; ignored`)
      continue
    }
    const expected = Array.isArray(defaults[key]) ? 'array' : typeof defaults[key]
    const actual = Array.isArray(value) ? 'array' : typeof value
    if (expected === 'object' && key !== 'rolePolicies' && key !== 'roleAssignments') {
      out[key] = value
      continue
    }
    if (expected === 'array' && actual !== 'array') {
      warnings.push(`config.${name}.${key} must be an array; using default`)
      continue
    }
    if (expected !== 'array' && expected !== 'object' && actual !== expected) {
      warnings.push(`config.${name}.${key} must be a ${expected}; using default`)
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Normalize a raw patch config into a complete, defensively-typed config.
 * @param {unknown} raw
 * @returns {{ config: NormalizedConfig, warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const warnings = []
  const source = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) {
    warnings.push('plugin config must be an object; using defaults')
  }
  const config = {
    contextCompressor: mergeSection(
      DEFAULT_CONFIG.contextCompressor,
      source.contextCompressor,
      warnings,
      'contextCompressor',
    ),
    taskGuard: mergeSection(DEFAULT_CONFIG.taskGuard, source.taskGuard, warnings, 'taskGuard'),
    approvalGate: mergeSection(
      DEFAULT_CONFIG.approvalGate,
      source.approvalGate,
      warnings,
      'approvalGate',
    ),
    orchestration: mergeSection(
      DEFAULT_CONFIG.orchestration,
      source.orchestration,
      warnings,
      'orchestration',
    ),
  }
  if (!Number.isFinite(config.contextCompressor.defaultTokenBudget) ||
      config.contextCompressor.defaultTokenBudget <= 0) {
    warnings.push('config.contextCompressor.defaultTokenBudget must be a positive number; using 4000')
    config.contextCompressor.defaultTokenBudget = DEFAULT_CONFIG.contextCompressor.defaultTokenBudget
  }
  return { config, warnings }
}
