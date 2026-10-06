/**
 * Role Orchestrator — a Host-only bundle for DeepSeek Harness 0.2.0-rc.2.
 *
 * Three cooperating modules, each bound to a verified extension point:
 *
 *   context-compressor  per-role dynamic prompt context + tool restriction +
 *                       bounded text elision on `agent/pre-step`
 *   task-guard          single-owner / role-binding / write-scope policy on
 *                       `tools/pre-execute`, layered on the framework's
 *                       already-atomic revision CAS
 *   approval-gate       human approval for high-risk tools via an `ask`
 *                       decision on `tools/pre-execute`
 *
 * Deliberately dependency-free: a bundle installed into a profile cannot
 * resolve `@deepseek-ai/*` from the DSH installation, so this package imports
 * nothing. Optional services are reached through `ctx.get(name)`, which returns
 * `undefined` instead of throwing, so the plugin stays active in profiles that
 * lack Agent Teams or the approval service.
 */

import { normalizeConfig } from './src/config.js'
import { buildRoleTable, policyFor, resolveRole } from './src/roles.js'
import { registerContextCompressor } from './src/context-compressor.js'
import { registerTaskGuard } from './src/task-guard.js'
import { registerApprovalGate } from './src/approval-gate.js'
import { registerStatusTool } from './src/status-tool.js'
import { serviceOf } from './src/services.js'
import { agentIdentities } from './src/ownership.js'

export const name = 'role-orchestrator'

/**
 * @param {*} ctx Cordis context for this plugin row
 * @param {unknown} rawConfig the `config` object from cordis.patch.yml
 * @returns {() => void} aggregate disposer
 */
export function apply(ctx, rawConfig) {
  const { config, warnings } = normalizeConfig(rawConfig)
  for (const warning of warnings) {
    ctx.logger?.warn?.(`[role-orchestrator] config: ${warning}`)
  }

  const roleTable = buildRoleTable(config.contextCompressor)

  /**
   * Resolve the role label and effective policy for an agent. Intentionally not
   * cached: an agent's identity fields (name/role) can be populated after
   * `agent/created`, and resolution is a handful of string comparisons.
   */
  const resolveRoleFor = (agent) => {
    const resolved = resolveRole(agent, config.contextCompressor, roleTable)
    return {
      role: resolved.role,
      source: resolved.source,
      policy: policyFor(
        roleTable,
        resolved.role,
        config.contextCompressor.defaultTokenBudget,
      ),
    }
  }

  /** Task ids owned by this agent, for the status tool. */
  const ownedTasksFor = (agent) => {
    const teams = serviceOf(ctx, 'agentTeams')
    if (!agent || !teams || typeof teams.listTasks !== 'function') return []
    try {
      const identities = agentIdentities(agent)
      return teams
        .listTasks(agent)
        .filter(
          (task) =>
            task &&
            task.status !== 'deleted' &&
            typeof task.ownerName === 'string' &&
            identities.includes(task.ownerName),
        )
        .map((task) => String(task.id))
    } catch {
      return []
    }
  }

  // Order matters: the waterfall stops at the first listener that decides, so a
  // deterministic ownership denial is produced before a human is asked.
  const disposers = [
    registerTaskGuard(ctx, config, { resolveRoleFor }),
    registerApprovalGate(ctx, config),
    registerContextCompressor(ctx, config, { resolveRoleFor, isEnabled: () => true }),
    registerStatusTool(ctx, config, { resolveRoleFor, ownedTasksFor }),
  ]

  ctx.logger?.info?.(
    `[role-orchestrator] active — compressor=${config.contextCompressor.enabled} ` +
      `taskGuard=${config.taskGuard.enabled} approvalGate=${config.approvalGate.enabled} ` +
      `roles=${Object.keys(roleTable).length}`,
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (error) {
        ctx.logger?.warn?.(`[role-orchestrator] teardown: ${String(error)}`)
      }
    }
  }
}
