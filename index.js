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
import { registerStatusCommand } from './src/status-command.js'
import {
  createOrchestrationState,
  registerOrchestration,
  requiredRoleFor as requiredRoleForImpl,
  reservedTaskHints,
} from './src/orchestration.js'
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

  // Module 4 state: explicit role assignments and task reservations.
  const orchestration = createOrchestrationState()

  /**
   * The role an agent explicitly deserves, before any pool assignment: a
   * configured assignment or an identity field that names a known role.
   * `undefined` means "this agent is a candidate for pool assignment".
   */
  const explicitRoleFor = (agent) => {
    const resolved = resolveRole(agent, config.contextCompressor, roleTable)
    return resolved.source === 'default' ? undefined : resolved.role
  }

  /**
   * Resolve the role label and effective policy for an agent.
   *
   * Precedence: the orchestration ledger (an assignment made at `agent/created`)
   * → configuration or identity → the default role. The ledger is consulted
   * first so an assignment is stable for the agent's whole lifetime instead of
   * being re-derived from fields that can change.
   */
  const resolveRoleFor = (agent) => {
    const assigned = orchestration.roleOf(agent?.id)
    if (typeof assigned === 'string' && assigned.length > 0) {
      return {
        role: assigned,
        source: 'orchestration',
        policy: policyFor(roleTable, assigned, config.contextCompressor.defaultTokenBudget),
      }
    }
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

  /** The role a task is reserved for, or undefined. Shared with the guard. */
  const requiredRoleFor = (task) => requiredRoleForImpl(orchestration, config, task)

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

  /** Tasks reserved for this agent's role that are still open (soft dispatch). */
  const taskHintsFor = (agent) => {
    if (!config.orchestration.enabled) return []
    const teams = serviceOf(ctx, 'agentTeams')
    if (!agent || !teams || typeof teams.listTasks !== 'function') return []
    try {
      const { role } = resolveRoleFor(agent)
      return reservedTaskHints(orchestration, config, role, teams.listTasks(agent))
    } catch {
      return []
    }
  }

  // Creation precedes the readers so the first `resolveRoleFor` call sees an
  // assignment. Registration order is also significant: `registerTaskGuard` is
  // listed first so a deterministic ownership denial precedes a human prompt.
  const disposers = [
    registerOrchestration(ctx, config, { state: orchestration, explicitRoleFor }),
    registerTaskGuard(ctx, config, { resolveRoleFor, requiredRoleFor }),
    registerApprovalGate(ctx, config),
    registerContextCompressor(ctx, config, {
      resolveRoleFor,
      taskHintsFor,
      isEnabled: () => true,
    }),
    registerStatusTool(ctx, config, { resolveRoleFor, ownedTasksFor, orchestration }),
    registerStatusCommand(ctx, config, { resolveRoleFor, ownedTasksFor, orchestration }),
  ]

  ctx.logger?.info?.(
    `[role-orchestrator] active — compressor=${config.contextCompressor.enabled} ` +
      `taskGuard=${config.taskGuard.enabled} approvalGate=${config.approvalGate.enabled} ` +
      `orchestration=${config.orchestration.enabled} ` +
      `roles=${Object.keys(roleTable).length} pool=${config.orchestration.rolePool.length}`,
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
