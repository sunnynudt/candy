---
status: accepted
---

# Add Goal Tasks as a Long-running Task strategy

Candy supports a **Goal Task**: a Candy Task that carries a persisted, user-supplied objective (with an optional completion criterion) and continues itself while that goal is `active`. Goal Tasks let a user hand Candy a verifiable long-running objective without turning Candy into a workflow engine, and without giving the model new permissions.

## Decision

A Goal Task is a strategy on top of the existing single-agent loop, alongside plan/build and Auto Debug. The durable goal state lives in the platform task store (schema 18: `goal_*` columns plus `task_goal_runs`) and one shared continuation policy in `packages/runtime` drives automatic turns for both clients (TUI and the app-server/WebUI backend); clients do not grow their own goal loops. The Electron desktop client is out of scope for this iteration.

- **States.** `active`, `paused`, `blocked`, `budget_limited`, `usage_limited`, `complete`. Only `active` continues automatically. `complete` is terminal; a new goal may be set after it. `paused` and `blocked` resume explicitly (a resume restarts the blocked-audit count). `budget_limited` and `usage_limited` are not resumable: the user clears the goal and sets a new one.
- **Continuation conditions.** Candy starts the next goal turn only when the goal is `active` **and** the task has no active turn, no pending approval, no queued user input, no pending user answer, no continuation deferral, and no exhausted budget. A user who queues input wins the next turn.
- **Budgets.** Turn count, active wall clock, and billable tokens. Each is optional, each converges toward a wrap-up at 75% of its budget, and any exhausted budget moves the goal to `budget_limited` with a single wrap-up turn. Budgets are checked per turn, so the final turn may overshoot. Candy never marks a goal `complete` because a budget ran out.
- **Token口径.** Billable tokens are `max(0, input − cacheRead) + output` from provider usage: cache reads are the provider's discounted context replay, cache writes are already inside `input`, and reasoning tokens are already inside `output`. The口径 lives in exactly one function (`billableTokens` in `packages/runtime/src/usage.ts`) and must be re-verified against a live provider before release.
- **Model authority.** The model may query a goal, create one only when the user explicitly asked, signal `complete` or `blocked`, resume when the user asked, and forward a budget the user gave. The model may never pause a goal, set `budget_limited` or `usage_limited`, or clear a goal.
- **Audit semantics are a prompt contract, enforced where code can.** Completion requires evidence per explicit requirement (an observed artifact, never a plan or summary). A block is confirmed only after the same blocking condition repeats for three consecutive goal turns (the starting user turn counts) or when the objective itself is impossible, unsafe, or self-contradictory. No-progress turns are counted and reported but never auto-pause a goal.
- **Goal text is untrusted data.** Objective and completion criterion are user data: fenced as data in every injected message, redacted against active provider secrets, bounded, and never able to change system, tool, approval, credential, commit, or push rules.
- **Nothing else changes.** Goal continuation grants no approval bypass; credentials stay out of sessions, prompts, logs, and tool environments; commits remain Candy-managed and push stays user-authorized; concurrent writable tasks keep using separate Task Worktrees; and a Goal Task occupies its own execution slot without asking for a second one.

## Consequences

- Persistence, budgets, and stop reasons are auditable: goal state and usage survive restarts, and each run records its stop reason separately from Auto Debug runs.
- After a restart the task is `interrupted`/`paused` and requires an explicit resume; Candy never replays an uncertain turn.
- The user-visible surfaces are the TUI `/goal` command family and the app-server/WebUI protocol commands and goal panel; protocol compatibility is versioned like every other Candy command.
- Auto Debug keeps its own validator-driven loop; goal and Auto Debug deliberately do not share stop semantics. Merging the two client copies of the Auto Debug loop remains optional follow-up work.
