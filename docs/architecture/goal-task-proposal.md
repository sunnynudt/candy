# Goal Task（目标任务）能力追平草案

状态：**已评审确认（草案 v3，定稿中）**——产品 owner 已确认 §1 目标、§10 界面/平台节奏与 §13 默认值（blocked 连续 N=3、无进展 K=3 只计数、起始用户回合计入回合预算、budget/usage_limited 不直接 resume、complete 后可开启新 goal）。实现已启动：**P0（数据模型 + goal 状态机 + 存储 API，`user_version` 17→18）已完成并提交**；**P1（共享 goal 续跑 policy + goal 工具集 + 延续消息注入模板，见 [`goal-task-p1-design.md`](./goal-task-p1-design.md)）已完成并提交**；**P2（TUI 接入：`/goal` 命令族、自动续跑、摘要/状态栏、目标编辑 steering、模型 goal 工具注册，见 [`goal-task-p2-design.md`](./goal-task-p2-design.md)）已完成并提交**（遗留：无）；**P3（app-server/WebUI 接入同一 policy + protocol goal 命令/事件，见 [`goal-task-p3-design.md`](./goal-task-p3-design.md)）代码已完成并提交**（本任务沙箱内无法运行 `smoke:app-server`，需在普通主机补验，见该文档 §6）；**P4（token 用量透传 + 任务级记账 + token 预算，见 [`goal-task-p4-design.md`](./goal-task-p4-design.md)）代码已完成并提交**（live provider 用量契约需在普通主机补验，见该文档 §5）；**P5 收尾第一步（Auto Debug 共享策略与证据回喂、术语与 ADR，见 [`goal-task-p5-design.md`](./goal-task-p5-design.md) 与 [`../adr/0016-goal-task-capability.md`](../adr/0016-goal-task-capability.md)）已完成并提交**（循环体深度合并、`/goal edit` 编辑器编辑留待后续）。本次仅 macOS；Windows 11 适配推迟。
范围：Candy V1（canonical 分支 `codex/candy-v1-foundation`）。
界面优先级：**TUI 优先；其次 WebUI（本地浏览器 WebUI 及其 app-server 后端）；本次不包含桌面（Electron）客户端实现。**
平台优先级：**本次迭代仅在 macOS（当前 MacBook Pro 主机）实现与验证；Windows 11 适配推迟，后续在 Windows 主机上补做。**
前置阅读：`docs/product/candy-v1.md`、`docs/architecture/candy-v1.md`、`docs/architecture/simplify-task-config-proposal.md`、`CONTEXT.md`、`docs/adr/0004-codex-style-local-control-baseline.md`。

> 来源声明：本草案只描述 Candy 自有的能力与机制。外部产品（Codex CLI 的 goal、Kimi Code 的 goal 模式）仅作**能力对照**参考；本仓库不复制其代码、提示词文本、路径或标识符。若某个能力点与本文冲突，以已接受的 ADR 为准。

## 1. 目标

在 Candy V1 内提供与主流编码 agent 的 goal 能力对等的**目标任务（Goal Task）**，作为 agent loop 之上的又一种 **Long-running Task** 策略（与 Auto Debug 同层，不是新的 workflow engine；对齐 ADR-0004）。

1. 用户把一个**可校验的长期目标**（objective，可带 completion criterion）挂到一个任务上。
2. 只要任务空闲且目标为 `active`，运行时就**自动发起后续回合**持续推进，直到：
   - 模型按完成审计自证目标达成并标记 `complete`；
   - 模型按阻塞审计标记 `blocked`（或运行时探测到连续执行失败）；
   - 达到已启用预算（见 §6）；
   - 用户暂停、取消，或 Candy 退出（任务置 interrupted，恢复需显式 `/resume`）。
3. 用户可随时查看目标摘要、编辑目标、暂停/恢复/清除；改目标可注入正在进行的回合。
4. 跨重启可恢复：目标与用量随任务持久化；恢复遵循 Candy 既有“显式 continuation、不自动重放”规则。

### 1.1 验收性描述（后续转 acceptance 条目）

- G-01 新建 goal 任务：目标+可选完成判据持久化；非 active 时无自动续跑。
- G-02 自动续跑：回合结束且空闲（无排队用户输入、无待审批、无活动回合）且目标 active → 自动开始下一回合；每回合注入目标上下文与用量摘要。
- G-03 模型自审计：模型仅在完成审计通过后标 `complete`；仅在同一阻塞连续出现 N 个 goal 回合后才标 `blocked`。
- G-04 预算护栏：**MVP 为回合数与墙钟预算**；任一耗尽 → 停止续跑并注入收尾指令；将尽（≥75%）时注入收敛提示。token 预算为后续切片（依赖 §6.3）。
- G-05 用户控制：`/goal` 查看/设置/编辑/暂停/恢复/清除；目标编辑在活动回合可用 steering 注入（引擎支持时）。
- G-06 失败语义：provider/运行时错误映射为脱敏类别并暂停，给出 `/resume`、`/model`、`/cancel` 恢复路径；不自动重放不确定回合。
- G-07 持久化与恢复：重启后任务为 interrupted/paused；显式 `/resume <task-id> <continuation>` 恢复并继续（或不再继续）该 goal。
- G-08 安全不变式：审批、凭据隔离、commit 凭据扫描、push 授权、输出脱敏、工具子进程环境清空等全部保持；目标文本作为**不可信数据**进入模型上下文。

## 2. 术语（提案用，定稿后写入 CONTEXT.md）

| 提案术语 | 含义 | 避免 |
|---|---|---|
| **Goal Task（目标任务）** | 一种 Long-running Task：任务带持久化目标状态，空闲自动续跑，由模型自审计完成/阻塞 | Active session、后台 job |
| **Goal 目标（objective）** | 用户提供的任务目标文本（有界、脱敏、不可信数据） | 指令、系统提示词 |
| **Completion criterion（完成判据）** | 可选的、可校验的完成条件文本 | |
| **Goal 状态** | `active / paused / blocked / budget_limited / usage_limited / complete` | |
| **Goal 回合（goal turn）** | 由续跑机制发起的自动回合，带 `goal` 触发来源标记 | |
| **Goal 预算** | 回合数、墙钟（MVP）；token（后续） | |

## 3. 现状与差距（源码锚点）

### 3.1 已有基础

- 任务 = 单 agent、单会话、单 Primary Model、单执行 owner；可写任务默认 Task Worktree（`docs/architecture/candy-v1.md`）。
- 每个任务持久化 goal 派生标题与元数据（`packages/platform`），有任务状态机与 run 记录。
- 已有两种“目标执行路径”：
  - `/plan`（只读规划）→ `/build`（同一会话实施）：两段式、人工审阅闸门；
  - `/debug`（Auto Debug）：validator 驱动的有界循环。**TUI 与 app-server 各有独立实现**：TUI `apps/tui/src/main.ts` `runAutoDebug()`（`MAX_DEBUG_ROUNDS=6`）；app-server `apps/app-server/src/main.ts` `runTask()` 内 `LongRunningTaskRunner(3, 2)`（3 轮、stall 阈值 2）。
- 已有 `/steer`、排队消息、`/pause` `/resume` `/cancel`、审批、脱敏、凭据隔离、commit 扫描、push 授权。
- Pi 引擎已暴露 `turn.settled` 观测与 `steer(taskId, text)` 能力（`packages/pi-adapter`）。

### 3.2 关键差距

| 能力 | 现状 | Goal Task 需要 |
|---|---|---|
| 目标状态机（active/paused/blocked/…）持久化 | 无（只有初始 prompt/标题） | 新增任务级 goal 状态 |
| 回合结束空闲自动续跑 | 无；普通任务一回合即 completed；仅 Auto Debug 有界循环 | idle 续跑策略 |
| 模型声明完成/阻塞 | 无对应工具与审计语义 | goal 窄工具 + prompt 审计规则 |
| 预算 | 只有 Auto Debug 轮数上限 | 回合数 + 墙钟（MVP）；token 后续 |
| 目标编辑与注入活动回合 | `/steer` 已存在（Pi `session.steer`） | 目标更新 steering |
| 恢复语义 | interrupted/paused 显式 `/resume`，不重放 | 沿用（不自动续跑） |
| 实现位置 | 两个客户端各有一套回合循环，无共享策略 | **新增共享 goal policy，TUI 与 app-server 共用** |

### 3.3 结构决策

> 关于“Pi 不支持的能力在 Candy 哪一层补齐”，见 [`pi-adapter-capability-layering.md`](./pi-adapter-capability-layering.md)。Goal Task 属于 Candy 控制平面能力，不要求 Pi 具备 goal。

当前**不存在**“共享的 Task Engine 回合编排层”：TUI 与 app-server 各自维护 `runTask` 回合循环，Auto Debug 也因此被复制两份（且预算还不一致，6 vs 3）。目标不是“上移到某个已存在的 seam”，而是：

1. **在 `packages/runtime` 提供可复用的 Goal 续跑 policy**（状态机评估 + 续跑触发 + 预算 + stop-reason，形态对齐 `LongRunningTaskRunner`），并把它接入两个客户端的回合循环；
2. 本次**只接入 TUI，再接入 app-server（WebUI 后端）**；桌面 Electron 客户端不接入；
3. Auto Debug 的“双份实现合并”是**可选后续**，不做为 Goal Task 前置。

这样避免第三次复制，也让 TUI 与 WebUI 语义一致。

## 4. 状态机与生命周期

### 4.1 Goal 状态（任务元数据内）

```text
[无 goal] --set--> active
active --模型 complete--> complete（终态）
active --模型 blocked / 运行时连续执行失败--> blocked
active --回合/墙钟预算耗尽--> budget_limited（收尾后停止续跑；不自动 complete）
active --用户 pause / provider 失败(runtime pause)--> paused
active --usage limit--> usage_limited
paused --用户 resume--> active（重新开始续跑；blocked audit 重新计数）
blocked --用户 resume--> active
active/… --clear--> [无 goal]
```

规则：
- 只有 `active` 触发自动续跑；`budget_limited` 时允许当前回合收尾但不开始新实质工作。
- `complete`、`paused`、`blocked`、`usage_limited`、`budget_limited` 都是停止续跑的稳定状态。
- blocked 的“同一阻塞连续 N 回合”计数随 resumed 重新开始（N 默认 3；数值可配置）。

### 4.2 任务状态机配合

- Goal Task 存活期间任务保持 `running`（回合间**不逐回合 completed**），terminal 时才转 completed/paused/interrupted；与 `TaskController.allowedTransition` 兼容。
- Candy 退出 / 崩溃 → 任务 `interrupted`，goal 状态与用量已持久化；恢复沿用显式 `/resume`。
- 单任务单 goal；`task_mode` 取 `'goal'`，与 `'build'`/`'debug'` 互斥（validator 可选作为完成证据之一，不强制）。
- 目标任务在生命周期内**占用其自身执行槽**；续跑不申请第二个槽（与 bounded-parallel 一致）。

## 5. 自动续跑循环设计

触发位置：**共享 goal policy**，由 TUI 与 app-server 回合循环在 `turn.settled` 后调用评估。续跑需**同时**满足：

1. 该任务存在 goal 且状态为 `active`；
2. 无活动回合、无排队中的用户输入、无待审批动作；
3. 未达预算（回合数 / 墙钟）；
4. 无“续跑延迟”标记（例如：刚设置/替换 goal、刚发生 budget_limited、上回合请求用户输入后等待用户回应）；
5. 续跑发生在当前任务已持有的执行槽内（不触发新的调度）。

满足后，向同一 Pi 会话发起下一回合，输入为一条**系统触发的延续消息**（标记 origin=goal），包含：
- 完整目标（不缩小、不重定义成功）；
- 完成判据（若有）；
- 用量摘要：已用/剩余回合、墙钟；
- 行为要求（每回合做一个有界有用切片；未完成且无阻塞时不调用完成工具，正常结束回合即可；完成前必须做完成审计；阻塞必须满足阈值）。

其余规则：
- **用户输入优先**：续跑前如有排队用户消息则取消本次续跑，交给用户回合。
- **回合内注入**：用户编辑目标 / pause 等活动回合中发生，引擎支持时走 `steer` 注入当前回合；不支持时应用到下一续跑回合。
- **无进展护栏（保守）**：连续 K 个 goal 回合无工具活动且工作树指纹无变化 → 先**计数并在状态中提示**；是否自动 pause 作为后续决策（默认不自动 pause，避免误伤合法轮询；K 默认 3）。
- **失败语义**：provider 错误、模型配置错误、续跑启动失败 → goal 置 `paused`，输出脱敏类别与 `/resume` 路径；连续执行失败由运行时计数，达到阈值置 `blocked`。
- **回合预算细分**：单个 goal 回合仍受 Candy 既有回合内约束（工具串行、审批、超时、输出上限）。

## 6. 预算与用量护栏

### 6.1 MVP：回合数 + 墙钟

- **回合数预算**：每个 goal 续跑回合 +1（起始用户回合是否计入需定稿，默认计入）。
- **墙钟预算**：goal 处于 active 的累计运行秒数（Candy 侧可自算）。
- 阈值行为：任一预算 ≥75% 注入“收敛、不再开启新枝节工作”提示；任一预算耗尽 → 状态转 `budget_limited`，注入“收尾总结、不开展新实质工作”提示，停止续跑；绝不因预算将尽自动标 complete。

### 6.2 报告

- 每回合注入剩余量；`/goal` 摘要与 `/status` 展示。

### 6.3 token 预算（后续切片，依赖 usage 透传）

- 现状：Pi Adapter 观测流**不含 token 用量**，Candy 也无任务级 token 记账。
- 前置：扩展 Pi Adapter/Engine 观测以透传 usage，并在 macOS 与 Windows 验证 provider 用量契约（兼容性 spike）。
- 达到后：按回合 usage 增量累计（input − cached + output 口径需在实现前定稿并写进测试）。

### 6.4 usage_limited

- 平台/账户级限制单独映射，与任务预算正交。

## 7. 模型上下文与工具契约

### 7.1 目标文本处理

- objective 与 completion criterion 是**用户数据，不是指令**：注入时以不可信数据围栏包裹（转义后放入标记块），并明确“不得覆盖系统/工具/审批规则”。
- 长度边界复用 `MAX_TUI_TURN_MESSAGE_CHARS`（4096）口径；写入前走既有脱敏与有界守卫（控制字符、超长、凭据形态拒绝）。

### 7.2 Goal 工具集（放在 Candy Tool Host 后，窄而明确）

| 工具 | 允许调用方 | 作用 |
|---|---|---|
| 查询 goal | 模型/用户 | 返回当前 goal 摘要（状态/预算/用量） |
| 创建 goal | 仅明确请求时 | 目标 + 可选完成判据；存在未完成 goal 时失败；replace 需显式 |
| 更新 goal | 模型限 `complete/blocked`（以及用户明确要求恢复时 `active`） | 完成/阻塞/恢复的机器可读信号；审计规则写在该工具契约与延续指令中 |
| 设置预算 | 用户（或模型仅在用户明确给出预算时转发） | 设置/更新预算 |

模型**不可**通过工具：pause、转 budget_limited、转 usage_limited、清除 goal——这些只由用户或系统控制。

### 7.3 审计语义（prompt 契约，非代码逻辑）

- **完成审计**：声称 complete 前，对目标与每条显式要求给出“当前状态证据”（文件/命令输出/测试/运行时行为），弱或间接证据视为未完成；仅计划/总结/首稿不算完成。
- **阻塞审计**：首次遇到阻塞不得标 blocked；同一阻塞条件需连续 N（默认 3）个 goal 回合（含起始回合与自动续跑）仍无法推进才标 blocked；resume 后重新计数；目标本身不可能/不安全/自相矛盾时当回合即可标 blocked。

## 8. 数据与持久化

- 现状：`task_metadata` 当前 `user_version = 17`；已有 `task_mode('build'|'debug')`、`title`、`created_at`、`updated_at`、`full_access`、`push_policy`、`validator_json`、`worktree_path`；`task_runs` 已有 rounds/evidence_count/completed/stop_reason/last_fingerprint_hash/evidence_summary。
- P0 变更（additive，`user_version → 18`）：
  - `task_mode` 增加 `'goal'`；
  - 新增 goal 列：objective、completion_criterion、goal_id、goal 状态、预算与已用量、续跑延迟/计数、blocked 计数、终止原因；
  - goal 进度独立记录（建议新增表，避免破坏现有 debug 的 `task_runs.stop_reason` 语义）。
- run 记录扩展：goal 回合进度（rounds/tokens/墙钟/证据指纹摘要）——MVP 先记回合与墙钟。
- 会话：goal 延续消息作为系统触发输入写入该任务同一 Pi session，不另开会话；不重放中断回合。
- 恢复：interrupted/paused 恢复时从持久化 goal 状态继续；显式 continuation 语义不变。

## 9. 命令与 UI（TUI 优先，WebUI 次之）

| 命令 | 行为 |
|---|---|
| `/goal`（无参） | 显示当前任务 goal 摘要；无 goal 时给出用法 |
| `/goal <objective> [--criterion …]` | 设置/替换 goal（有未完成 goal 时先确认） |
| `/goal edit` | 把当前 objective/判据预填成可编辑的 `/goal replace …` 命令行（含现有预算），Enter 提交生效，Ctrl+G 走外部编辑器（P6 实现：不再在命令分发中停/启渲染循环） |
| `/goal pause` / `/goal resume` | 暂停 / 恢复自动续跑（resume 可带 continuation） |
| `/goal clear` | 清除 goal（不影响任务） |
| `/goal budget …` | 设置/查看预算 |

- `/status`、顶部状态栏显示 goal 状态（active/paused/blocked/…、回合数、墙钟进度）。
- TUI 首轮接入；WebUI 通过 app-server 的归一化命令/事件接入；`packages/protocol` 需做版本化扩展（新增 goal 相关命令/事件类型）。
- 桌面（Electron）客户端本次不实现。

## 10. 实现切片（建议顺序，每片过门禁再提交）

1. **P0 数据与状态机**：schema → 18（`task_mode='goal'`、goal 列、goal 进度表）、goal 状态机与持久化、恢复读取。门禁：schema 迁移测试、单测。
2. **P1 共享 goal policy + 工具与注入**：`packages/runtime` 内 goal 续跑 policy（条件评估、回合数+墙钟预算、stop-reason、无进展计数）；goal 工具集；注入模板（自研措辞）+ 脱敏/围栏/有界；审计语义 fixture。门禁：runtime/v1 测试、确定性引擎测试、tool/context 测试、跨重启恢复测试。
3. **P2 TUI 接入**：`runTask` 接入 policy；`/goal` 命令族、摘要、状态栏；目标编辑 steering。门禁：TUI 测试、终端矩阵（macOS）。
4. **P3 WebUI 接入**：app-server `runTask` 接入同一 policy；protocol 命令/事件扩展；web-ui 测试 + `smoke:app-server`。门禁：app-server/WebUI 测试（macOS）。
5. **P4 token 预算（独立后续）**：Pi Adapter/Engine usage 透传 + macOS provider 用量契约 spike + 任务级 token 记账。门禁：pi-adapter/contract 测试、macOS live 用量验证（Windows 后续补）。
6. **P5 可选收尾**：Auto Debug 双份实现合并评估；术语/命令参考/架构图定稿（CONTEXT.md、ADR 视需要）。

本次迭代：每片仅在当前 macOS Tahoe 26.x arm64 主机通过即视为本片完成；**不声称跨平台**。Windows 11 适配与验证整体推迟到 Windows 主机上再做，届时补齐（尤其 P4 用量契约与 Desktop 之外的其他平台差异）。

## 11. 安全与兼容性（不变式，非协商）

- 审批不变：goal 自动续跑不获得任何“自动通过”审批；外部/网络动作仍需既有审批。
- 凭据不变：不进入会话/提示词/日志/工具参数/子进程环境；目标文本先脱敏再注入。
- 提交不变：模型提交仍只经 `candy_git_commit`（凭据扫描）；push 仍需 `/push allow`；绝不静默 push/PR/release。
- 写操作串行、读并行、同仓库多写任务用独立 worktree 等既有并发规则不变。
- 旧任务不受影响：goal 只对新建/显式升级的任务生效；schema 变更 additive。
- 未启用平台能力（如 Full Access Backend）时，goal 仍可用但受相应命令策略约束，不静默降级到无沙箱。
- 桌面（Electron）客户端不在本切片范围内；不得为 WebUI/TUI 引入依赖桌面渲染器的路径。

## 12. 明确不做（V1 边界）

- Candy 退出后继续执行（无 detached/后台驻留）。
- 多 agent 编排 / 自动把 goal 拆成子任务并行。
- 云端执行、自动建 PR、自动发布/部署。
- 无完成判据的模糊请求自动建 goal（需用户明确或完成判据可校验时才建）。
- 用 goal 替代/绕过既有审批与 validator（validator 可与 goal 共存：模型自审计 + 可选外部校验器）。
- 桌面（Electron）客户端 goal 能力。

## 13. 风险与开放问题

1. **共享 policy 与双客户端接线**：TUI 与 app-server 回合循环形状不同（Auto Debug 预算 6 vs 3），共享 policy 需要定义稳定的调用契约，避免再复制一次。
2. **“空闲”判定**：排队用户输入、待审批、活动回合的事件顺序需精确定义，避免与用户回合竞争（TUI 与 WebUI 语义一致）。
3. **token 口径**：P4 才处理；先明确“回合数+墙钟”的 MVP 即可，不阻塞 P0–P3。
4. **模型自审计可靠性**：complete/blocked 依赖模型诚实与审计提示；无进展计数与可选外部 validator 作为兜底；预留“强校验器作为完成证据”的可选耦合。
5. **无进展护栏误伤**：Candy 无回合内等待后台任务工具，连续无进展可能误判合法轮询；默认只计数/提示，不自动 pause。
6. **长目标上下文增长**：多回合自动触发既有 compaction（`turn.compaction`），需验证 compaction 与 goal 状态/续跑互不破坏。
7. **平台节奏**：本次只做 macOS；Windows 11 适配推迟到周末在 Windows 主机上验证，属有意延迟，不影响当前片。
8. **命名与术语**：Goal Task / goal 状态名是否进入 CONTEXT.md 与 ADR；`/goal` 与 `/debug`/`/plan` 的展示关系。
9. **续跑频率与成本**：空转回合消耗 token；保守默认（K、预算默认）先保守，后续用真实任务校准。

## 14. 待办（本草案之后）

- [ ] 与产品 owner 确认 §1 目标、§10 界面优先级（TUI→WebUI→不含桌面）、平台节奏（先 macOS，Windows 周末补）与 §13 开放问题（尤其 1/3/5/8）。
- [ ] 定稿后：登记 issue（若需）、写 ADR（若产生新术语/不变式）、更新命令参考与架构图。
- [ ] 由 P0 切片开始实现，每片跑 `npm run check` 与对应 smoke 后再提交。
