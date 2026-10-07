/**
 * Browser half — the Role Orchestrator strip under the composer.
 *
 * Structure follows the verified file-based client-bundle contract:
 *   window.__ModuleLoader__.load({ id: '<package name>', factory: (require) => ... })
 * where the factory returns a Cordis plugin object `{ apply, inject }`.
 *
 * DATA PATH — why this reads a projection rather than the Host:
 *   `host.call` / `harness.handle` belong to the *dynamic sandbox* lane, and a
 *   Host session projection of this plugin's own state is impossible (Zod
 *   schemas cannot be resolved by a zero-import bundle; the ledger is not
 *   log-derived) — see CORRECTIONS.md F-17/F-18.
 *
 *   What IS available, on the dock slot's standard props, is `useProjection`:
 *   the Agent Teams session projection `agentTeam` is client-visible and carries
 *   `{ members, tasks }`. Those tasks are the very same records the Host guard
 *   reads, so a `[role:X]` marker in a task's text yields the same reservation
 *   the guard enforces — reactively, with no polling and no RPC.
 *
 *   The `/role-status` command is still probed as a secondary source, because it
 *   alone knows the agent's resolved role and token budget. Every read is
 *   guarded: a throwing component blanks its slot entry, so this one always
 *   returns something.
 *
 * Styling uses only `--dsw-alias-*` theme tokens, so the strip follows light,
 * dark, and any future palette without a literal colour.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-role-orchestrator',
  factory: (require) => {
    const React = require('react')

    const NS = 'role-orchestrator'
    const SLOT = 'conversation.composer.dock'
    const ENTRY_ID = 'role-orchestrator'
    const STATUS_COMMAND = 'role-status'
    const TEAM_PROJECTION = 'agentTeam'
    const POLL_MS = 2000

    /** Same marker convention the Host guard uses. */
    const ROLE_MARKER = /\[role:\s*([^\]\s]+)\s*\]/

    const DICT = {
      en: {
        title: 'Role Orchestrator',
        enabled: 'active',
        hint: 'Run /role-status for the full report.',
        members: 'members',
        reserved: 'reserved',
      },
      zh: {
        title: '角色编排器',
        enabled: '已启用',
        hint: '输入 /role-status 查看完整报告。',
        members: '成员',
        reserved: '预留',
      },
    }

    // ---------------------------------------------------------------- styles
    const CSS = `
.ro-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 2px;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.ro-name{font-weight:500;color:var(--dsw-alias-label-primary)}
.ro-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ro-role{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l2)}
.ro-reserved{color:var(--dsw-alias-state-warn-primary)}
.ro-hint{color:var(--dsw-alias-label-secondary);opacity:.85}
`

    // ------------------------------------------------------------- derivation
    /**
     * Open tasks whose text names a role — the client-side mirror of the Host
     * guard's reservation rule.
     * @returns {Array<{id: string, role: string, status: string, ownerName?: string}>}
     */
    function extractReservations(tasks) {
      if (!Array.isArray(tasks)) return []
      const out = []
      for (const task of tasks) {
        if (!task || typeof task !== 'object') continue
        if (task.status === 'deleted' || task.status === 'completed') continue
        const text = `${task.subject ?? ''} ${task.description ?? ''}`
        ROLE_MARKER.lastIndex = 0
        const match = ROLE_MARKER.exec(text)
        if (!match || typeof match[1] !== 'string') continue
        out.push({
          id: String(task.id),
          role: match[1],
          status: typeof task.status === 'string' ? task.status : 'unknown',
          ...(typeof task.ownerName === 'string' ? { ownerName: task.ownerName } : {}),
        })
      }
      return out
    }

    /**
     * Locate a client-callable command executor.
     *
     * The generated Remote namespace is injected per package rather than listed
     * as a Client service, so two shapes are probed (`ctx.get('remote')` and the
     * `ctx.remote` property). Neither probe may throw: a missing data path means
     * a fallback label, never a blanked slot entry.
     */
    function findCommandExecute(ctx) {
      const candidates = []
      if (typeof ctx.get === 'function') {
        try {
          candidates.push(ctx.get('remote'))
        } catch {
          /* not provided */
        }
      }
      try {
        candidates.push(ctx.remote)
      } catch {
        /* not provided */
      }
      for (const remote of candidates) {
        const execute = remote?.commands?.execute
        if (typeof execute === 'function') return execute.bind(remote.commands)
      }
      return undefined
    }

    /** Pull the few fields the strip shows out of the command's rendered text. */
    function parseStatusText(text) {
      const pick = (label) => {
        const match = new RegExp(`${label}\\s*:\\s*(.+)`).exec(text)
        return match ? match[1].trim() : undefined
      }
      const role = /role "([^"]*)"/.exec(text)
      // Only the header wraps its source in parentheses, and a parenthesised
      // value can itself contain parens (`5000 tokens (section order 650)`), so
      // the source is matched with its own anchored pattern.
      const source = /\(source:\s*([^)]+)\)/.exec(text)
      return {
        role: role ? role[1] : undefined,
        source: source ? source[1].trim() : undefined,
        budget: pick('context budget'),
        gate: pick('approval gate'),
        orchestration: pick('orchestration'),
        reservations: pick('reservations'),
      }
    }

    /**
     * Secondary source: the plugin's own Host command, when a client-callable
     * path exists. Returns a normalised object or null; never throws.
     */
    function makeStatusReader(ctx) {
      return async function readStatus() {
        try {
          const execute = findCommandExecute(ctx)
          if (typeof execute !== 'function') return null
          const result = await execute(STATUS_COMMAND, [], undefined)
          const text = result?.result?.text ?? result?.text
          if (typeof text !== 'string' || text.length === 0) return null
          return parseStatusText(text)
        } catch {
          return null
        }
      }
    }

    // ------------------------------------------------------------- component
    function StatusStrip(props) {
      const t = props.t ?? ((key) => DICT.en[key] ?? key)
      const readStatus = props.readStatus
      const useProjection = props.useProjection
      const [status, setStatus] = React.useState(null)

      React.useEffect(() => {
        if (typeof readStatus !== 'function') return undefined
        let cancelled = false
        const tick = () => {
          // A synchronous throw here would escape the effect and blank the slot
          // entry, so the call is captured before it is awaited.
          let pending
          try {
            pending = readStatus()
          } catch {
            pending = null
          }
          Promise.resolve(pending)
            .then((next) => {
              if (!cancelled) setStatus(next)
            })
            .catch(() => {
              if (!cancelled) setStatus(null)
            })
        }
        tick()
        const interval = setInterval(tick, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(interval)
        }
      }, [readStatus])

      // Reactive and polling-free: the Agent Teams projection updates on every
      // committed session event. Hook order is stable because the slot's prop
      // set is fixed for the life of the entry.
      let team
      if (typeof useProjection === 'function') {
        try {
          team = useProjection(TEAM_PROJECTION)
        } catch {
          team = undefined
        }
      }

      const reservations = extractReservations(team?.tasks)
      const memberCount = Array.isArray(team?.members) ? team.members.length : 0

      const children = [
        React.createElement('span', { key: 'name', className: 'ro-name' }, t('title')),
      ]
      let hasData = false

      if (status && status.role) {
        hasData = true
        children.push(
          React.createElement('span', { key: 'role', className: 'ro-chip ro-role' }, status.role),
        )
        if (status.budget) {
          children.push(
            React.createElement('span', { key: 'budget', className: 'ro-chip' }, status.budget),
          )
        }
        if (status.gate) {
          children.push(
            React.createElement('span', { key: 'gate', className: 'ro-chip' }, status.gate),
          )
        }
      }

      if (memberCount > 0) {
        hasData = true
        children.push(
          React.createElement(
            'span',
            { key: 'members', className: 'ro-chip' },
            `${memberCount} ${t('members')}`,
          ),
        )
      }

      if (reservations.length > 0) {
        hasData = true
        children.push(
          React.createElement(
            'span',
            { key: 'reserved-count', className: 'ro-chip ro-reserved' },
            `${reservations.length} ${t('reserved')}`,
          ),
        )
        const first = reservations[0]
        children.push(
          React.createElement(
            'span',
            { key: 'reserved-first', className: 'ro-chip ro-reserved' },
            `${first.id} → ${first.role}${first.ownerName ? ` (${first.ownerName})` : ''}`,
          ),
        )
      }

      if (!hasData) {
        children.push(
          React.createElement('span', { key: 'state', className: 'ro-chip' }, t('enabled')),
        )
        children.push(React.createElement('span', { key: 'hint', className: 'ro-hint' }, t('hint')))
      }

      return React.createElement('div', { className: 'ro-strip' }, children)
    }

    // ------------------------------------------------------------------ apply
    function apply(ctx) {
      ctx.effect(() => styles_insert(ctx, CSS), 'role-orchestrator: styles')
      ctx.effect(() => ctx.locale.register(NS, DICT), 'role-orchestrator: dictionaries')

      const readStatus = makeStatusReader(ctx)

      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: ENTRY_ID,
            order: 30,
            locale: NS,
            inject: () => ({ readStatus }),
          },
          StatusStrip,
        ),
      )
    }

    /** Insert the package stylesheet through the client style service. */
    function styles_insert(ctx, css) {
      // `ctx.get` itself can throw when a service is not provided, and a throw
      // here would fail the whole plugin's activation — so it is guarded too.
      let styles
      try {
        styles = typeof ctx.get === 'function' ? ctx.get('styles') : undefined
      } catch {
        styles = undefined
      }
      if (styles && typeof styles.insert === 'function') return styles.insert(css)

      // Fallback for lanes without the style service: a removable <style> tag.
      if (typeof document === 'undefined') return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-role-orchestrator'
      tag.textContent = css
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    return { apply, inject: ['slots', 'locale'] }
  },
})
