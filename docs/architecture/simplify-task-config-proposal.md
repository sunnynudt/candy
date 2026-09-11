# Simplify Candy Task Configuration — Architecture & Component Proposal

Status: Phase 1 implemented as proposed — awaiting the `npm run check` verification gate before commit (see §8).
Scope: Candy V1 (canonical branch `codex/candy-v1-foundation`)

## 1. Problem

Candy exposes a large, coupled user-facing configuration surface that a senior
programmer coming from Codex / Claude Code has to memorize. Today the TUI has
~40 slash commands, and the "task mode / profile / isolation" family is the
main cognitive tax:

| Cluster | Commands | Hidden coupling |
|---|---|---|
| Approval profile | `/profile read-only\|auto` | plan mode is `read-only`; `/build` promotes |
| Isolation | `/worktree on\|off` | default is **direct** workspace (not isolated) |
| Shell | `/trusted-shell on\|off`, `/shell` | requires Auto profile + `/worktree on` + native Sandbox Runner + Git-backed Task Worktree; network needs approval |
| Validator | `/validator`, `/validate` | `/debug` requires a validator |
| Modes | `/plan`, `/build`, `/debug` | plan = read-only profile; debug = build + validator loop |
| Undo | `/undo`, `/checkpoints`, `/discard` | only works on isolated (worktree) tasks |

Concrete pain: enabling Trusted Shell can fail with a cascade of
`rejected: requires ...` unless the user already knows the prerequisite chain.
That is a discoverability failure, not a security requirement.

## 2. Goals

1. Keep every security invariant unchanged (see §4).
2. Move isolation/sandbox/approval behavior into **runtime-internal derivation**
   so the user no longer has to reason about it.
3. Reduce the **user-visible** toggle count to the smallest orthogonal set.
4. Match the Codex / Claude Code feel: create a task → it runs isolated +
   sandboxed automatically → user reviews a diff → approves external/network
   actions.

Non-goals: removing credential isolation, disabling approvals, removing the
Sandbox Runner, dropping cross-platform support, or pursuing feature parity.

## 3. Target architecture

### 3.1 Single conceptual model

A task is one of:

- **Review-first (plan)**: read-only; the model produces a plan; user reviews;
  then it may run with approvals.
- **Act (build/debug)**: runs with approvals; debug is an opt-in loop that runs
  the task's check command until pass/stall/budget.

Everything about "where it runs" (direct vs worktree), "which sandbox", and
"which approval" is **derived**, not selected.

### 3.2 Derived-isolation

- Any task that can mutate (run a command, edit files) runs in an **auto-created
  Git Task Worktree** by default.
- The user's Local Workspace stays untouched until they `Apply`.
- Running directly in the Local Workspace becomes an **explicit, advanced
  opt-out** (`--direct` / hidden toggle), not the default.

### 3.3 Single shell/command switch

- Replace the `trusted-shell` prerequisite chain with one explicit, per-task
  decision: "may this task run sandboxed commands?" (`/shell on|off`).
- Internally this resolves worktree + sandbox + approval in one place; it never
  surfaces `rejected: requires X`.

### 3.4 Hidden/advanced surface

- `profile`, `plan/build` promotion, `debug` mode, `validator` setup, and
  worktree tweaks move to **advanced** (a `help`/`advanced` section, or
  deprecation-warned aliases). The default path is: `/new [prompt]` → review →
  `/apply` `/approve`.
- `/tasks` and `/status` merge into one view; `/changes` `/diff` `/apply`
  `/validate` consolidate around a single "review this change" flow.

## 4. Invariants that stay (non-negotiable)

- Provider credentials never enter sessions, logs, diagnostics, model context,
  tool args, or tool subprocess environments.
- Any command the model triggers runs sandboxed (macOS Seatbelt / Windows Job
  Object) and owns its process tree; model/task/approval logic never moves into
  the native helper.
- External/network actions require explicit user approval even on allow-listed
  sites.
- No silent provider fallback; MiniMax stays on `https://api.minimaxi.com`.
- Local-first; one agent per task; bounded parallel tasks.
- Writable tasks using the same repository run in separate Git worktrees.

These are why isolation exists. The design keeps them but stops asking the user
to configure them.

## 5. Component design

| Component | Current | Target |
|---|---|---|
| `runtime` (TaskController) | profile/mode logic user-facing | derives isolation + approval internally; fewer user-visible states |
| `platform` (store) | `worktree_path` optional, direct default | auto-derive worktree when a task may mutate; schema stays additive |
| `pi-adapter` | tools + gated shell runner | one `run_sandboxed_command` path that auto-satisfies prerequisites; credential-free env |
| TUI surface + slash commands | ~40 flat commands | merge/alias; hidden advanced toggles; deprecation warnings on old aliases |
| status/revue display | already improved | surface derived state as a hint, not a required choice |

### 5.1 Key interfaces

- `deriveExecutionContext(task): { workspace, worktreePath, sandbox, approvals }`
  — single internal resolver; replaces the scattered prerequisites.
- `runSandboxedCommand(plan): { result, approvalMaybe }` — one adapter seam;
  keeps credentials out of the child env.
- `CandyCommandSurface` — merged, aliased command table; old names keep working
  but are marked deprecated.

## 6. Migration & compatibility

- Existing persisted tasks keep their state. On next run, tasks that may mutate
  get a worktree auto-derived once.
- `/worktree`, `/profile`, `/trusted-shell`, `/debug`, `/validator` continue to
  work but emit a deprecation hint (no breakage of old muscle memory).
- Schema changes are additive; no destructive migration.
- The simplified path is the default only for **new** tasks; old tasks are
  handled on a best-effort, non-breaking basis.

## 7. Staged execution (each stage must pass verification before the next)

> Execution requires running the project gate. This session has no
> shell/execution tool, so each stage below is gated on `npm run check` (and the
> listed smoke tests). Any stage that cannot be verified is **not** merged.

- **Phase 1 — Auto-isolation default**: derive a Task Worktree for any
  mutating task; keep `/worktree off` as explicit override.
  Gate: `npm run check`, `smoke:tui:journey`, cross-client, concurrency, recovery
  (macOS + Windows).
- **Phase 2 — Single shell switch**: collapse the `trusted-shell` prerequisite
  chain into one `/shell on|off` that resolves everything internally; remove the
  `rejected: requires X` cascade.
  Gate: Trusted Shell smoke, credential-isolation, real-PTY matrix, packaged
  macOS.
- **Phase 3 — Command surface consolidation**: merge/alias `tasks`/`status`,
  `changes`/`diff`/`apply`/`validate`; hide advanced toggles behind a help
  section; keep old aliases with deprecation warnings.
  Gate: TUI terminal matrix, help-text snapshots, TUI journey.
- **Phase 4 — Profile/mode semantic collapse**: fold read-only/auto + build/debug
  into the review-first / act model internally.
  Gate: acceptance (ACC), cross-platform, live-provider gate.

## 8. Self-review findings (read before executing)

1. **Security must not weaken.** Auto-isolation still requires a credential-free
   command env and network/approval gating. Never derive away approval.
2. **Verification gap.** Because this session has no shell/execution tool, none
   of Phases 1–4 can be verified here. Do **not** land a big-bang refactor
   without the gate; execute only stage-by-stage behind `npm run check`.
3. **Compatibility risk.** Auto-worktree derivation must not resurrect stale
   worktrees or corrupt existing task metadata; keep schema additive.
4. **Power-user risk.** Hiding toggles can surprise advanced users. Mitigate with
   deprecation warnings and an explicit advanced/help section.
5. **Smallest slice first.** Start with Phase 1 (auto-isolation) — it removes the
   largest single cognitive load (must remember `/worktree on`) and is the least
   invasive. Phases 2–4 build on it.

## 9. Open questions for the owner

- Should direct (non-worktree) execution remain available, or be removed for V1?
- Should the debug loop be an explicit task option or always "run the check
  command when present"?
- How aggressive should Phase 3 be about hiding legacy commands?
