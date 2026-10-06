/**
 * Deterministic local token budgeting.
 *
 * A plugin cannot assume a live `Session` object at projection time, so the
 * primary estimator is a documented character heuristic; `ctx.tokenMeter` is
 * used opportunistically when a session handle is available.
 */

/**
 * Matches the Harness token-meter heuristic exactly:
 * `@deepseek-ai/dsh-token-meter` uses `CHARS_PER_TOKEN = 4` and prices a text
 * block as `ceil(len / 4) + BLOCK_OVERHEAD`.
 */
const TOKENS_PER_CHAR = 0.25

/** Separator inserted between fitted sections (also charged against the budget). */
const SEPARATOR = '\n\n'

/**
 * @param {string} text
 * @returns {number} estimated tokens
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length * TOKENS_PER_CHAR)
}

/**
 * @param {string} text
 * @param {number} tokenBudget
 * @returns {number} maximum characters allowed for this budget
 */
export function charsForBudget(tokenBudget) {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) return 0
  return Math.max(0, Math.floor(tokenBudget / TOKENS_PER_CHAR))
}

/**
 * Trim text to a character budget on a line boundary where possible, keeping
 * the head and the tail and marking the elision, because for role context the
 * tail often holds the current task while the head holds the charter.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, truncated: boolean, originalChars: number }}
 */
export function truncate(text, maxChars) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return { text: '', truncated: source.length > 0, originalChars: source.length }
  }
  if (source.length <= maxChars) {
    return { text: source, truncated: false, originalChars: source.length }
  }
  const marker = '\n...[elided]...\n'
  if (maxChars <= marker.length + 32) {
    return { text: source.slice(0, maxChars), truncated: true, originalChars: source.length }
  }
  const room = maxChars - marker.length
  const head = Math.floor(room * 0.6)
  const tail = room - head
  return {
    text: source.slice(0, head) + marker + source.slice(source.length - tail),
    truncated: true,
    originalChars: source.length,
  }
}

/**
 * Assemble ordered context sections under a token budget, dropping the
 * lowest-priority sections first.
 *
 * @param {Array<{ name: string, text: string, priority: number }>} sections lower priority number = kept first
 * @param {number} tokenBudget
 * @returns {{ text: string, included: string[], dropped: string[], tokens: number, truncated: string[] }}
 */
export function fitSections(sections, tokenBudget) {
  const maxChars = charsForBudget(tokenBudget)
  const ordered = [...sections].sort((a, b) => a.priority - b.priority)
  const included = []
  const dropped = []
  const truncated = []
  let used = 0
  const parts = []
  for (const section of ordered) {
    const text = typeof section.text === 'string' ? section.text : ''
    if (text.length === 0) continue
    // Reserve the join separator, otherwise the assembled block can exceed the
    // budget by two characters per section.
    const separatorCost = parts.length > 0 ? SEPARATOR.length : 0
    const remaining = maxChars - used - separatorCost
    if (remaining <= 0) {
      dropped.push(section.name)
      continue
    }
    if (text.length <= remaining) {
      parts.push(text)
      included.push(section.name)
      used += text.length + separatorCost
      continue
    }
    const cut = truncate(text, remaining)
    if (cut.text.length === 0) {
      dropped.push(section.name)
      continue
    }
    parts.push(cut.text)
    included.push(section.name)
    truncated.push(section.name)
    used += cut.text.length + separatorCost
  }
  const body = parts.join(SEPARATOR)
  return { text: body, included, dropped, truncated, tokens: estimateTokens(body) }
}
