/**
 * Module 4 — Lead orchestration: automatic role assignment and task role
 * reservation.
 *
 * The first three modules are reactive: they police and shape behaviour that
 * something else initiates. This module initiates.
 *
 *   1. ROLE ASSIGNMENT. Roles were previously *derived* on every read from
 *      config or from an identity field, and were therefore unstable and
 *      impossible to display. Here a per-agent ledger makes a role an explicit,
 *      stable fact: assigned once, held until the agent is disposed, and visible
 *      to the compressor, the guard, and the status surfaces.
 *
 *   2. TASK RESERVATION. A task can be reserved for a role, so the guard rejects
 *      a claim by the wrong role. Reservations come from three places, in
 *      precedence order: an observed reservation, static config, and a marker
 *      embedded in the task's own subject or description (`[role:验证Agent]`).
 *      The marker path needs no event interception at all, because the guard
 *      already reads the task view at claim time.
 *
 * SAFETY: `rolePool` is empty by default, so nothing is auto-assigned and no
 * capability changes until an operator opts in. Assignment never widens access —
 * it only picks which configured policy applies.
 */

import { serviceOf } from './services.js'

/** Default marker: `[role:SomeRole]`. */
const DEFAULT_MARKER_PATTERN = '\\[role:\\s*([^\\]\\s]+)\\s*\\]'

/**
 * In-process ledger. Deliberately not persisted: per the platform guidance the
 * session log is the only source of truth, and this is a derived cache that is
 * rebuilt as agents are created.
 */
export function createOrchestrationState() {
  /** @type {Map<string, string>} agentId -> role */
  const roleByAgent = new Map()
  /** @type {Map<string, string>} role -> agentId */
  const agentByRole = new Map()
  /** @type {Map<string, string>} taskId -> role */
  const reservationByTask = new Map()

  return {
    roleByAgent,
    agentByRole,
    reservationByTask,

    /** @param {string} agentId */
    roleOf(agentId) {
      return typeof agentId === 'string' ? roleByAgent.get(agentId) : undefined
    },

    /**
     * Assign `role` to `agentId`, releasing the role it previously held.
     * @returns {string} the assigned role
     */
    assign(agentId, role) {
      const previous = roleByAgent.get(agentId)
      if (previous === role) return role
      if (previous !== undefined && agentByRole.get(previous) === agentId) {
        agentByRole.delete(previous)
      }
      roleByAgent.set(agentId, role)
      agentByRole.set(role, agentId)
      return role
    },

    /** @returns {string|undefined} the role that was released */
    release(agentId) {
      const role = roleByAgent.get(agentId)
      if (role === undefined) return undefined
      roleByAgent.delete(agentId)
      if (agentByRole.get(role) === agentId) agentByRole.delete(role)
      return role
    },

    isRoleTaken(role) {
      return agentByRole.has(role)
    },

    reserve(taskId, role) {
      if (typeof taskId !== 'string' || taskId.length === 0) return undefined
      reservationByTask.set(taskId, role)
      return role
    },

    reservationFor(taskId) {
      return typeof taskId === 'string' ? reservationByTask.get(taskId) : undefined
    },

    reservations() {
      return [...reservationByTask.entries()]
    },

    /** Assignments as a stable, sortable snapshot for reporting. */
    assignments() {
      return [...roleByAgent.entries()]
        .map(([agentId, role]) => ({ agentId, role }))
        .sort((a, b) => a.role.localeCompare(b.role))
    },
  }
}

/** Build (and memoize) the marker regex for a config section. */
const patternCache = new Map()
function markerPattern(section) {
  const source =
    typeof section.markerPattern === 'string' && section.markerPattern.length > 0
      ? section.markerPattern
      : DEFAULT_MARKER_PATTERN
  let compiled = patternCache.get(source)
  if (compiled === undefined) {
    try {
      compiled = new RegExp(source, 'i')
    } catch {
      compiled = new RegExp(DEFAULT_MARKER_PATTERN, 'i')
    }
    patternCache.set(source, compiled)
  }
  return compiled
}

/**
 * Read a role from an explicit `[role:X]` marker in any of the given strings.
 * @returns {string|undefined}
 */
export function roleFromMarkers(section, ...texts) {
  if (!section || section.reserveFromMarkers !== true) return undefined
  const pattern = markerPattern(section)
  for (const text of texts) {
    if (typeof text !== 'string' || text.length === 0) continue
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match && typeof match[1] === 'string' && match[1].length > 0) return match[1]
  }
  return undefined
}

/**
 * The role a task is reserved for, or `undefined` when it is unreserved.
 * Precedence: observed reservation → orchestration config → legacy taskGuard
 * config → marker in the task text → the task's own `requiredRole` field.
 *
 * @param {ReturnType<typeof createOrchestrationState>} state
 * @param {import('./config.js').NormalizedConfig} config
 * @param {object|undefined} task
 * @returns {string|undefined}
 */
export function requiredRoleFor(state, config, task) {
  if (!task || typeof task !== 'object') return undefined
  const taskId = typeof task.id === 'string' ? task.id : undefined

  if (taskId !== undefined && state) {
    const observed = state.reservationFor(taskId)
    if (typeof observed === 'string') return observed
  }

  for (const table of [
    config?.orchestration?.taskReservations,
    config?.taskGuard?.roleReservations,
  ]) {
    if (taskId === undefined || !table || typeof table !== 'object') continue
    const configured = table[taskId]
    if (typeof configured === 'string' && configured.length > 0) return configured
  }

  const fromMarker = roleFromMarkers(config?.orchestration, task.subject, task.description)
  if (fromMarker !== undefined) return fromMarker

  if (typeof task.requiredRole === 'string' && task.requiredRole.length > 0) {
    return task.requiredRole
  }
  return undefined
}

/**
 * Tasks reserved for `role` that are still open — the soft-dispatch hint shown
 * to an agent in its role context. Advisory only: it never claims anything.
 */
export function reservedTaskHints(state, config, role, tasks) {
  if (typeof role !== 'string' || !Array.isArray(tasks)) return []
  return tasks.filter(
    (task) =>
      task &&
      task.status !== 'deleted' &&
      task.status !== 'completed' &&
      requiredRoleFor(state, config, task) === role,
  )
}

/**
 * Register the orchestration listeners.
 *
 * @param {*} ctx
 * @param {import('./config.js').NormalizedConfig} config
 * @param {{ state: ReturnType<typeof createOrchestrationState>,
 *           explicitRoleFor: (agent: object|undefined) => string|undefined,
 *           onAssigned?: (agentId: string, role: string) => void }} deps
 * @returns {() => void}
 */
export function registerOrchestration(ctx, config, deps) {
  const section = config.orchestration
  if (!section.enabled) return () => {}

  const disposers = []

  // 1 + 2. Assignment and release follow the agent lifecycle. `agent/created` is
  // a serial, awaited event, so the listener stays synchronous and cheap.
  disposers.push(
    ctx.on('agent/created', (payload) => {
      try {
        assignForAgent(ctx, section, deps, payload?.agent)
      } catch (error) {
        ctx.logger?.warn?.(`[role-orchestrator] role assignment skipped: ${describe(error)}`)
      }
    }),
  )

  disposers.push(
    ctx.on('agent/disposed', (payload) => {
      try {
        deps.state.release(payload?.agent?.id)
      } catch {
        /* teardown must not throw */
      }
    }),
  )

  // 3. Record markers found on freshly created tasks so the reservation is
  // visible in status even before anyone attempts a claim. Pure observation:
  // the decision returned by `next()` is passed through untouched.
  disposers.push(
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        observeTaskCreation(section, deps, exec, result)
      } catch (error) {
        ctx.logger?.warn?.(`[role-orchestrator] reservation skipped: ${describe(error)}`)
      }
      return decision
    }),
  )

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

function assignForAgent(ctx, section, deps, agent) {
  const agentId = agent?.id
  if (typeof agentId !== 'string' || agentId.length === 0) return

  // An explicit configuration or identity match always wins and is recorded so
  // it becomes stable for the agent's lifetime.
  const explicit = deps.explicitRoleFor(agent)
  if (typeof explicit === 'string' && explicit.length > 0) {
    deps.state.assign(agentId, explicit)
    deps.onAssigned?.(agentId, explicit)
    return
  }

  const pool = Array.isArray(section.rolePool) ? section.rolePool : []
  if (pool.length === 0) return

  // The Lead directs the team; it is not a pool member unless asked to be.
  if (section.assignToLead !== true && isLead(ctx, agent)) return

  const free = pool.find(
    (role) => typeof role === 'string' && role.length > 0 && !deps.state.isRoleTaken(role),
  )
  if (free === undefined) return

  deps.state.assign(agentId, free)
  deps.onAssigned?.(agentId, free)
}

/** True when the live team roster says this agent is the Lead. */
function isLead(ctx, agent) {
  const teams = serviceOf(ctx, 'agentTeams')
  if (!teams || typeof teams.tryMembership !== 'function') return false
  try {
    return teams.tryMembership(agent)?.role === 'lead'
  } catch {
    return false
  }
}

function observeTaskCreation(section, deps, exec, result) {
  const toolName = exec?.name
  if (typeof toolName !== 'string') return
  const createTools = Array.isArray(section.taskCreateTools) ? section.taskCreateTools : []
  if (!createTools.includes(toolName)) return
  if (!result || result.isError) return

  const value = result.value
  if (!value || typeof value !== 'object') return
  const taskId = typeof value.id === 'string' ? value.id : undefined
  if (taskId === undefined) return

  const role = roleFromMarkers(section, value.subject, value.description)
  if (role === undefined) return
  deps.state.reserve(taskId, role)
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
