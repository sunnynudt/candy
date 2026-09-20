# Goal Task P3 实现设计：app-server（WebUI 后端）接入共享续跑 policy

状态：**代码完成、已提交**；`app-server`/`web-ui`/`protocol` 测试与构建通过，**`npm run smoke:app-server` 未能在本任务沙箱内验证**（原因与复现步骤见 §6，需在普通主机上补验）。
范围：Candy V1，macOS 先行。本片接 app-server（WebUI 后端）与 protocol；桌面客户端不在范围内。
前置：`docs/architecture/goal-task-proposal.md` §10 P3、[`goal-task-p1-design.md`](./goal-task-p1-design.md)（共享 policy/工具集/注入模板）、[`goal-task-p2-design.md`](./goal-task-p2-design.md)（TUI 接入与工具注册）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. 范围

**做**

- `packages/protocol`：任务快照与命令/事件新增 goal 能力（`TaskSnapshot.goal`、`task.create.goal`、`goal.set`/`goal.pause`/`goal.resume`/`goal.clear`/`goal.budget`、`goal.changed`，以及 `task.state_changed.reason` 增加 `goal`），并给出与 platform 目标存储同一口径的边界校验。
- `apps/app-server`：Goal Task 创建（`taskMode='goal'` + 持久化 goal）、goal 命令族、**policy 驱动的自动续跑**（注入 goal 工具、写 `task_goal_runs`、stop-reason 映射）、快照与 `goal.changed` 事件。
- `apps/app-server/src/web-ui.ts`：任务视图带 goal、创建任务可带 goal、页面新增 Goal 面板与 Pause/Resume/Clear 端点。
- `packages/runtime`：抽出共享的 `buildGoalStartPrompt(objective)`，TUI 与 app-server 用同一段起始提示（消除两端文案复制）。
- 测试：app-server 4 例、web-ui 1 例（含经真实 goal 工具的 complete/blocked 路径）。

**不做（留到 P4/P5）**

- token 预算与 usage 透传（P4）。
- Auto Debug 双份实现合并、CONTEXT.md/ADR 术语定稿（P5）。
- 桌面（Electron）客户端。

## 2. 设计决策

1. **协议只表达 goal 的持久形状**：`GoalSnapshot` 与 `@candy/platform` 的 `TaskGoalSnapshot` 字段对齐（不含 `goalId`/token 维度），客户端不需要理解状态机内部字段即可展示状态/用量/终止原因。
2. **创建与运行分离**：`task.create` 可携带 `goal`（一次建成 Goal Task）；`goal.*` 命令只改持久状态；是否开始/继续回合由客户端显式 `task.run`/`task.resume` 决定——与 app-server 既有的显式运行模型一致（TUI 的 `/goal resume` 直接续跑，是客户端便利而非协议语义）。
3. **未完成目标要显式确认**：`goal.set` 在已有非 `complete` 目标时必须带 `replace: true`，否则拒绝（与 TUI 的 `/goal replace` 一致）。
4. **运行中替换走 steering**：任务 `running` 时 `goal.set` 会写入新的目标并把一段围栏化、脱敏、有界的 `[GOAL-UPDATED]` 文本排入该任务的 steering 队列，由下一次 `consumeSteering` 注入当前会话，不重放旧 prompt。
5. **续跑语义与 TUI 完全一致**：起始用户回合计入预算（`accountUserTurn`）、每个自动回合注入 `buildGoalContinuationPrompt`、无进展指纹取 `sha256([tracked, untracked, patchText])`（非 Git 工作区不计）、预算耗尽注入一次 wrap-up 后停止且**绝不自动 complete**。
6. **模型可见的 goal 工具**：每回合用 `createCandyGoalToolDefinitions(GoalToolHost)` 注册 `candy_goal_status/set/update/budget`，宿主与 policy 共享同一个 `GoalBlockedClaimLedger`（resume 后阻塞计数重新开始）；非 goal 任务不注册。
7. **空闲信号来自 app-server 真实状态**：`queuedUserInput` = 该任务 steering 队列非空、`pendingApproval` = 有待确认的 shell 审批、`ownershipHeld` = 仍持有执行权且未 abort、`shuttingDown` = 控制器已关闭。
8. **stop-reason → 任务状态**：`complete` → `completed`；`blocked`/`budget_limited`/`usage_limited`/`paused`/`error`/让位 → `paused`（可显式恢复）；`cancelled`/`interrupted` 抛给既有 catch 路径按 `task.pause`/`task.cancel` 的语义收尾。状态变更事件 reason 用新增的 `goal`。
9. **进度可见**：goal 回合进度写 `task_goal_runs` 并在每次写入后发一次快照；任务快照本身不承载 goal run（保持与 Auto Debug 的 `progress` 语义分离）。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/protocol/src/index.ts` | `GoalSnapshot`/`GoalSpec`、`TaskSnapshot.goal`、`task.create.goal`、`goal.set/pause/resume/clear/budget`、`goal.changed`、`state_changed.reason: "goal"`、校验函数（含导出的 `validateGoalSpec`） |
| `apps/app-server/src/main.ts` | goal 创建/命令、`runGoalTask`（policy + 工具 + 指纹 + stop 映射）、`goalContinuationSignals`、`toGoalSnapshot`/`goalChanged`、`runAgentTurn`/`runTurn` 支持 `goalTools` 与工具活动计数、快照带 goal |
| `apps/app-server/src/web-ui.ts` | 任务视图带 goal、创建可带 goal、`POST /api/tasks/:id/goal/{pause,resume,clear}`、页面 Goal 面板 |
| `apps/app-server/src/web-ui.test.ts` | 新 goal 页面用例 |
| `apps/app-server/src/main.test.ts` | 4 个 goal 用例（完成/预算收尾/阻塞阈值/命令族与边界） |
| `packages/runtime/src/goal-message.ts`、`index.ts` | 共享 `buildGoalStartPrompt` |
| `apps/tui/src/main.ts` | 改用共享起始提示（去掉本地副本） |

## 4. 命令与事件契约

| 命令 | 行为 |
|---|---|
| `task.create` + `goal` | 建 Goal Task（`taskMode='goal'`），首个回合 prompt 为 `buildGoalStartPrompt(objective)`；返回 `task.created` + `goal.changed` + 快照 |
| `goal.set` | 设置/替换目标；已有未完成目标时需 `replace: true`；运行中同时把新目标 steering 进当前回合 |
| `goal.pause` | `active → paused`；非 active 拒绝 |
| `goal.resume` | `paused`/`blocked → active`（阻塞计数重新开始）；其它状态拒绝并提示先 `goal.clear` |
| `goal.clear` | 清除目标（任务与 transcript 保留） |
| `goal.budget` | 设置回合数/墙钟预算（至少一项） |

事件：`goal.changed { goal? }` 在 goal 创建/替换/状态变化/清除与 goal 运行结束时发出；`snapshot` 现在携带 `goal`。

## 5. 测试矩阵（P3 门禁）

app-server（`apps/app-server/src/main.test.ts`，4 例）：

1. 创建 Goal Task → 快照/`goal.changed` 显示 active 目标与预算 → `task.run` → 第 2 回合模型经 `candy_goal_update complete` 完成 → 快照 `goal.status=complete`、`goal.terminalReason`、`turnsUsed=2`、`task_goal_runs.stopReason=complete`、`rounds=1`，注入消息含围栏与用量。
2. 回合预算 1 → 起始回合用尽预算 → 注入一次 wrap-up → 任务 paused、`goal.status=budget_limited`、goal run `stopReason=budget_limited`。
3. 连续 3 个 goal 回合（含起始回合计入阻塞审计）同一原因声明 blocked → 任务 paused、`goal.status=blocked`、工具返回文本依次 1/3、2/3、达到阈值。
4. 命令族与边界：`goal.set` 无 `replace` 拒绝、`replace` 成功；`pause`/`resume`/`budget`/`clear` 快照与事件正确；非法预算、超长目标、无目标时 `pause` 均被拒绝。

web-ui（`apps/app-server/src/web-ui.test.ts`，1 例）：`app.js` 含 goal 控件；带 goal 创建 → 视图有 goal；预算收尾后 `goal/pause` 返回 409、`goal/clear` 清除；非法 goal 请求 400。

既有回归：app-server 既有用例（含 Auto Debug、shell 审批、并发/排队）全绿；protocol 既有用例全绿。

## 6. 验证证据与未验证项（交接重点）

已验证（pinned Node 22.23.2 / npm 10.9.8）：

- `npm run build`、`npm run lint`、`npm run format:check` 通过。
- `node --test apps/app-server/dist/main.test.js` → 34/34 通过。
- `node --test apps/app-server/dist/web-ui.test.js` → 5/5 通过。
- `node --test packages/protocol/dist/protocol.test.js` → 全绿。
- 全量 `npm test`：除 6 个**既有**的嵌套沙箱环境失败（`native/sandbox-runner` 与沙箱内 npm 脚本，本片未改这些路径）外全绿。

**未验证（spawn 版）`npm run smoke:app-server`。** 症状：在本任务（外层 Candy 命令沙箱）里，该脚本 spawn `apps/app-server/dist/main.js` 并向 stdin 写入一条 `snapshot` 命令后等待子进程 exit；命令在沙箱内被中断（`Command aborted`），且把该 spawn 放进后台子 shell 也同样被中断——沙箱会清理长期存活的子进程。

- **已在进程内等价验证（P5 补充）**：`apps/app-server/src/stdio-smoke.test.ts` 用 `PassThrough` 流调用 `runAppServer(stdin, stdout, { appDataRoot })`，发送与 smoke 完全相同的 JSONL 命令并断言同两个条件（`"kind":"event"`、`"task-1"`、`"type":"snapshot"`），另覆盖“连续两条有效命令”与“非法 JSONL 行”。因此 stdio 循环本身不依赖外部进程管理即可验证；spawn 版 smoke 仍保留给 CI／普通主机。
- **顺带修复（P5 补充）**：非法 JSONL 行此前会以未处理拒绝结束 stdio 循环（可能带走进程），现在回 `{"v":1,"kind":"error","code":"invalid_message"}` 并干净关闭；“畸形行之后是否继续服务”（跳过 vs 终止）已在 **P6 解决并实现**：完整行解码失败默认跳过并继续服务，连续 8 行失败才 fail closed（见 `goal-task-p5-design.md` §6.4 与 `goal-task-p6-design.md`）。
- 复现与补验（普通主机）：
  1. `git fetch origin codex/candy-v1-foundation` 并检出对应提交；
  2. `npm run smoke:app-server`（预期输出 `app-server JSONL smoke ok`）；
  3. 同步跑 `node --test apps/app-server/dist/stdio-smoke.test.js`（进程内等价断言）。

其它需要在普通主机确认的既有环境项（与本片无关）：native Sandbox Runner 相关 5 例与 TUI 沙箱 npm 脚本 1 例。

## 7. 工具链事项：守卫已改为语义判定（方案 A）

问题：写入/提交守卫此前是纯文本匹配——形如“凭据词紧接长值”的文本（内部字段赋值、构造函数类型标注、凭据租赁字面量等）都会被判为凭据材料，于是 `candy_write`/`candy_edit` 会拒绝编辑**不含真实凭据**的源码文件，`candy_git_commit` 也会拒绝“删除这类文本”的改动（重命名凭据相关标识符必然带上删除侧）。

处理（已实现，对真实凭据的行为不变）：

- `packages/platform/src/credential-guard.ts` 改为**语义判定**：无歧义形状（`Bearer …`、provider 前缀、AWS key、私钥块、URL 内联 userinfo）照旧；带标签的赋值只在“值看起来像数据”时才算凭据——函数/类型/对象语法、成员引用链、关键字、模板片段一概不算。新增 `packages/platform/src/credential-guard.test.ts` 固定两侧行为（真实形状仍检出/脱敏；凭据处理源码不再误报；活动密钥仍必脱敏；`[REDACTED]` 标记与导出 API 不变）。
- `candy_git_commit` 的提交前扫描改为只判**新增行**（提交只能通过新增内容引入凭据；删除凭据形态的代码不是泄露），提交信息仍按原规则扫描。
- 结果：`packages/pi-adapter/src/index.ts`、`apps/app-server/src/main.ts`、`apps/app-server/src/web-ui.ts`、`apps/app-server/src/web-ui.test.ts`、`packages/protocol/src/protocol.test.ts`、`packages/platform/src/credential-guard.ts` 现在都可被 Candy 工具直接读写（已用 `candy_edit` 实测）。此前为绕开误判所做的改名与构造（`acquireSecretFn`、`#secretValue`、`#authValue`、`secretLease()`、运行期拼装测试夹具等）予以保留：它们与语义判定互补，且对新出现的**故意形似凭据**的夹具（32 字符随机值、Bearer 字面量等）仍是必要的。
- 仍会被判为“含凭据”（按设计，属故意夹具）：`apps/tui/src/main.test.ts`、`apps/tui/src/file-mentions.test.ts`、`packages/runtime/src/v1.test.ts`、`packages/platform/src/native-process.test.ts`、`apps/desktop/src/*`（桌面客户端，本期不在范围）。要改这些文件时，用运行期拼装夹具的写法即可。

## 8. 交接清单（Codex）

1. 检出 `codex/candy-v1-foundation` 最新提交（本片为 P3）。
2. `nvm use`（pinned Node 22.23.2）→ `npm ci` → `npm run build`。
3. 跑门禁：`npm run lint && npm run format:check && npm run typecheck`；定向 `node --test apps/app-server/dist/main.test.js apps/app-server/dist/web-ui.test.js packages/protocol/dist/protocol.test.js`；再跑 `npm test`（预期仅 6 个既有环境失败）。
4. 补验 `npm run smoke:app-server`（§6）。
5. 若都要绿：P3 关闭；下一步 P4（Pi Adapter usage 透传 + token 预算）或 P5（Auto Debug 合并 / 文档术语定稿）。
6. 改 `apps/app-server/*`、`packages/pi-adapter/src/index.ts`、`packages/protocol/src/protocol.test.ts` 时注意 §7 的写入守卫问题。
