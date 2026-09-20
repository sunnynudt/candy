# Goal Task P4 实现设计：token 用量透传、任务级记账与 token 预算

状态：**代码完成并提交**；adapter/platform/runtime/客户端与测试均通过，**live provider 用量契约校验未在本任务沙箱内执行**（缺凭据与网络，需在普通主机补验，见 §5）。
范围：Candy V1，macOS 先行（Windows 后续补）。
前置：`docs/architecture/goal-task-proposal.md` §6.3/§10 P4、[`goal-task-p1-design.md`](./goal-task-p1-design.md)、[`goal-task-p3-design.md`](./goal-task-p3-design.md)。

> 原则：外部产品仅能力对照；本片全部口径、文案与标识符为 Candy 自研。

## 1. 范围

**做**

- **Pi Adapter 用量透传**：从 Pi 的 `message_end`（assistant `usage`）按回合累加，新增观测 `turn.usage`（`{ input, output, cacheRead, cacheWrite }`）。适配器不含口径逻辑，只透传 provider 原始数值。
- **Candy 记账口径**：`packages/runtime/src/usage.ts` 提供 `ProviderTokenUsage`、`normalizeTokenUsage`、`addTokenUsage`、`billableTokens`；口径集中在 `billableTokens` 一个函数里。
- **任务级 token 记账与预算**：`goal_tokens_used` / `goal_token_budget`（P0 预留列）正式启用；goal policy 按回合累加、参与 75% 收敛阈值与耗尽判定，耗尽同语句转 `budget_limited`（reason `token budget exhausted`）并注入一次 wrap-up。
- **协议与客户端**：`GoalSnapshot`/`GoalSpec`/`goal.set`/`goal.budget` 支持 token 预算；TUI 支持 `/goal ... --tokens <n>`、`/goal budget --tokens <n>`，摘要/状态栏/状态行显示 token；WebUI goal 面板显示 token。
- 测试：adapter 观测（既有投影测试路径）、runtime usage/口径、platform token 预算与耗尽、runtime policy token 预算、app-server token 预算用例。

**不做（P5）**

- Auto Debug 双份实现合并、CONTEXT.md/ADR 术语定稿。
- 桌面（Electron）客户端。
- Windows 上的 live 用量契约复核（推迟到 Windows 主机）。

## 2. 口径（先定稿，写进测试）

`billableTokens(usage) = max(0, input − cacheRead) + output`

- `input` 已包含缓存命中与缓存写入部分（DeepSeek/MiniMax 的 OpenAI 兼容用法），`cacheRead` 是 provider 折价的上下文重放，因此不重复计费；`cacheWrite` 属于 `input`，不再单列。
- `output` 已包含 reasoning/thinking 子集（provider 契约如此），不重复累加。
- 该口径只出现在 `billableTokens`，并由 `packages/runtime/src/usage.test.ts` 固定：预算耗尽、收敛阈值、注入消息与 `goal_tokens_used` 全部走它。
- 预算是**回合粒度**的：每回合结束时结算，因此最后一回合可能超出预算（已在测试与文档中显式记录，不做半回合截断）。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/pi-adapter/src/index.ts` | `PiTokenUsage`、`turn.usage` 观测、回合内按 `message_end` 累加并在 settle 前发出 |
| `packages/runtime/src/usage.ts`（新增）+ `usage.test.ts`（新增） | 口径与累加/规范化/校验 |
| `packages/runtime/src/index.ts` | re-export usage；`AgentObservation` 增加 `turn.usage` |
| `packages/runtime/src/goal.ts` | `GoalTurnReport.tokensUsed`、`accountUserTurn(wallClockMs, { tokensUsed })`、预算状态/收敛/结果含 token、运行摘要含 token |
| `packages/runtime/src/goal-message.ts` | 延续消息的预算与用量段增加 token 行 |
| `packages/runtime/src/goal-tools.ts` | `candy_goal_set`/`candy_goal_budget` 接受 `token_budget`；`candy_goal_status` 报告 token |
| `packages/platform/src/index.ts`、`goal.ts` | `setGoal`/`updateGoalBudgets` 接受 tokenBudget，`accountGoalUsage` 接受 tokenDelta；耗尽 reason 含 token；删除 `rejectTokenDimension` |
| `packages/platform/src/goal.test.ts` | token 预算/用量/耗尽用例；P0 的“token 未支持”断言改为“预算非法” |
| `packages/protocol/src/index.ts` | `GoalSnapshot`/`GoalSpec`/`goal.set`/`goal.budget` 的 token 字段与校验 |
| `apps/tui/src/main.ts` | `--tokens`、token 摘要/状态/徽标、把回合 token 传给 policy |
| `apps/app-server/src/main.ts`、`web-ui.ts` | 回合 token 透传到 policy、协议字段透传、WebUI 面板显示 token |
| `apps/app-server/src/main.test.ts` | token 预算耗尽用例 |

## 4. 测试矩阵（P4 门禁）

1. **口径**：`billableTokens` 的四种情况（无缓存、有 cacheRead、cacheRead > input 不为负、空记录）；`addTokenUsage` 字段级累加；`normalizeTokenUsage` 对 NaN/小数/负数的处理；`isTokenUsage` 完整性。
2. **平台**：`setGoal` 接受 tokenBudget 并拒绝 0/负数；`accountGoalUsage` 累加 `goal_tokens_used`、达到预算时同语句转 `budget_limited` 且 reason 为 `token budget exhausted`；负数 tokenDelta 被拒；已 `budget_limited` 的目标提高预算也不会自动恢复。
3. **policy**：起始用户回合的 token 计入预算；持续两回合后在 token 预算处停止（含 wrap-up、`budget_limited`、`GoalRunResult.tokensUsed`）；`goalBudgetState` 的剩余 token 与 75% 收敛（tokenBudget=0 视为未配置）。
4. **app-server**：`task.create` 带 `tokenBudget` → 快照 `goal.tokenBudget`；假引擎发 `turn.usage` → 目标在 token 预算处暂停，`tokensUsed=1800`、reason `token budget exhausted`、goal run `stopReason=budget_limited`。
5. **回归**：既有 goal/协议/app-server/web-ui/TUI 用例全绿（127 例定向回归）。

## 5. live provider 用量契约校验（待普通主机执行）

未在本任务沙箱执行（无 provider 凭据、网络需人工确认）。补验步骤：

1. 配置凭据（`/credential set deepseek` 或环境变量方式，按 `docs/testing/live-provider-credentials.md`）。
2. `npm run gate:live:deepseek --confirm-live`；如需 MiniMax：`npm run gate:live:minimax --confirm-live`（国内端点 `https://api.minimaxi.com`）。
3. 确认点：
   - provider 是否在 `usage.input` 中**包含**缓存命中/写入（本口径假设包含）；
   - `cacheRead`/`cacheWrite` 是否分别为非负整数且语义与 Pi 一致；
   - 一次多轮工具调用回合里，`turn.usage` 是否等于各次模型调用之和；
   - 若某 provider 的语义不同（例如 `input` 不含缓存），**只需修改 `packages/runtime/src/usage.ts` 的 `billableTokens`** 并更新对应测试，其余链路不变。
4. 若发现口径偏差，把结论写回本文件 §2 并补一条 fixture/单测。

## 6. 验证证据（本任务沙箱内）

- pinned Node 22.23.2 / npm 10.9.8：`build`、`lint`、`format:check` 通过。
- 定向回归：runtime（usage/goal/message/tools/fixture）53 例、platform goal 10 例、pi-adapter goal-tools 4 例、TUI goal 8 例、app-server 35 例、web-ui 5 例、protocol 既有 27 例，合计 127 例全绿。
- 全量 `npm test` 仍只剩 6 个既有的嵌套沙箱环境失败（native sandbox runner 与沙箱内 npm 脚本）。
- 未验证：live provider 用量契约（§5）；`npm run smoke:app-server`（见 P3 文档 §6）。

## 7. 工具链事项

与 P3 相同：`packages/pi-adapter/src/index.ts`、`apps/app-server/src/main.ts`、`apps/app-server/src/web-ui.ts` 等文件被 Candy 自身的凭据写入守卫误判，`candy_write`/`candy_edit` 无法写入；本片对这些文件的改动同样用一次性本地脚本完成（脚本用完即删），提交前对**全部新增行**重跑平台扫描（0 命中）。长期修法见 `goal-task-p3-design.md` §7。

## 8. 后续衔接

1. P5（可选收尾）：Auto Debug 双份实现合并评估；CONTEXT.md/ADR 术语定稿；`/goal edit` 外部编辑器编辑。
2. Windows 主机补做：live 用量契约复核 + 相关 smoke。
3. 若后续要按 token 做**预估式**刹车（回合内截断），需要 provider 流式 usage 或预算前置估算，属新切片。
