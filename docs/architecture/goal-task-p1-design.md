# Goal Task P1 实现设计：共享续跑 policy、工具集与延续消息

状态：**已实现并提交**（`packages/runtime` 新增 goal policy / 工具集 / 延续消息模板 / 审计语义 fixture，`packages/platform` 增补一个无 schema 变更的计数写入方法）。P2（TUI 接入）起待续。
范围：Candy V1，macOS 先行。本片**不接 TUI UI**、不改 protocol、不动 app-server 回合循环；token 预算仍属 P4。
前置：`docs/architecture/goal-task-proposal.md` §10 P1、`docs/architecture/goal-task-p0-design.md`（P0 已提交：schema 18 + goal 状态机 + 存储 API）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. P1 范围与不做什么

**做**

- `packages/runtime` 内共享 goal 续跑 policy：条件评估、回合数 + 墙钟预算、stop-reason、无进展计数；形态对齐 `LongRunningTaskRunner`。
- 复用 P0 的 goal 状态机与存储 API（`getGoal/setGoal/updateGoalStatus/updateGoalBudgets/accountGoalUsage/clearGoal/recordGoalRun`），仅增补一个纯计数写入方法 `setGoalNoProgress`（无 schema 变更）。
- goal 工具集（查询/创建/信号更新/预算）与权限模型（模型不得 pause / budget_limited / usage_limited / clear）。
- 延续消息注入模板：自研措辞、不可信数据围栏、脱敏、有界；完成/阻塞审计语义以 prompt 契约形式给出。
- 审计语义 fixture（规则 × surface 一致性 + 可执行场景回放）。
- runtime 单测：policy、模板、工具集、fixture；平台侧补 `setGoalNoProgress` 测试。

**不做（留到后续）**

- TUI `/goal` 命令族、状态栏、目标编辑 steering（P2）。
- app-server / WebUI / protocol 扩展（P3）。
- token 用量透传与 token 预算（P4）。
- Auto Debug 双份实现合并（P5）。

## 2. 设计决策

1. **policy 放 `packages/runtime/src/goal.ts`**：`runtime` 已依赖 `platform`，反向不成立；P0 已把状态机放 platform，本片只在其上加“何时继续”的策略。
2. **形态对齐 `LongRunningTaskRunner`**：`GoalContinuationRunner.run(turnCallback, signal, progress?)` 由 policy 自己驱动回合，宿主提供 (a) 回合回调、(b) 空闲信号读取器、(c) 进度 binding。宿主（P2/P3）只在调用前后做任务状态转移与会话注入。
3. **存储 seam 用结构化接口**：`GoalContinuationStore` / `GoalToolStore` 只声明所需方法，`SQLiteTaskStore` 结构满足；测试里用真实 `SQLiteTaskStore`（`:memory:` 与文件库），不写假存储，避免状态机被复制。
4. **模型信号走“声明账本”而非直接写状态**：`blocked` 不能一次生效，因此 `candy_goal_update blocked` 只写入 `GoalBlockedClaimLedger`，由 policy 在回合结算后判定阈值；`complete` 与用户点名的 `active` 直接走存储状态机。账本生命周期 = 一次执行区间（resume 后重新计数，符合 §4.1/§7.3）。
5. **预算口径**：起始用户回合计入回合预算（宿主显式调用 `accountUserTurn(wallClockMs)`）；每个续跑回合 `turnDelta=1`；墙钟按“回合耗时 + 本次 policy 运行内的间隔”累加并持久化（跨重启续加，不把非执行期的日历时间计入）。预算耗尽由 `accountGoalUsage`/`updateGoalBudgets` 原子转 `budget_limited`，**绝不自动 complete**。
6. **收尾回合计入但不新增实质工作**：预算耗尽后 policy 额外发起**一次** `wrap_up` 回合（提示词替换为收尾规则），随后以 `budget_limited` 停止；该回合不记账、不影响无进展计数。
7. **stop-reason 复用平台枚举**：`GoalContinuationStopReason = Exclude<GoalRunStopReason, "running">`，所以 policy 结果可直接写 `task_goal_runs.stop_reason`，不引入第二套词表。
8. **“让位”语义**：目标不再是 active、用户排队输入、待审批、等待用户回应、owner 丢失、退出等，都归为 `user_stop` 停止并带 `yieldedTo` 明细，宿主据此决定是否启动用户回合。
9. **失败语义**：provider/运行时失败 → goal 转 `paused`，结果带脱敏类别 `provider_failure` / `runtime_error` 供 `/resume` 提示；取消/中断不改 goal 状态（显式 resume 继续同一目标）；usage 限制 → `usage_limited`。
10. **无进展只计数**：需要“无工具活动 + 工作树指纹未变且已知”才 +1，不自动 pause；计数持久化到 `goal_consecutive_no_progress`，并在延续消息中提示。
11. **消息契约**：默认上限 4096（对齐 `MAX_GOAL_TEXT_CHARS`，即 `MAX_TUI_TURN_MESSAGE_CHARS` 口径），下限 3072（低于此值直接报错，不产出半截消息）；目标优先，完成判据只在剩余空间 ≥256 字符时注入；截断只发生在围栏内部，围栏始终配对；目标/判据先脱敏、再规范化控制字符、再转义围栏标记行。
12. **工具结果同样脱敏且有界**：工具返回文本走 `redactCredentialMaterial` + 同口径截断；目标/判据回显也放在同一围栏中。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/runtime/src/goal.ts`（新增） | 条件评估、预算、stop-reason、无进展、`GoalBlockedClaimLedger`、`GoalControlError`、`GoalContinuationRunner` |
| `packages/runtime/src/goal-contract.ts`（新增） | Candy 自研审计/行为/收敛/收尾规则文案（跨 surface 单一来源） |
| `packages/runtime/src/goal-message.ts`（新增） | 延续与收尾消息模板、围栏/脱敏/有界工具函数 |
| `packages/runtime/src/goal-tools.ts`（新增） | goal 工具集定义（JSON Schema 参数）+ `GoalToolHost` |
| `packages/runtime/src/goal-audit-fixture.ts`（新增） | 审计语义 fixture（规则 × surface、可执行场景） |
| `packages/runtime/src/goal{,-message,-tools,-audit-fixture}.test.ts`（新增） | policy / 模板 / 工具 / fixture 测试 |
| `packages/runtime/src/index.ts` | 导出新 API 与类型 |
| `packages/platform/src/index.ts` | `setGoalNoProgress(taskId, revision, goalId, count)`（additive，无 schema 变更） |
| `packages/platform/src/goal.test.ts` | 新方法 CAS/goalId/校验测试 |

## 4. 条件评估（`evaluateGoalContinuation(goal, signals)`）

优先级（先判目标生命周期，再判宿主控制，最后判让位与预算）：

1. 无 goal → `no_goal`；
2. 状态非 active → `goal_paused` / `goal_blocked` / `goal_complete` / `goal_budget_limited` / `goal_usage_limited`；
3. `shuttingDown` → `shutting_down`；`ownershipHeld=false` → `ownership_lost`；
4. 活动回合 / 待审批 / 排队用户输入 / 等待用户回应 → 拒绝续跑；
5. `continuationDeferred` → `continuation_deferred`；
6. 预算已耗尽（防御性；存储层通常已转 `budget_limited`）→ `budget_exhausted`；
7. 否则继续，并给出下一回合序号、剩余回合/墙钟、`nearBudget`（任一已启用预算 ≥75%）。

## 5. 工具集与权限模型

| 工具 | 允许调用方 | 行为 |
|---|---|---|
| `candy_goal_status` | model / user | 只读摘要（状态、预算、用量、无进展计数、待确认 blocked 声明、终止原因），目标与判据在围栏内 |
| `candy_goal_set` | model / user | 创建/替换；未完成 goal 无 `replace:true` 拒绝；文案要求“仅用户明确请求时调用” |
| `candy_goal_update` | model / user | `complete`（直接走状态机）、`blocked`（写账本，达阈值才落库）、`active`（仅用户点名恢复时转发） |
| `candy_goal_budget` | model / user | 转发用户明确给出的预算；`token_budget` 直接拒绝（P4） |

模型不可 pause / budget_limited / usage_limited / clear：既没有对应工具，`candy_goal_update` 也会以“这些是用户命令”拒绝。凭据形态的目标、判据、blocked 原因一律拒绝且不回显。

## 6. 审计语义 fixture

`goal-audit-fixture.ts` 是“代码无法完全强制”的语义的可评审载体：

- `rules`：每条规则指向 `goal-contract.ts` 的某条句子，并声明必须出现在哪些 surface（`continuation_prompt`、`continuation_prompt_near_budget`、`wrap_up_prompt`、`goal_tools`）。测试比对真实 surface 文本，防止改文案时静默丢规则。
- `scenarios`：可执行场景（目标+预算+脚本化回合 → 期望 stop-reason / 目标状态 / 回合数 / 收尾回合数 / 无进展提示与持久化值）。测试用真实 `SQLiteTaskStore` 回放，验证状态机与 policy 的一致行为。

## 7. 测试矩阵（P1 门禁）

1. **条件评估**：无 goal、五类非 active、shutdown/ownership/活动回合/审批/排队输入/等待回应/延迟标记/预算耗尽、正常继续的字段。
2. **预算**：剩余回合与墙钟、75% 收敛阈值；起始用户回合计入；回合预算耗尽 → `budget_limited` + 一次收尾回合；墙钟预算耗尽同样生效；绝不自动 complete。
3. **stop-reason**：complete / blocked / budget_limited / paused / cancelled / error / user_stop 与 `yieldedTo` 明细；`task_goal_runs.stop_reason` 落库一致。
4. **阻塞审计**：同一 reason 连续 N 次才落库 `blocked`；不同 reason 或出现可观测进展即清零。
5. **无进展**：连续无工具活动且指纹未变才计数；持久化到 `goal_consecutive_no_progress`；达阈值只提示不 pause。
6. **确定性引擎**：用 `DeterministicAgentEngine` + `CandyRuntime` 作为回合实现跑通续跑循环。
7. **跨重启恢复**：用量/状态持久化；重启后仍 active 可显式续跑；paused 需显式 resume；budget_limited 不可直接 resume。
8. **模板**：围栏配对、围栏标记行转义、activeSecrets 与凭据形态脱敏、控制字符规范化、有界（下限 3072 / 默认 4096）、目标优先与判据让位、收敛/收尾/无进展/待确认声明提示。
9. **工具集**：定义面（无 pause/clear 工具）、创建/替换/超长/控制字符/凭据拒绝、complete 仅 active、blocked 阈值与原因匹配、active 仅用户点名、预算写入与 token 拒绝、结果脱敏与有界、未知参数/未知工具拒绝。
10. **fixture**：规则 × surface 一致性 + 场景回放。
11. **平台**：`setGoalNoProgress` 的 CAS、goalId 不匹配、非法计数、跨重启读回。

## 8. 验证门禁与证据

- 构建与测试均使用 pinned Node **22.23.2**（npm 10.9.8）。
- `npm run build`：通过。
- `npm run check` 组成：`format:check`、`lint`、`typecheck`、`test`、`check:boundaries`、`check:pi-versions`、`check:lifecycle-scripts` 全部通过，另跑 `check:toolchain` 通过。
- 新增/相关用例：runtime goal 20 + 模板 9 + 工具 8 + fixture 2 + platform 8，共 47 个全绿。
- **环境限制（与本片无关）**：完整 `npm test` 有 6 个用例在当前主机的嵌套沙箱环境下失败（`native/sandbox-runner` 与沙箱内 npm 脚本路径，退出码 71），分布在本片未改动的 `packages/pi-adapter`、`packages/runtime/v1.test.ts`、`apps/tui` 沙箱用例；本片 diff 不触及这些代码路径。

## 9. 后续衔接（P2/P3 接线点）

1. 创建 goal 任务：`taskMode='goal'` + `store.setGoal(...)`；宿主在建任务或 `/goal` 命令后调用。
2. 起始用户回合结束后：`runner.accountUserTurn(wallClockMs)`，随后 `runner.run(turn, signal, progress)`；`turn` 内把 `context.message.text` 注入同一 Pi session。
3. 空闲信号：`turnActive`、`queuedUserInput`、`pendingApproval`、`awaitingUserInput`、`ownershipHeld`、`shuttingDown` 由宿主从既有状态读取。
4. 回合观测：`toolActivations`（排除 goal 工具）与工作树指纹供无进展判定；`signal`（complete/blocked/active）由工具宿主写入存储或账本。
5. 结果映射：`result.stopReason` → 任务状态（`user_stop`/`cancelled`/`interrupted`/`error` 等既有映射规则）；`result.failureCategory` 用于 `/resume` 提示；`progress.store.record` → `store.recordGoalRun`。
6. 工具注册：`listGoalToolDefinitions()` 转成适配层工具定义（参数为 JSON Schema，需在适配层转 TypeBox）；`GoalToolHost` 与 runner 共享同一 `GoalBlockedClaimLedger` 与 `blockedTurnLimit`。
