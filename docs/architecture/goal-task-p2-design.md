# Goal Task P2 实现设计：TUI 接入共享续跑 policy

状态：**已实现并提交**（TUI `/goal` 命令族、Goal Task 执行、摘要/状态栏、目标编辑 steering；附带两处 P1/P0 修正与一个待接线的工具注册缺口）。P3（WebUI/app-server）起待续。
范围：Candy V1，macOS 先行。本片只接 TUI；不改 protocol、不动 app-server；桌面客户端不在范围内。
前置：`docs/architecture/goal-task-proposal.md` §10 P2、[`goal-task-p1-design.md`](./goal-task-p1-design.md)（共享 policy/工具集/注入模板）、`goal-task-p0-design.md`（schema 18 + 状态机 + 存储 API）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. P2 范围

**做**

- `/goal` 命令族：摘要、创建 Goal Task、替换、暂停、恢复、清除、预算。
- Goal Task 执行：起始用户回合计入预算 → 共享 policy 驱动自动续跑 → stop-reason 映射到任务状态；进度写入 `task_goal_runs`。
- 摘要展示：`/goal`、`/status` 的 goal 段落、顶部状态栏 goal 徽标。
- 目标编辑 steering：运行中替换目标时用 `steer` 注入新目标（围栏 + 脱敏 + 有界）。
- TUI 测试：命令族、自动续跑、预算收尾、暂停、让位、替换/清除、输入校验。

**不做（留到后续）**

- WebUI / app-server 接入与 protocol 扩展（P3）。
- token 预算（P4）。
- 目标文本的外部编辑器交互式编辑（本片 `/goal edit` 是 `/goal replace` 的别名；编辑器通道接入属后续增强）。

## 2. 设计决策

1. **`/goal <objective>` 创建新 Goal Task**（`taskMode='goal'`），目标在首个回合前就写入存储，policy 与 `/goal` 看到同一份持久状态；起始用户回合的 prompt 是 `[GOAL]` 说明 + 目标正文（目标仍是用户数据）。
2. **未完成目标需显式确认**：当前任务已有非 `complete` 目标时，`/goal <objective>` 拒绝并要求 `/goal replace <objective>` 或 `/goal clear`；当前任务仍在运行时也拒绝新建。
3. **起始用户回合计入回合预算**（§13 已确认默认）：`runner.accountUserTurn(wallClockMs)`；`task_goal_runs.rounds` 只记 policy 发起的续跑回合，`goal.turnsUsed` 记全部 goal 回合（含起始回合）。
4. **空闲信号来自 TUI 真实状态**：`turnActive=false`、`queuedUserInput=本轮是否已有排队输入`、`pendingApproval=待审批动作`、`ownershipHeld=未 abort 且未退出`、`shuttingDown=退出中`；`awaitingUserInput` 暂无对应信号。用户排队输入优先：让位停止（`user_stop`）而不是与用户回合竞争。
5. **stop-reason → 任务状态**：`complete` → `completed`；`blocked`/`budget_limited`/`usage_limited`/`paused`/`error`/`user_stop` → `paused`（稳定、可显式恢复）；`cancelled`/`interrupted` → 沿用既有中断语义。goal 层直接写任务元数据，因此回合结束时先用 `refreshController` + `ensureController` 重新读取 revision，再做任务状态转移（否则 CAS 会过期失败）。
6. **无进展指纹**：每个续跑回合结束后用既有变更追踪器计算 `sha256([tracked, untracked, patchText])` 作为工作区指纹，交给 policy；仅当“无工具活动且指纹未变且已知”才计数（无 Git 基线的任务不计数）。
7. **目标编辑 steering**：`/goal replace` 在任务运行时用 `engine.steer` 注入新目标（`fenceGoalData` + `boundGoalText`），不重放旧 prompt；空闲时替换后立即开始一次续跑回合。
8. **预算/阻塞恢复路径**：`budget_limited`/`usage_limited` 不可直接恢复（P0 语义），提示 `/goal clear` 后重设；`paused`/`blocked` 可 `/goal resume [text]`，并提示 blocked 计数重新开始。
9. **摘要保持脱敏**：`/goal` 与 `/status` 的目标/判据/终止原因都经过既有的 `redactSensitive`；状态栏只显示状态与回合用量。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/tui/src/main.ts` | `/goal` 分发与命令族、`parseGoalArguments`、Goal Task 创建（`taskMode='goal'` + `setGoal`）、`runGoalTask`（policy 驱动 + 进度写库 + stop 映射）、`/status` goal 段落、goal 停止文案、TuiGoalStopError 与 `safeError` 透传、goal 徽标数据源 |
| `apps/tui/src/slash-commands.ts` | `/goal` 命令条目与子命令补全；修正“仅 `/model` 才走模型候选”的补全分支（此前任意带 `getArgumentCompletions` 的命令都会列出模型） |
| `apps/tui/src/pi-tui-surface.ts` | chrome `goalBadge` 选项 + `refreshChrome()`（goal 状态变化后重绘） |
| `apps/tui/src/goal-task.test.ts`（新增） | 命令族 / 自动续跑 / 预算收尾 / 暂停 / 让位 / 替换清除 / 校验测试 |
| `packages/pi-adapter/src/goal-tools.ts`（新增） | goal 工具 → Pi 工具定义的桥（结构化，无 runtime 依赖） |
| `packages/pi-adapter/src/goal-tools.test.ts`（新增） | 桥的映射、执行委托、错误与参数形状测试 |
| `packages/pi-adapter/package.json` | 增加 `./goal-tools` 子路径导出 |
| `packages/runtime/src/goal.ts` | 预算已耗尽的起始回合后仍注入一次收尾回合（此前只有“续跑回合导致耗尽”才收尾） |
| `packages/platform/src/index.ts` | `accountGoalUsage`/`updateGoalBudgets` 不再清空已记录的 `goal_terminal_reason`（`COALESCE`） |
| `packages/platform/src/goal.test.ts` | 覆盖终止原因保留与显式 resume 清除 |
| `docs/usage/tui-commands.md` | `/goal` 命令族与行为说明 |

## 4. 命令族

| 命令 | 行为 |
|---|---|
| `/goal` | 当前任务目标摘要；无任务时给用法 |
| `/goal <objective> [--criterion <text>] [--turns <n>] [--minutes <n>]` | 创建 Goal Task（新任务）；当前任务已有未完成目标或仍在运行时拒绝 |
| `/goal replace <objective> [options]` | 替换当前任务目标（预算与计数重置）；运行中经 steering 注入，空闲时开始续跑回合 |
| `/goal edit …` | 本片为 `replace` 的别名（外部编辑器编辑待后续） |
| `/goal pause` | `active → paused`，停止自动续跑 |
| `/goal resume [text]` | `paused`/`blocked → active`，必要时开始一次续跑回合；blocked 计数重新开始 |
| `/goal clear` | 清除目标（任务与 transcript 保留） |
| `/goal budget [--turns <n>] [--minutes <n>]` | 查看或设置预算 |

`--criterion` 是自由文本，遇到下一个 `--turns`/`--minutes` 才结束；目标/判据/续跑文本复用 TUI 既有守卫（4096 上限、控制字符、凭据形态与活动密钥拒绝），被拒绝时不会创建任何任务。

## 5. 测试矩阵（P2 门禁）

`apps/tui/src/goal-task.test.ts`（7 例）：

1. Goal Task 创建 → 自动续跑 1 轮 → 模型标记 complete → 任务 completed，`task_goal_runs.stopReason=complete`，注入消息含目标围栏与用量摘要。
2. 回合预算耗尽：起始回合用尽预算 → 注入一次收尾回合 → 任务 paused，goal `budget_limited`。
3. `/goal pause`：运行中暂停 → 停止续跑，任务 paused，摘要显示 `state: paused` 与恢复路径。
4. 排队用户输入优先：起始回合中提交输入 → 让位停止（`user_stop`），只跑了起始回合，目标保持 active。
5. `/goal replace` 重置目标/预算/计数并开始续跑；`/goal clear` 清除目标（任务仍在）。
6. `/goal` 无任务/超长目标/非法预算/凭据形态目标的拒绝与不回显。
7. 结构化桥接：runtime `GoalToolHost` 直接满足 pi-adapter 的 `CandyGoalToolBridge`（为后续工具接线保留编译期契约）。

同时覆盖：`packages/runtime` policy 新增路径（预算耗尽的收尾回合）、`packages/platform` 终止原因保留、`packages/pi-adapter` 桥。

## 6. 验证与已知缺口

- pinned Node 22.23.2 / npm 10.9.8：`build`、`format:check`、`lint`、`typecheck`、`check:boundaries`、`check:pi-versions`、`check:lifecycle-scripts` 全部通过。
- 相关用例：TUI goal 7 例、TUI main 全量、runtime/platform/pi-adapter 的 goal 用例全绿；全量测试仍保留 6 个既有的嵌套沙箱环境失败（native sandbox runner 与沙箱内 npm 脚本），与本片改动无关。
- **缺口（已定位，待决定）**：模型可见的 goal 工具尚未注册进 Pi 引擎。接线需要 (a) 在 `PiAgentEngineInput` 增加 `goalTools` 字段并把工具并入会话的 `tools`/`customTools`，(b) TUI 每回合用 `createCandyGoalToolDefinitions(goalToolHost)` 生成工具。桥模块、子路径导出与测试已就绪，但 **`packages/pi-adapter/src/index.ts` 被 Candy 自身的凭据写入守卫误判**：该文件里一个私有参数的类型标注（形如 `…Secret: (` 的参数写法）命中平台的 `secret` + 冒号 + 长值模式，导致任何对该文件的 `candy_write`/`candy_edit` 都被拒绝并返回 “Provider credentials are forbidden in workspace writes.”（文件本身不含任何真实凭据，纯属模式误判）。因此这两处小改动留待人工编辑或守卫模式修正后再落地。
- 影响：在工具接线完成前，目标无法由模型主动标记 `complete`/`blocked`；本片的目标只能经预算、用户暂停/清除、运行时失败或让位停止。续跑、预算、无进展、状态机、持久化与 UI 已完整可用。

## 7. 后续衔接

1. 解除 `packages/pi-adapter/src/index.ts` 的写入阻塞（人工编辑，或收紧守卫模式使其不再误判类型标注）。
2. 在 `PiAgentEngineInput` 增加 `goalTools?: readonly piSdk.ToolDefinition[]`，引擎把其并入 `tools`/`customTools`。
3. TUI `runTask` 为 goal 任务每回合构造 `GoalToolHost`（共享同一 `GoalBlockedClaimLedger`，`activeSecrets` 取当回合）并注入 `createCandyGoalToolDefinitions`；随后补一条“模型经工具标记 complete/blocked”的 TUI 用例。
4. P3：app-server `runTask` 接同一 policy，protocol 增加 goal 事件/命令；WebUI 复用同一摘要与恢复路径。
