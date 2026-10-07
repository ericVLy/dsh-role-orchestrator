/**
 * Risk evaluation for a pending tool call.
 *
 * Levels:
 *   low    -> allow
 *   medium -> ask (surface a human decision card; the session approval policy decides)
 *   high   -> require an explicit human approval before dispatch
 *
 * @typedef {'low'|'medium'|'high'} RiskLevel
 * @typedef {{ level: RiskLevel, reason: string, rule: string }} RiskVerdict
 * @typedef {{ id: string, level: RiskLevel, tools?: string[], pattern?: RegExp, inspect?: string, reason: string }} RiskRule
 */

/** Tool-name driven rules. Names are matched against the live tool registry. */
/** @type {RiskRule[]} */
export const BUILTIN_RULES = [
  {
    id: 'profile-mutation',
    level: 'high',
    tools: ['plugin_manager'],
    reason:
      'plugin_manager changes the profile for every session and can install packages that run build scripts.',
  },
  {
    id: 'process-control',
    level: 'high',
    // NOTE: there is no `team_task_delete` tool. The built-in board deletes a
    // task through `team_task_update` with `action: 'delete'`, which needs its
    // own pattern rule below — a bare tool-name entry here would gate EVERY
    // task update, including ordinary status changes.
    tools: ['interrupt_agent', 'agent_teams_remove_member', 'agent_teams_delete'],
    reason: 'Stops or removes a running member/team; other agents may be mid-write.',
  },
  {
    id: 'task-record-deletion',
    level: 'high',
    tools: ['team_task_update'],
    pattern: /"action"\s*:\s*"delete"/,
    reason: 'Deletes a shared task record; coordination history is lost and dependents would be orphaned.',
  },
  {
    id: 'task-reassignment',
    level: 'medium',
    tools: ['team_task_update'],
    pattern: /"action"\s*:\s*"reassign"/,
    reason: 'Changes which member owns a task; another agent may already be working from the old owner.',
  },
  {
    id: 'destructive-shell',
    level: 'high',
    tools: ['pwsh', 'bash'],
    pattern:
      /(Remove-Item|\brm\s+-|\brmdir\b|\bdel\s|\bformat\b|git\s+reset\s+--hard|git\s+push|git\s+clean\s+-|Stop-Process|Set-ExecutionPolicy|icacls\s|takeown\s|reg\s+delete|shutdown\b|Clear-Disk)/i,
    reason: 'Shell command matches a destructive or state-changing pattern.',
  },
  {
    id: 'credential-access',
    level: 'high',
    tools: ['pwsh', 'bash', 'read'],
    pattern: /(\.credentials|\.npmrc|id_rsa|\.env\b|credential|password|passwd|token\b|api[_-]?key)/i,
    reason: 'The call touches credential-shaped paths or values.',
  },
  {
    id: 'bulk-fan-out',
    level: 'medium',
    tools: ['workflow'],
    reason: 'A workflow fans work out across many subagents; confirm scope and cost first.',
  },
  {
    id: 'durable-member-creation',
    level: 'medium',
    tools: ['spawn_teammate', 'agent_teams_add_member'],
    reason: 'Creates a durable member that consumes tokens until it is removed.',
  },
  {
    id: 'job-cancellation',
    level: 'medium',
    tools: ['job_kill'],
    reason: 'Cancels background work that may hold partially written artifacts.',
  },
  {
    id: 'branch-history-rewrite',
    level: 'medium',
    tools: ['pwsh', 'bash'],
    pattern: /(git\s+commit|git\s+merge|git\s+rebase|git\s+checkout|git\s+branch\s+-D)/i,
    reason: 'Rewrites or advances repository history.',
  },
]

function serializeArguments(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

/**
 * Evaluate one tool call.
 * @param {string} toolName
 * @param {unknown} args
 * @param {import('./config.js').ApprovalGateConfig} section
 * @returns {RiskVerdict}
 */
export function evaluateRisk(toolName, args, section) {
  const high = new Set(section?.highRiskTools ?? [])
  const medium = new Set(section?.mediumRiskTools ?? [])
  if (high.has(toolName)) {
    return { level: 'high', reason: `Tool "${toolName}" is listed in highRiskTools.`, rule: 'config:high' }
  }
  if (medium.has(toolName)) {
    return {
      level: 'medium',
      reason: `Tool "${toolName}" is listed in mediumRiskTools.`,
      rule: 'config:medium',
    }
  }
  const custom = Array.isArray(section?.extraRules) ? section.extraRules : []
  for (const rule of [...custom, ...BUILTIN_RULES]) {
    if (!rule || typeof rule !== 'object') continue
    if (typeof rule.level !== 'string') continue
    if (Array.isArray(rule.tools) && !rule.tools.includes(toolName)) continue
    let pattern = rule.pattern
    if (typeof pattern === 'string') {
      try {
        pattern = new RegExp(pattern, 'i')
      } catch {
        continue
      }
    }
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0
      if (!pattern.test(serializeArguments(args))) continue
    }
    return {
      level: rule.level,
      reason: typeof rule.reason === 'string' ? rule.reason : `Matched rule ${rule.id ?? 'unnamed'}.`,
      rule: String(rule.id ?? 'unnamed'),
    }
  }
  return { level: 'low', reason: '', rule: 'none' }
}
