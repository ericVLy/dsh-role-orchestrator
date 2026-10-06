/**
 * Pure ownership classification for task-like records.
 *
 * The two team systems in this profile expose different task view field names
 * (see CORRECTIONS.md F-2/F-3), so ownership is read through a configurable
 * field probe rather than a hard-coded property name. Nothing here performs
 * I/O; the caller supplies the task record and the candidate identities of the
 * claiming agent.
 *
 * @typedef {'unowned'|'mine'|'other'|'unknown'} OwnershipState
 * @typedef {{ state: OwnershipState, owner: string|undefined, field: string|undefined }} OwnershipVerdict
 */

/** Identity fields that may carry the acting agent's name/id. */
const AGENT_IDENTITY_FIELDS = ['name', 'memberName', 'ownerName', 'id', 'sessionId', 'role']

/**
 * Collect every string identity a caller might be known by.
 * @param {object|undefined} agent
 * @returns {string[]}
 */
export function agentIdentities(agent) {
  const out = new Set()
  if (!agent || typeof agent !== 'object') return []
  for (const field of AGENT_IDENTITY_FIELDS) {
    const value = agent[field]
    if (typeof value === 'string' && value.length > 0) out.add(value)
  }
  return [...out]
}

/**
 * Read the owner label from a task record using the configured field order.
 * @param {object|undefined} task
 * @param {string[]} ownershipFields
 * @returns {{ owner: string|undefined, field: string|undefined }}
 */
export function readOwner(task, ownershipFields) {
  if (!task || typeof task !== 'object') return { owner: undefined, field: undefined }
  for (const field of ownershipFields) {
    const value = task[field]
    if (typeof value === 'string' && value.length > 0) return { owner: value, field }
    if (value && typeof value === 'object') {
      for (const inner of ['name', 'id']) {
        const nested = value[inner]
        if (typeof nested === 'string' && nested.length > 0) {
          return { owner: nested, field: `${field}.${inner}` }
        }
      }
    }
  }
  return { owner: undefined, field: undefined }
}

/**
 * Classify ownership of `task` relative to `agent`.
 *
 * An owner that matches none of the agent's identities is treated as `other`,
 * which is the only state the guard denies.
 *
 * @param {object|undefined} task
 * @param {object|undefined} agent
 * @param {string[]} ownershipFields
 * @returns {OwnershipVerdict}
 */
export function classifyOwnership(task, agent, ownershipFields) {
  const { owner, field } = readOwner(task, ownershipFields)
  if (owner === undefined) return { state: 'unowned', owner: undefined, field: undefined }
  const identities = agentIdentities(agent)
  if (identities.length === 0) return { state: 'unknown', owner, field }
  if (identities.includes(owner)) return { state: 'mine', owner, field }
  return { state: 'other', owner, field }
}

/**
 * Extract a task id from tool arguments across the argument shapes the team
 * tools use (`task_id`, `taskId`, `id`).
 * @param {unknown} args
 * @returns {string|undefined}
 */
export function readTaskId(args) {
  if (!args || typeof args !== 'object') return undefined
  for (const key of ['task_id', 'taskId', 'id']) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}
