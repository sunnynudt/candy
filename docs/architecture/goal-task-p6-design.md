# Goal Task P6：P5 遗留三项收尾

状态：**进行中**——④（stdio 非法行策略）与①（`/goal edit` 预填命令行通道）已完成并验证；②（Auto Debug 循环体合并）待做。
范围：macOS 先行；Windows 相关复核整体推迟。
前置：`docs/architecture/goal-task-p5-design.md` §6（三项遗留）、[`goal-task-p3-design.md`](./goal-task-p3-design.md) §6/§7（stdio 冒烟与工具链守卫）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. ④ stdio 非法 JSONL 行：跳过 + 有界连败终止

### 1.1 决策

P5 留下的开放问题是“畸形行之后继续服务（跳过）还是终止”。结论是**两者都要，按层级分工**：

| 层级 | 行为 |
|---|---|
| 协议解码器（`packages/protocol/src/index.ts`） | 默认仍是 **fail closed**（抛出，调用者可见）；调用方可用 `onInvalidLine` 显式选择 `skip`。**完整行**（以 `\n` 结束）的解码失败都会被回调：JSON 语法错、消息形状/版本非法、行超长。**未结束**的 pending 帧超过 `MAX_JSONL_BYTES` 仍直接抛错，不经过回调。 |
| app-server stdio 循环（`apps/app-server/src/main.ts`） | 对每个畸形行回一条 `{"v":1,"kind":"error","code":"invalid_message"}` 并继续服务；**连续** `MAX_CONSECUTIVE_INVALID_LINES`（8）行畸形才停止服务并收尾（`controller.close()`）。任何一条成功解码的消息都会把连败计数清零。 |

### 1.2 理由

1. **一行坏输入不该带走整个进程**：app-server 是桌面端 app-managed 子进程，同时持有该客户端的所有任务。单条畸形行（客户端 bug、半个写入、粘贴污染）若终止循环，等价于把“协议小错”放大成“所有任务一起停”。
2. **但也不能无限服务**：畸形行意味着对端没有在说协议。持续跳过等于对一个已经坏掉的对端永久供能，并且每行输入换一行错误信封输出。因此用一个有界的**连续**计数兜底：偶发噪声可容忍，稳定坏掉就 fail closed（进程由宿主重启，任务可经 `recoverActiveTasks` 恢复）。
3. **连续而不是累计**：累计预算会让“长时间运行 + 偶发畸形行”最终崩溃；连续预算只惩罚持续失同步的对端。
4. **未结束的超长帧保持致命**：只有收到 `\n` 才能重新对齐；一个永不结束的超长帧无法判断下一条合法消息从哪里开始，跳过等于把整条流都吃掉。这一条既保护内存也保护帧边界。
5. **无输出放大**：每个畸形行最多换一条错误信封，错误响应与输入行数同阶；预算之外的输入不再产生任何输出。
6. **默认行为不变**：`decodeJsonLines` 的默认策略仍是抛出。只读消费方（桌面端读取子进程 stdout）行为不变，本片不触碰桌面端。

### 1.3 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/protocol/src/index.ts` | 新增 `InvalidLinePolicy`、`JsonLineDecodeOptions`、`decodeJsonLines(chunks, options)`；完整行解码失败经回调，未结束超长帧仍抛 |
| `packages/protocol/src/protocol.test.ts` | 新增 3 例：可跳过并保持对齐（含超长完整行 + 未结束尾行）、默认/显式 `stop` 语义、未结束超长帧即使声明 `skip` 仍致命且不回调 |
| `apps/app-server/src/main.ts` | `MAX_CONSECUTIVE_INVALID_LINES = 8`；循环改用 `onInvalidLine`，回错误信封并继续，连败到顶才停 |
| `apps/app-server/src/stdio-smoke.test.ts` | 新增 2 例：畸形行之后的命令仍被服务；连续 8 行畸形后不再有输出（错误信封恰好 8 条） |

### 1.4 验证

- `npm run build`、`npm run lint`、`npm run format:check` 通过。
- 定向 `node --test packages/protocol/dist/protocol.test.js apps/app-server/dist/stdio-smoke.test.js` → 29/29 通过。
- 全量 `npm test`：除 6 个**既有**嵌套沙箱环境失败外全绿。

### 1.5 未做（有意）

- 桌面端 `apps/desktop/src/main.ts` 仍用默认策略（读取子进程 stdout 时畸形行终止读取）。桌面端属 V2 范围，本片不改。
- `controller.dispatch` 抛错时仍统一回 `invalid_message` 信封（未回具体 `code`），且不计入连败预算——那属于“合法帧、非法命令”，每行输入仍只换一条输出。

## 2. ① `/goal edit`：预填可编辑命令行 + Ctrl+G

### 2.1 决策

`/goal edit`（无参）不再自己打开编辑器，也不在命令分发过程中停/启 pi-tui 的渲染循环，而是：

1. 把当前目标写成一条**完整可编辑的命令行**预填到输入行：`/goal replace <objective> [--criterion <text>] [--turns <n>] [--tokens <n>] [--minutes <n>]`；
2. 把该行的“改完按 Enter 重新开启目标 · Ctrl+G 外部编辑”提示写进 transcript；
3. 用户直接改行文，或按 Ctrl+G 把整条命令交给 `$EDITOR`（这条通道 P5 已验证可重复使用，编辑结果写回输入行），再按 Enter 提交；
4. 提交后走的是**已有的 `/goal replace` 路径**（同一校验、同一 goal 状态机、同一 steering/续跑分支），没有新的写回路径。

`/goal edit <objective>` 保持原有的 replace 等价行为不变（只对无参形式启用预填）。

### 2.2 理由

1. **不复用出问题的那段机制**：P5 的失败根因是命令分发中 stop/start 渲染循环；预填输入行只调用已存在的 `editor.setText()`，不碰渲染循环生命周期。
2. **预填是“用户可见且可改”的**：目标不会因为输入 `/goal edit` 就被隐式改写；改动必须由用户显式提交。
3. **必须带上预算**：`setGoal` 对省略的预算写 `null`（“无预算”），所以预填必须回填当前回合/token/墙钟预算，否则一次“只想改目标文字”的编辑会静默清掉预算。
4. **回填不了的要报出来**：`/goal` 只接受 `--minutes`（整分钟），且目标/判据里出现 `--turns`/`--minutes`/`--tokens` 这类 token 会在提交时被当选项重读；这两种情况在预填时给 warning，而不是静默地改掉语义。（非整分钟的墙钟预算目前只能由 app-server/WebUI 写入，TUI 写不出来。）
5. **不改状态栏/无模式**：没有引入“编辑模式”这类新状态，因此不会与排队输入、steering、自动续跑交错。

### 2.3 涉及文件

| 文件 | 变更 |
|---|---|
| `apps/tui/src/pi-tui-surface.ts` | 新增 `prefillInput(value)`：`editor.setText(value)` + `requestRender` |
| `apps/tui/src/main.ts` | `buildGoalEditCommand()`（目标/判据/预算回填）、`goalEditWarnings()`（flag 冲突与非整分钟墙钟）、`editGoal()`；`/goal edit` 无参走预填，带参仍为 replace |
| `apps/tui/src/goal-task.test.ts` | 新增 2 例：预填内容含目标/判据/`--turns`，提交后 store 目标被替换且预算保留；带 `--turns` 的客观目标 + 90000ms 墙钟预算给出两条 warning，且提交被 `/goal` 拒绝（证明 warning 对应真问题） |
| `docs/usage/tui-commands.md`、`goal-task-p2-design.md`、`goal-task-proposal.md`、`goal-task-p5-design.md` | 命令表与历史记录同步 |

### 2.4 验证

- `npm run build`、`npm run lint`、`npm run format:check` 通过。
- 定向 `node --test apps/tui/dist/goal-task.test.js` → 10/10；`main.test.js + pi-tui-surface.test.js + plan-build.test.js` → 112 例中仅 1 例既有沙箱环境失败。
- 全量 `npm test`：除 6 个**既有**嵌套沙箱环境失败外全绿。

### 2.5 未做（有意）

- 预填不包含“重新确认”交互：`/goal replace` 本身没有二次确认，改变的是“先看到完整命令行再提交”。
- 仍未允许 objective/criterion 里的 flag-like token 往返：那是 `/goal` 命令语法本身的限制，不在本项范围。

## 3. ② Auto Debug 循环体合并

待实现。P5 已把会漂移的常量与 prompt 契约收敛到 `packages/runtime/src/auto-debug.ts`；本项要把“跑一轮 + 跑 validator + 记录进度 + 停因映射”也收敛为一个 driver。
