/**
 * A read-only diagnostic tool so the plugin's live state is observable.
 *
 * This exists for two reasons:
 *   1. It is the plugin's only Inspect-visible surface: `cordis_inspect_query`
 *      with provider `Tool` proves that this bundle's `apply()` actually ran in
 *      the live Host, which installation logs alone do not establish.
 *   2. It lets a Lead confirm which role policy an agent is running under, which
 *      is otherwise invisible because the role is derived, not stored.
 *
 * Tool shapes follow the verified `ToolDefinition` contract:
 *   { name, description, parameters, output: { schema, render }, execute }
 * where `render(args, value)` returns `ContentBlock[]`.
 */

import { serviceOf } from './services.js'

export function registerStatusTool(ctx, config, deps) {
  const tools = serviceOf(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') return () => {}

  const dispose = tools.register({
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
        },
      },
      render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    async execute(_args, exec) {
      const agent = exec?.agent
      const { role, source, policy } = deps.resolveRoleFor(agent)
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
      }
    },
  })

  return typeof dispose === 'function' ? dispose : () => {}
}
