/**
 * Task guard: single-owner policy enforcement on top of the framework's
 * already-atomic claim path.
 *
 * VERIFIED CONTEXT (DSH 0.2.0-rc.2, built-in Agent Teams):
 *   The toolbox already serializes claims. `team_task_update` dispatches to
 *   `agentTeams.updateTask(caller, { taskId, expectedRevision, action })`, which
 *   runs inside `journal.transact(...)`, rejects a stale `expectedRevision`
 *   (`TEAM_TASK_STALE_REVISION`) and rejects a claim whose `ownerId` is another
 *   member (`TEAM_TASK_ALREADY_CLAIMED`). Re-implementing a lock here would be
 *   redundant AND weaker than the existing transaction.
 *
 * What this module adds, which the framework does NOT provide:
 *   1. Fail-fast stale-revision detection before dispatch (saves a round trip
 *      and gives the model an actionable message).
 *   2. Role binding: a configured role may only claim tasks reserved for it.
 *   3. Write-scope conflict detection against other in-progress tasks, turning
 *      the advisory `writeScopeWarnings` into a pre-dispatch decision.
 *   4. A uniform deny surface for the third-party `agent_teams_*` tool family,
 *      whose ledger has no Host service and therefore cannot be read here.
 */

import { classifyOwnership, readTaskId } from './ownership.js'
import { serviceOf, whenService } from './services.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{ resolveRoleFor: (agent: object|undefined) => { role: string, source: string } }} deps
 * @returns {() => void}
 */
export function registerTaskGuard(ctx, config, deps) {
  const section = config.taskGuard
  if (!section.enabled) return () => {}

  const claimTools = new Set(section.claimTools)
  const ownershipFields = section.ownershipFields

  const disposer = ctx.on('tools/pre-execute', async (exec, next) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !claimTools.has(toolName)) return next()

    try {
      const verdict = evaluateClaim(ctx, config, deps, exec)
      if (verdict) {
        ctx.logger?.warn?.(
          `[role-orchestrator] denied ${toolName}: ${verdict.reason}`,
        )
        return { kind: 'deny', reason: verdict.reason }
      }
    } catch (error) {
      // Never let guard bookkeeping break tool execution.
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[role-orchestrator] task-guard skipped (${message})`)
      if (section.strict) {
        return { kind: 'deny', reason: `task-guard could not verify ownership: ${message}` }
      }
    }
    return next()
  })

  /** @type {(() => void)[]} */
  const disposers = [disposer]

  // Order-independent final denial. `ctx.tools.guard()` runs strictly AFTER the
  // whole `tools/pre-execute` waterfall and "no guard can force-allow a call
  // another guard denied", so no other listener can allow a claim this guard
  // rejects. It is synchronous (`(exec) => string | undefined`), which suffices
  // because the team ledger's read path `agentTeams.getTask` is synchronous too.
  if (section.strict) {
    // `whenService`, because apply() may run before the tool registry exists.
    disposers.push(
      whenService(ctx, 'tools', (tools) => {
        if (typeof tools.guard !== 'function') return () => {}
        return tools.guard((execution) => {
          try {
            if (!claimTools.has(execution.name)) return undefined
            const taskId = readTaskId(execution.arguments)
            if (typeof taskId !== 'string') return undefined
            const teams = serviceOf(ctx, 'agentTeams')
            if (!teams || typeof teams.getTask !== 'function') return undefined
            const task = teams.getTask(execution.agent, taskId)
            const ownership = classifyOwnership(task, execution.agent, ownershipFields)
            if (ownership.state !== 'other') return undefined
            return `team task "${taskId}" is already owned by "${ownership.owner}" (single-owner invariant).`
          } catch {
            return undefined
          }
        })
      }),
    )
  }

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
 * @returns {{ reason: string }|undefined} a deny reason, or undefined to allow
 */
function evaluateClaim(ctx, config, deps, exec) {
  const section = config.taskGuard
  const args = exec.arguments
  const taskId = readTaskId(args)
  if (typeof taskId !== 'string') return undefined

  const action = args && typeof args === 'object' ? args.action : undefined
  if (action !== undefined && action !== 'claim') return undefined

  const teams = serviceOf(ctx, 'agentTeams')
  if (!teams || typeof teams.getTask !== 'function') return undefined

  const caller = exec.agent
  if (!caller) return undefined

  // 1. Revision freshness. The framework rejects a stale revision anyway; doing
  //    it here produces an actionable message without a dispatch.
  const expected = args && typeof args === 'object' ? args.expected_revision : undefined
  let task
  try {
    task = teams.getTask(caller, taskId)
  } catch (error) {
    // Unknown task or non-member caller: the real dispatch owns that error.
    return undefined
  }
  if (!task || typeof task !== 'object') return undefined

  if (
    section.strict &&
    typeof expected === 'number' &&
    typeof task.revision === 'number' &&
    task.revision !== expected
  ) {
    return {
      reason:
        `team task "${taskId}" revision ${expected} is stale (current ${task.revision}). ` +
        `Re-read it with team_task_get and retry with the current expected_revision.`,
    }
  }

  // 2. Single-owner policy across whichever ownership field this ledger uses.
  const ownership = classifyOwnership(task, caller, section.ownershipFields)
  if (ownership.state === 'other') {
    return {
      reason:
        `team task "${taskId}" is already owned by "${ownership.owner}" (field ${ownership.field}). ` +
        `One task has exactly one owner; use send_message to coordinate instead of claiming it.`,
    }
  }

  // 3. Role binding: only the role a task is reserved for may claim it.
  //    Reservations may be static config, an observed orchestration reservation,
  //    or a `[role:X]` marker in the task text.
  const requiredRole = deps.requiredRoleFor
    ? deps.requiredRoleFor(task)
    : readRequiredRole(task, taskId, config)
  if (typeof requiredRole === 'string' && requiredRole.length > 0) {
    const { role } = deps.resolveRoleFor(caller)
    if (role !== requiredRole) {
      return {
        reason:
          `team task "${taskId}" is reserved for role "${requiredRole}", but this agent's role is "${role}". ` +
          `Ask the Lead to reassign it if that is wrong.`,
      }
    }
  }

  // 4. Write-scope conflicts: two in-progress tasks must not share a writer.
  const conflict = findWriteScopeConflict(ctx, caller, task)
  if (conflict) return conflict

  return undefined
}

/**
 * A task may be reserved for a role via config `contextCompressor.roleAssignments`
 * reversed, or via an explicit per-task reservation map. The reservation map is
 * intentionally read from `taskGuard` so it stays configurable in the patch.
 */
function readRequiredRole(task, taskId, config) {
  const reservations = config.taskGuard.roleReservations
  if (reservations && typeof reservations === 'object') {
    const direct = reservations[taskId]
    if (typeof direct === 'string') return direct
  }
  if (typeof task.requiredRole === 'string') return task.requiredRole
  return undefined
}

function findWriteScopeConflict(ctx, caller, task) {
  const own = Array.isArray(task.writeScopes) ? task.writeScopes : []
  if (own.length === 0) return undefined
  const teams = serviceOf(ctx, 'agentTeams')
  if (!teams || typeof teams.listTasks !== 'function') return undefined
  let others
  try {
    others = teams.listTasks(caller)
  } catch {
    return undefined
  }
  if (!Array.isArray(others)) return undefined
  for (const candidate of others) {
    if (!candidate || candidate.id === task.id) continue
    if (candidate.status !== 'in_progress') continue
    const scopes = Array.isArray(candidate.writeScopes) ? candidate.writeScopes : []
    const overlap = own.find((scope) =>
      scopes.some((other) => scope === other || scope.startsWith(`${other}/`) || other.startsWith(`${scope}/`)),
    )
    if (overlap !== undefined) {
      return {
        reason:
          `claiming "${task.id}" would give two in-progress tasks the write scope "${overlap}" ` +
          `(already held by "${candidate.id}", owner ${candidate.ownerName ?? 'unknown'}). ` +
          `Resolve the overlap or serialize the work first.`,
      }
    }
  }
  return undefined
}
