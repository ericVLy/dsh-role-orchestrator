/**
 * The user-facing half of the status surface: a global Host command.
 *
 * `ctx.tools.register()` (see status-tool.js) exposes a capability to the
 * **model**. It does not appear anywhere in the UI, so a human cannot invoke it.
 * A user-invokable entry point is a Host command from `ctx.commands`, which the
 * command registry lists for the agent and the Web UI renders in its slash menu.
 *
 * Verified `CommandDefinition` contract:
 *   { name, description, input?, recordInput?, handler(invocation) }
 * where `name` carries no leading slash and the handler returns
 *   { kind: 'success', text? } | { kind: 'error', text }
 *
 * Registration goes through `whenService`, because `apply()` may run before the
 * command registry has been provided (see services.js).
 */

import { whenService } from './services.js'
import { buildStatus } from './status-tool.js'

export function registerStatusCommand(ctx, config, deps) {
  return whenService(ctx, 'commands', (commands) => {
    if (typeof commands.register !== 'function') return () => {}

    return commands.register({
      name: 'role-status',
      description:
        "Show this session's Role Orchestrator state: role, context budget, allowed scopes, and the gates.",
      handler: (invocation) => {
        try {
          return { kind: 'success', text: formatStatus(buildStatus(config, deps, invocation?.agent)) }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { kind: 'error', text: `role-status could not read plugin state: ${message}` }
        }
      },
    })
  })
}

/** Human-readable rendering; the model-facing tool returns the raw object. */
export function formatStatus(status) {
  const list = (values) => (values.length > 0 ? values.join(', ') : '(none)')
  return [
    `Role Orchestrator — role "${status.role}" (source: ${status.roleSource})`,
    `  context budget : ${status.tokenBudget} tokens (section order ${status.sectionOrder})`,
    `  allowed scopes : ${list(status.allowedScopes)}`,
    `  denied tools   : ${list(status.deniedTools)}`,
    `  owned tasks    : ${list(status.ownedTasks)}`,
    `  task guard     : ${status.taskGuardEnabled ? 'enabled' : 'disabled'}`,
    `  approval gate  : ${status.approvalGateEnabled ? `enabled (${status.approvalMode})` : 'disabled'}`,
    `  orchestration  : ${status.orchestrationEnabled ? 'enabled' : 'disabled'} (pool: ${list(status.rolePool)})`,
    `  assignments    : ${list(status.roleAssignments)}`,
    `  reservations   : ${list(status.reservedTasks)}`,
  ].join('\n')
}
