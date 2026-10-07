# dsh-role-orchestrator

A **Host-only bundle** for DeepSeek Harness **0.2.0-rc.2** that adds four role-oriented
guarantees on top of the built-in Agent Teams feature, without modifying DSH itself.

| Module | Seam | What it adds |
|---|---|---|
| `context-compressor` | `agent/created`, `agent/pre-step`, `systemPrompt.section`, `tools.restrict` | A per-role prompt section with a real token budget, per-role tool visibility, and bounded elision of oversized message text |
| `task-guard` | `tools/pre-execute`, `tools.guard` | Single-owner / role-reservation / write-scope policy on top of the framework's already-atomic claim path |
| `approval-gate` | `tools/pre-execute` | Human approval for high-risk tool calls, asked through the session approval policy |
| `orchestration` | `agent/created`, `agent/disposed`, `tools/post-execute` | Automatic role assignment from a configurable pool, plus task→role reservation that the guard enforces and the role context advertises |

The first three modules are **reactive** — they police behaviour something else initiates.
`orchestration` **initiates**: it decides who plays which role, and which work belongs to that role.

Read [`CORRECTIONS.md`](CORRECTIONS.md) first: the original design document assumed several APIs that do not
exist on this Host, and every deviation is documented there with evidence.

## Design constraints (all verified)

- **Zero imports.** A profile-installed bundle cannot resolve `@deepseek-ai/*` from the DSH installation, so
  this package imports nothing — not even `schemastery`. Type information is JSDoc only.
- **No build step.** The loader does not compile TypeScript, so the bundle is plain ESM JavaScript.
- **Read services through `ctx.get()`, register through `ctx.inject()`.** This plugin declares no `inject`,
  so it activates in profiles that lack Agent Teams or the approval service. `ctx.get(name)` is the
  documented non-throwing accessor for reading a service **inside a listener**.
- **Never read a service at `apply()` time.** `ctx.get(name)` returns `undefined` — without throwing and
  without waiting — if the providing fiber has not run yet, which is reachable for a plugin that declares no
  `inject`. Registering the status tool that way silently did nothing. Every `apply()`-time service use goes
  through `whenService()` (`ctx.inject([name], cb)`), which defers until the dependency is ready.
- **Never break the host.** Every listener is wrapped so an internal error degrades to `next()`, prompt
  assembly falls back to `''`, and teardown cannot throw.

## Layout

```
index.js                     apply(ctx, config) + startup log
cordis.patch.yml             the loader insert row (id: role-orchestrator)
src/config.js                normalization + validation (no dependencies)
src/services.js              serviceOf() reads, whenService() deferred registration
src/roles.js                 role -> ContextPolicy table and resolution
src/token-budget.js          4-chars/token estimator, truncation, budget fitting
src/ownership.js             pure ownership classification for task records
src/risk-rules.js            risk rules for tool calls
src/context-compressor.js    module 1
src/task-guard.js            module 2
src/approval-gate.js         module 3
src/orchestration.js         module 4 — role assignments + task reservations
src/status-tool.js           role_orchestrator_status — model-facing tool
src/status-command.js        /role-status — user-facing Host command
client.js                    browser half — the dock strip (criterion 5)
scripts/token-report.mjs     measured per-role context cost
test/                        109 tests, node:test, no dependencies
```

## Install

The sanctioned path is the Plugin Manager, not `dsh plugin add`:

```
plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
```

Installed on this machine into the **`desktop`** profile as a linked dependency
(`link:D:/harness_workplace/dsh-role-orchestrator`), so edits here are picked up on the next module load.

> **Restart required for the latest code.** A changed JavaScript module generation is only loaded on
> restart; re-installing the same path is rejected with `ambiguous-install` because the target is already
> linked.

## Configuration

Override the row's `config` from the profile's `cordis.patch.yml`; a matching override replaces the whole
config object, so restate any key you want to keep.

```yaml
- insert:
    - id: role-orchestrator
      name: '@local/dsh-role-orchestrator'
      config:
        contextCompressor:
          enabled: true
          defaultTokenBudget: 4000
          sectionOrder: 650            # between TEAM_POLICY (600) and PTC_ONLY (800)
          roleAssignments: { <agent-name-or-id>: '验证Agent' }
          rolePolicies: { 验证Agent: { tokenBudget: 5000 } }
          defaultRole: default
        taskGuard:
          enabled: true
          strict: false                # true adds fail-fast revision checks + a tools.guard() denial
          claimTools: ['team_task_update', 'agent_teams_claim_task']
          roleReservations: { <task-id>: '审查Agent' }
        approvalGate:
          enabled: true
          mode: ask                    # ask | direct
          mediumAction: ask            # ask | allow | deny
          highRiskTools: []
          denyOnUnavailableApproval: true
        orchestration:
          enabled: true
          rolePool: ['文献检索Agent', 'Claim分析Agent', '验证Agent', '审查Agent']
          assignToLead: false          # the Lead directs; it is not in the pool
          reserveFromMarkers: true
          markerPattern: '\[role:\s*([^\]\s]+)\s*\]'
          taskReservations: { <task-id>: '验证Agent' }
```

> The **shipped row activates `rolePool`** (see `cordis.patch.yml`), so automatic role assignment is on for
> this profile. The code-level fallback in `DEFAULT_CONFIG` stays `[]`, so a partial or mistaken override can
> never switch assignment on by accident — turning it on is always an explicit act in a patch.

Built-in roles: `default`, `文献检索Agent`, `Claim分析Agent`, `验证Agent`, `审查Agent`. Unknown keys and
wrong types produce a host warning and fall back to the default rather than throwing.

### Module 4 in practice

Two independent mechanisms:

**Role assignment.** When `rolePool` is non-empty, each newly created teammate takes the first role in the
pool that no live agent holds. An explicit `contextCompressor.roleAssignments` entry or an identity field
naming a known role always wins over the pool. The Lead is skipped unless `assignToLead: true`. Roles are
released on `agent/disposed`, so a replacement agent can take the freed slot.

Assignment changes nothing about *permissions available* — it only selects which already-configured policy
applies (prompt section, tool restriction, reservation checks). One consequence is worth stating plainly:
`文献检索Agent` denies `write` and `edit`, so with the shipped pool the **first teammate to be created cannot
edit files directly**. Reorder the pool or edit that role's `deniedTools` if that is not wanted.

**Task reservation.** A task can be reserved for a role; the guard then rejects a claim by any other role.
Reservation precedence, highest first:

1. an **observed** reservation — a marker seen on the task when it was created
2. `orchestration.taskReservations[taskId]`
3. `taskGuard.roleReservations[taskId]` (legacy key, still honoured)
4. a **marker in the task's own text** — `subject` or `description` containing `[role:验证Agent]`
5. the task's own `requiredRole` field

Path 4 needs no interception at all, because the guard already reads the task view at claim time. Path 1
only makes the reservation *visible earlier*; the enforcement result is identical.

Reserved-and-open tasks for the agent's role are then advertised in its `<role-context>` block. That is a
**soft** dispatch: the plugin tells the agent which work is its own, but never claims anything on the
agent's behalf — claiming stays an explicit, auditable tool call the guard can still reject.

## Verification

```bash
node --test              # 109 tests
node scripts/token-report.mjs   # measured per-role context cost
```

The suite covers config normalization, role resolution, the token estimator/truncator, risk rules, ownership
classification, service-registration ordering, the role/reservation ledger, and — through a Cordis-context
double that composes waterfall listeners — the real decision logic of all four modules plus both status
surfaces. Examples:

- `approval-gate`: `direct` mode is driven through all four `ApprovalOutcome` values; only `allowed-once`
  proceeds.
- `task-guard`: an owned-by-another claim is denied, an unowned claim passes, a write-scope overlap is
  denied, and a stale revision denies only in `strict` mode.
- `services`: `whenService` must defer registration while the dependency is absent, and the status tool must
  still register once `tools` appears — the regression test for the activation-order bug.
- `orchestration`: pool assignment hands out one role per agent and skips the Lead; a `[role:X]` marker
  recorded on `tools/post-execute` is passed through untouched and then denies the wrong role at claim time.
- `plugin`: `apply()` registers every event seam plus both status surfaces, and its disposer removes them.
- `roles-budget`: **every** role in the built-in table renders a distinct section that fits the char cap, so
  a new role cannot be added unmeasured.
- `acceptance`: the full pipeline (assign → reserve → policed claim → compress → approve) driven through
  `apply()` against a simulated Host, including six concurrent claims.

### Phase 3 acceptance results

`test/acceptance.test.js` drives the real modules through `apply()` against a Host double that models the
ledger's **transactional compare-and-set** (`withTeamLock`-style promise chain + revision precondition,
mirroring the verified built-in implementation).

| Acceptance criterion | How it is evidenced | Result |
|---|---|---|
| 1 · Lead orchestrates | `agent/created` assigns pool roles to teammates and skips the Lead | pass |
| 2 · One task, one owner | 6 concurrent claims → exactly one winner; every loser rejected by the ledger with `TEAM_TASK_STALE_REVISION` | pass |
| 3 · Per-role context, fewer tokens | 5 roles → 5 distinct sections; a 20 000-char tool result collapses to 1 000–1 500 tokens (**70–80 % saved**) | pass |
| 4 · High-risk needs approval | `ask` carries a bilingual card; `direct` denies unless the outcome is `allowed-once`; no answerer fails closed | pass |
| 5 · Live state in the Web UI | browser half registers into `conversation.composer.dock` and re-reads `/role-status` | **partially verified** — see below |

Two findings worth recording from writing this suite:

- **The guard is policy, not atomicity.** In the concurrent run the pre-execute layer allowed all six
  claimants, because none of them was owned at policy time. Only the ledger's CAS picked a winner. That is
  the intended layering — and it is why the plugin implements no lock of its own.
- **The revision check runs before the ownership check**, so a racing loser fails with
  `TEAM_TASK_STALE_REVISION`, not `TEAM_TASK_ALREADY_CLAIMED`. The latter fires only when a claim arrives
  carrying a *current* revision. The assertion was corrected to match the verified source.

Measured report (`node scripts/token-report.mjs`):

```
role              budget  section  chars  fits  msg cap  msg tok  saved  scopes
default             4000       51    203   yes     4000     1000    80%  task
文献检索Agent           4000       70    277   yes     4000     1000    80%  literature,query
Claim分析Agent        6000       74    296   yes     6000     1500    70%  claim,evidence,literature
验证Agent             5000       69    273   yes     5000     1250    75%  evidence,claim,verification
审查Agent             5000       69    273   yes     5000     1250    75%  claim,evidence,review
```


### Evidence that the bundle is live

The Host injects this plugin's own per-role prompt section into every session, so a live bundle shows up
directly in the session's system prompt:

```xml
<role-context role="default">
You own exactly the task you claimed. Keep updates short and factual.

Allowed data scopes: task.

Do not read other branches; work only from your own scope.
</role-context>
```

**Verified end to end on a real teammate.** With the shipped pool active, a spawned teammate was asked to
report its own state and independently answered:

```json
{
  "role": "文献检索Agent",
  "roleSource": "orchestration",
  "tokenBudget": 4000,
  "allowedScopes": ["literature", "query"],
  "deniedTools": ["write", "edit"],
  "rolePool": ["文献检索Agent", "Claim分析Agent", "验证Agent", "审查Agent"],
  "roleAssignments": ["文献检索Agent <- 6d52602e-9466-4748-a768-6e92cdf98c43"],
  "reservedTasks": []
}
```

and quoted `<role-context role="文献检索Agent">` as the first line of its own system prompt. That single
result confirms four things at once: the pool assigned a role at `agent/created`, the source is the
orchestration ledger (not config or identity), the role's policy reached the agent (`literature, query`
scopes with `write`/`edit` denied), and the compressor injected the matching per-role section. The Lead's own
`roleSource` stayed `default`, confirming the Lead is skipped.

## Usage

Two entry points, deliberately separate — this distinction is easy to miss:

| | For whom | How to invoke | Where it shows up |
|---|---|---|---|
| `role_orchestrator_status` | the **model** | the agent calls the tool | nothing in the UI; the tool registry only |
| `/role-status` | the **human** | type it in the composer | the Web UI slash-command menu |

A registered tool is *not* a user-visible command. `ctx.tools.register()` only makes a capability callable
by the model; a human-invokable entry point requires `ctx.commands.register()`. Both read the same
`buildStatus()` source so they cannot drift apart.

`/role-status` prints:

```
Role Orchestrator — role "default" (source: default)
  context budget : 4000 tokens (section order 650)
  allowed scopes : task
  denied tools   : (none)
  owned tasks    : (none)
  task guard     : enabled
  approval gate  : enabled (ask)
  orchestration  : enabled (pool: 文献检索Agent, Claim分析Agent, 验证Agent, 审查Agent)
  assignments    : 验证Agent <- <session-id>
  reservations   : t3 <- 审查Agent
```

## Web UI half

`client.js` is a file-based browser bundle: it registers a lazy factory via
`window.__ModuleLoader__.load({ id, factory })` whose factory returns a Cordis plugin
`{ apply, inject }`. `apply()` registers the `role-orchestrator` locale dictionary and one entry in
`conversation.composer.dock` — a list slot the shell already allocates space in (`replaceRisk: none`), with
registration `{ id, order, label }`. The strip styles itself exclusively with `--dsw-alias-*` theme tokens,
so it follows light/dark and any future palette.

It reads two sources, in this order:

1. **`useProjection('agentTeam')`** — the Agent Teams session projection is client-visible on the dock slot's
   standard props and carries `{ members, tasks }`. Those are the same task records the Host guard reads, so
   a `[role:X]` marker in a task's text yields **the same reservation the guard enforces** — reactively, with
   no polling and no RPC. Completed and deleted tasks are ignored, exactly as the guard ignores them.
2. **`/role-status` via a Remote command**, polled every 2 s, because only the Host knows the agent's
   resolved role and token budget. This path is optional; it is probed defensively and skipped when absent.

With neither source the strip still renders a localized label rather than throwing — a throwing component
blanks its slot entry. Every probe, read and hook call is individually guarded.

```jsonc
// package.json
"exports": { "./client": "./client.js", ... },
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true } }
```

`test/client.test.js` evaluates the real bundle against a minimal loader and React surface, then asserts the
factory shape, the injected services, the slot registration, the status parsing, **and the rendered element
tree** — so the reservation chips are verified without a browser.

### Seeing it

Open any **Session** and look just below the composer card: the strip sits in the same dock as the built-in
`stats` entry (`order: 0`; ours is `30`). With a live team it shows chips like
`2 members · 2 reserved · t1 → 验证Agent`; with no team yet it shows the localized fallback. Use `/role-status`
in the composer for the full report.

## Honest limitations

- **A restart is required for module 4 and the UI strip to load.** Listeners, commands and client
  registrations all take effect when the plugin's module generation loads.
- **Criterion 5 is verified for reservations.** Confirmed live by the operator: the strip rendered
  `1 成员 · 1 预留 · task-1 → 验证Agent` for a task carrying the `[role:验证Agent]` marker, sourced from the
  client-visible `agentTeam` projection. Visual fidelity and theme rendering were also observed. What is
  still **not** on the UI is the plugin's private state — assigned roles and token budgets live in Host
  process memory, so surfacing those needs a Remote domain of the plugin's own.
- **The UI shows reservations, not the plugin's private ledger.** Roles assigned by module 4 and the token
  budget live in Host process memory; no client-visible surface carries them. The strip therefore renders the
  **task→role reservations parsed from the Agent Teams projection** (which the guard enforces identically)
  plus whatever `/role-status` yields when a Remote path exists. A file-based browser half cannot use
  `host.call`/`harness.handle` — those belong to the dynamic sandbox lane — and exposing the ledger through a
  Host projection is blocked by the Zod requirement and the projection purity contract (CORRECTIONS.md
  F-17/F-18). A Remote domain of this plugin's own is the way to surface the rest.
- **The assignment ledger is in-process.** It is a derived cache rebuilt from `agent/created`, not durable
  state. Roles are stable for an agent's lifetime within one process; the session log remains the only
  source of truth, and this ledger is not written to it.
- **Role assignment is not consent.** Auto-assignment picks which configured policy applies to an agent; it
  never grants a capability. The shipped row activates the pool, but the code-level fallback stays empty, so
  assignment is only ever switched on by an explicit patch.
- **The third-party ledger is not enforceable.** `@nanmicoder/dsh-agent-teams` has no Host service, so its
  tasks cannot be read from a plugin; only its tool arguments are visible.
- **The `desktop` and `web` profiles install separately.** This bundle is installed in `desktop` only.
