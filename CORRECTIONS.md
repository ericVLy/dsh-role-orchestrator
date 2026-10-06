# Corrections: original design doc vs. the installed Harness

Every claim below was checked against the **running** Harness, not against documentation.

| | Value |
|---|---|
| Host version | `@deepseek-ai/dsh-desktop-runtime` **0.2.0-rc.2** |
| Active profile of the running GUI | **`desktop`** (`DSH_PROFILE=desktop`, `DSH_PROFILE_DIR=C:\Users\linye\.dsh\profiles\desktop`) |
| Agent Teams present in that profile | DSH built-in `@deepseek-ai/dsh-experimental-agent-team-profile` |
| Agent Teams present in the *other* profile (`web`) | `@nanmicoder/dsh-agent-teams` **0.1.22** (not 0.1.21) |
| Method | `cordis_inspect_*`, the built-in `cordis-plugin-development` skill extracted from `app.asar`, and the bundled sources |

Legend: **WRONG** = does not exist / would not run · **RISKY** = exists but the design is weaker or destructive · **OK** = verified correct.

---

## F-1 · Checkout path — WRONG

The doc says the checkout is `...\resources\app.asar\dsh\`. That path does not exist as a directory:
`app.asar` is a single **file**, and `app.asar.unpacked\dsh\` contains only native dependencies
(`node-pty`, `sherpa-onnx`, …), not the DSH packages. DSH's own packages are entries **inside** the archive
(`dsh/node_modules/@deepseek-ai/...`) and need an asar reader. The `read`/`glob`/`grep` tools cannot open
it either — the read backend fails with `Cannot mix BigInt and other types`.

## F-2 · `event.injectContext({ as: 'context', template, maxChars })` — WRONG

No such API exists. `agent/pre-step` is a **waterfall** whose return type is:

```ts
type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

There is no `rewrite` kind and no `inject`/`template`/`maxChars` field. A listener receives
`(payload, next)`, not an `event` object, and must `await next()` before modifying the decision:

```js
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()
  if (decision.kind !== 'enter') return decision
  return { ...decision, messages }   // spread: keeps startsRequestSeries
})
```

## F-3 · Injecting role context — WRONG mechanism

`inject.as: context` does not exist. The three verified mechanisms are:

| Purpose | Mechanism |
|---|---|
| Static prompt **text** per agent | `agent.ctx.systemPrompt.section({ name, order, text, interpolate })` |
| Dynamic runtime context | `ctx.systemPrompt.context(...)` or `agent.inject(userMessage)` |
| Rewriting the messages of one step | return `{ ...decision, messages }` from `agent/pre-step` |

`agent.inject(message)` is real — signature `inject(message: UserMessage): void`; it splices into the
`next-step` inbox and is logged as `agent/inbox/spliced`. It **does not wake an idle agent**, so it is not a
substitute for a per-step hook. This implementation uses a scoped `section()` whose `text` is a function,
which is dynamic *and* replay-safe.

## F-4 · Task tool names — PARTLY WRONG

The doc's sample filters on `['team_task_update', 'claim_task']`.
`team_task_update` is real; **`claim_task` does not exist**. The built-in set is exactly:

```
team_task_create · team_task_list · team_task_get · team_task_update
```

and the claim is `team_task_update` with `action: 'claim'` plus a **required `expected_revision`**.
Two *unrelated* team systems exist, with different tool prefixes and different ledgers:

| | Built-in (desktop profile) | `@nanmicoder/dsh-agent-teams` (web profile) |
|---|---|---|
| Tools | `team_task_*` | `agent_teams_*` |
| Owner field | `ownerName?: string` | `assignee?: string` (`"captain"` sentinel) |
| Statuses | `pending · in_progress · completed · deleted` | `pending · claimed · in_progress · completed · failed · cancelled` |
| Role concept | only `lead`/`teammate` membership | free-form `role: string` on **members**, none on tasks |

Roles on **tasks** do not exist in either system; `roles` in this plugin are a plugin-owned label.

## F-5 · `tools/pre-execute` — MOSTLY OK, field names WRONG

`{ kind: 'deny', reason }` and `{ kind: 'ask', reason }` are correct (the real union also has `allow` and
`cancel`). But the pending call is `ToolExecution`, whose fields are
`{ callId, name, arguments, agent?, signal, … }` — it is **`exec.arguments`, not `exec.args`**. `exec.agent`
is optional and must be null-checked.

## F-6 · Re-implementing atomic claim — RISKY (redundant and weaker)

`task-guard` as written is unnecessary. The built-in board already guarantees single ownership:
`agentTeams.updateTask` runs inside `journal.transact(...)`, rejects a stale revision
(`TEAM_TASK_STALE_REVISION`) and rejects another member's claim (`TEAM_TASK_ALREADY_CLAIMED`).
A plugin-side mutex would be **weaker** (in-process only) and could deadlock against the real transaction.

This implementation therefore adds only what the framework lacks: fail-fast stale-revision detection,
role reservations, and write-scope overlap checks — plus an optional order-independent
`ctx.tools.guard()` denial. It never holds a lock.

## F-7 · `inject = ['tools', 'agents']` — OK but insufficient

`export const inject` is real, as is the `agents` service. But an **optional** service must be read through
`ctx.get(name)` (documented as non-throwing); a bare `ctx.agentTeams` read is not safe when the service was
never mounted. This plugin declares no `inject` at all and reaches everything through `ctx.get`.

`export const Config` exists but requires a `schemastery` schema. A **profile-installed bundle cannot resolve
`@deepseek-ai/*`**, so `Config` — and any import of a DSH package — is unusable from a profile plugin.

## F-8 · `@creait/dsh-hookkit` — exists, but not needed

It is real (`@creait/dsh-hookkit@0.1.0` on the configured mirror). It is **not used** here: declarative
hooks would not provide the cross-module state these three seams need, and it would add the profile's only
third-party dependency.

## F-9 · Install commands — WRONG

`dsh plugin --profile web add ../dsh-role-orchestrator` is not the sanctioned path. A bundle is a package
declaring `dsh.bundle.patch`, installed with `plugin_manager` `install_bundle` (or the Plugin Manager UI),
which performs the pnpm install and bundle selection itself. Hand-editing the profile's `package.json` or
`cordis.patch.yml` is explicitly discouraged.

## F-10 · `cordis.yml` pointing at a `.ts` file — WRONG

A bundle ships `package.json` + `cordis.patch.yml` + plain ESM JavaScript. The loader does **not** compile
TypeScript, so `/absolute/path/to/src/index.ts` cannot be mounted.

## F-11 · TypeScript project + `tsconfig.json` — RISKY

This Desktop build ships **no `.d.ts` files at all** for the DSH packages, so `tsc` cannot type-check against
the real API surface. Plain ESM JavaScript (`export function apply(ctx, config)`) is the supported host form
and needs no dependencies, build tool, or install script. That is what was built. JSDoc typedefs are used
instead of TypeScript types.

## F-12 · Profile target — WRONG

The doc installs into `web`. The GUI at `127.0.0.1:19387` runs the **`desktop`** profile, which is where the
bundle was installed. `web` is a different profile with the third-party plugin and would need its own install.

## F-13 · Token budget semantics — RISKY

`tokenBudget: 4000` applied to the whole incoming conversation would be violently destructive and would risk
orphaning tool calls (a `tool/result` without its `tool-call`). The budget is therefore applied to the
**injected role context**, and the `agent/pre-step` hook only shortens oversized text blocks *inside*
messages — it never drops a message. Independent of this plugin, the Host already prunes large tool results
(`ctx.toolResultPruner`, threshold 8192 / head 4096 / tail 1024 chars).

## F-14 · "Hot reload: no restart needed" — PARTLY WRONG

Config changes reconcile live. A **changed JavaScript module generation requires a restart**: the docs state
"replacing an installed package requires restart to load a fresh JavaScript module generation." Empirically
confirmed here — after adding the status tool and re-installing, the new tool did **not** appear in the live
tool registry.

## F-15 · `notifyChannel: 'web'` and `atomicClaimTimeout` — WRONG

Neither option exists. Approval is surfaced through the session **approval policy** (`'ask' | 'never'`) and
the composed answerers; a missing answerer fails **closed** (`'unavailable'` → deny). There is no
plugin-configurable notification channel and no claim timeout to tune — the built-in CAS is transactional.

## F-16 · The `ask` decision and the human answer — WRONG assumption

A listener that returns `{ kind: 'ask' }` **never sees the human's decision**. The tool runtime resolves it —
`'allowed-once'` becomes `allow`, and `rejected` / `cancelled` / `unavailable` become `deny`. If a gate needs
the outcome itself it must await `ctx.approval.request(...)` inline (which requires an open turn and honours
the `never` policy by returning `'rejected'`). Both modes are implemented and switchable.

---

## Acceptance criteria re-check

| # | Criterion | Status |
|---|---|---|
| 1 | Current session acts as Lead | **Already native** — the built-in Agent Teams profile provides it; no plugin needed |
| 2 | Concurrent claim → exactly one winner | **Already native** — transactional revision CAS; the plugin adds policy on top |
| 3 | Different roles see different context; tokens drop | Implemented per-role `section()` + tool restriction + per-message elision under a real budget |
| 4 | High-risk operation requires human approval | Implemented via `ask` (default) or inline `ctx.approval.request` |
| 5 | State changes shown live in the Web UI | **Not implemented** — needs a Client half (slot registration); out of the Host-only scope of this bundle |
