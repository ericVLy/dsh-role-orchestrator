# dsh-role-orchestrator

A **Host-only bundle** for DeepSeek Harness **0.2.0-rc.2** that adds three role-oriented
guarantees on top of the built-in Agent Teams feature, without modifying DSH itself.

| Module | Seam | What it adds |
|---|---|---|
| `context-compressor` | `agent/created`, `agent/pre-step`, `systemPrompt.section`, `tools.restrict` | A per-role prompt section with a real token budget, per-role tool visibility, and bounded elision of oversized message text |
| `task-guard` | `tools/pre-execute`, `tools.guard` | Single-owner / role-reservation / write-scope policy on top of the framework's already-atomic claim path |
| `approval-gate` | `tools/pre-execute` | Human approval for high-risk tool calls, asked through the session approval policy |

Read [`CORRECTIONS.md`](CORRECTIONS.md) first: the original design document assumed several APIs that do not
exist on this Host, and every deviation is documented there with evidence.

## Design constraints (all verified)

- **Zero imports.** A profile-installed bundle cannot resolve `@deepseek-ai/*` from the DSH installation, so
  this package imports nothing — not even `schemastery`. Type information is JSDoc only.
- **No build step.** The loader does not compile TypeScript, so the bundle is plain ESM JavaScript.
- **Optional services via `ctx.get()`.** This plugin declares no `inject`, so it activates in profiles that
  lack Agent Teams or the approval service. `ctx.get(name)` is the documented non-throwing accessor.
- **Never break the host.** Every listener is wrapped so an internal error degrades to `next()`, prompt
  assembly falls back to `''`, and teardown cannot throw.

## Layout

```
index.js                     apply(ctx, config) + startup log
cordis.patch.yml             the loader insert row (id: role-orchestrator)
src/config.js                normalization + validation (no dependencies)
src/services.js              safe optional-service access
src/roles.js                 role -> ContextPolicy table and resolution
src/token-budget.js          4-chars/token estimator, truncation, budget fitting
src/ownership.js             pure ownership classification for task records
src/risk-rules.js            risk rules for tool calls
src/context-compressor.js    module 1
src/task-guard.js            module 2
src/approval-gate.js         module 3
src/status-tool.js           role_orchestrator_status (read-only diagnostic)
test/                        42 tests, node:test, no dependencies
```

## Install

The sanctioned path is the Plugin Manager, not `dsh plugin add`:

```
plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
```

Already installed on this machine into the **`desktop`** profile as a linked dependency
(`link:D:/harness_workplace/dsh-role-orchestrator`), so edits here are picked up on the next module load.

> **Restart required for the latest code.** The initial install reported `application: "applied"`. Adding the
> status tool afterwards changed the JavaScript module generation, and the live tool registry did not yet
> expose it — the documented behaviour is that a changed generation needs a restart. Re-installing the same
> path is rejected with `ambiguous-install` because the target is already linked.

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
```

Built-in roles: `default`, `文献检索Agent`, `Claim分析Agent`, `验证Agent`, `审查Agent`. Unknown keys and
wrong types produce a host warning and fall back to the default rather than throwing.

## Verification

```bash
node --test        # 42 tests
```

The suite covers config normalization, role resolution, the token estimator/truncator, risk rules, ownership
classification, and — through a Cordis-context double that composes waterfall listeners — the real decision
logic of all three modules plus the status tool. Two examples:

- `approval-gate`: `direct` mode is driven through all four `ApprovalOutcome` values; only `allowed-once`
  proceeds.
- `task-guard`: an owned-by-another claim is denied, an unowned claim passes, a write-scope overlap is
  denied, and a stale revision denies only in `strict` mode.

Runtime check after restart (proves `apply()` ran in the live Host):

```
role_orchestrator_status
```

## Honest limitations

- **Live activation of the current generation is not yet verified.** Installation reported
  `application: "applied"` with no warnings, and the loader entry `include:role-orchestrator` is present in
  the live tree, but a functional probe was inconclusive: the plain `pwsh` probe hits a pre-existing sandbox
  failure (`SetNamedSecurityInfoW Win32 5`), so "the gate asked and was auto-approved" cannot be separated
  from "the gate did not fire". The status tool resolves this after a restart.
- **No Web UI surface.** Acceptance criterion 5 (live state in the Web UI) needs a Client half with slot
  registration; this bundle is Host-only.
- **Role identity is derived, not stored.** The `Agent` contract exposes only `id`, so roles come from
  configuration assignments or from an identity field on the agent object.
- **The third-party ledger is not enforceable.** `@nanmicoder/dsh-agent-teams` has no Host service, so its
  tasks cannot be read from a plugin; only its tool arguments are visible.
- **The `desktop` and `web` profiles install separately.** This bundle is installed in `desktop` only.
