/**
 * A read-only diagnostic tool so the plugin's live state is observable.
 *
 * This exists for two reasons:
 *   1. It is the plugin's only Inspect-visible surface: `cordis_inspect_query`
 *      with provider `Tool` proves that this bundle's `apply()` ran in the live
 *      Host, which an installation result alone does not establish.
 *   2. It lets a Lead confirm which role policy an agent is running under, which
 *      is otherwise invisible because the role is derived, not stored.
 *
 * Tool shapes follow the verified `ToolDefinition` contract:
 *   { name, description, parameters, output: { schema, render }, execute }
 * where `render(args, value)` returns `ContentBlock[]`.
 */

import { whenService } from './services.js'

export function registerStatusTool(ctx, config, deps) {
  // NOTE: `whenService`, not `serviceOf`. This plugin declares no `inject`, so
  // `apply()` may run BEFORE the tool registry is provided; a direct read there
  // returns `undefined` without throwing, and the tool would silently never
  // register. `whenService` defers registration until `tools` is ready.
  return whenService(ctx, 'tools', (tools) => {
    if (typeof tools.register !== 'function') return () => {}

    return tools.register({
      name: 'role_orchestrator_status',
      description:
        'Report Role Orchestrator state for the calling agent: resolved role, context budget, allowed scopes, and the tasks it owns. Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            roleSource: { type: 'string' },
            tokenBudget: { type: 'number' },
            sectionOrder: { type: 'number' },
            allowedScopes: { type: 'array', items: { type: 'string' } },
            deniedTools: { type: 'array', items: { type: 'string' } },
            ownedTasks: { type: 'array', items: { type: 'string' } },
            taskGuardEnabled: { type: 'boolean' },
            approvalGateEnabled: { type: 'boolean' },
            approvalMode: { type: 'string' },
            orchestrationEnabled: { type: 'boolean' },
            rolePool: { type: 'array', items: { type: 'string' } },
            roleAssignments: { type: 'array', items: { type: 'string' } },
            reservedTasks: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(_args, exec) {
        return buildStatus(config, deps, exec?.agent)
      },
    })
  })
}

/**
 * The single source of truth for reported state, shared by the model-facing tool
 * and the user-facing `/role-status` command so the two can never disagree.
 *
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{ resolveRoleFor: (agent: object|undefined) => { role: string, source: string, policy: object }, ownedTasksFor: (agent: object|undefined) => string[] }} deps
 * @param {object|undefined} agent
 */
export function buildStatus(config, deps, agent) {
  const { role, source, policy } = deps.resolveRoleFor(agent)
  const orchestration = deps.orchestration
  const rolePool = Array.isArray(config.orchestration.rolePool) ? config.orchestration.rolePool : []
  return {
    role,
    roleSource: source,
    tokenBudget: policy.tokenBudget,
    sectionOrder: config.contextCompressor.sectionOrder,
    allowedScopes: Array.isArray(policy.allowedScopes) ? policy.allowedScopes : [],
    deniedTools: Array.isArray(policy.deniedTools) ? policy.deniedTools : [],
    ownedTasks: deps.ownedTasksFor(agent),
    taskGuardEnabled: config.taskGuard.enabled,
    approvalGateEnabled: config.approvalGate.enabled,
    approvalMode: config.approvalGate.mode,
    orchestrationEnabled: config.orchestration.enabled,
    rolePool,
    // Rendered as strings so the JSON Schema stays flat and stable.
    roleAssignments: orchestration
      ? orchestration.assignments().map((entry) => `${entry.role} <- ${entry.agentId}`)
      : [],
    reservedTasks: orchestration
      ? orchestration.reservations().map(([taskId, reserved]) => `${taskId} <- ${reserved}`)
      : [],
  }
}
