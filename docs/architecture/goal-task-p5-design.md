# Goal Task P5 收尾：Auto Debug 共享策略、术语与 ADR

状态：**代码与文档完成并提交**。P5 的剩余可选项（`/goal edit` 外部编辑器、Auto Debug 循环体进一步合并、桌面客户端）明确留待后续。
范围：macOS 先行；Windows 相关复核整体推迟。
前置：`docs/architecture/goal-task-proposal.md` §10 P5/§14、[`goal-task-p1-design.md`](./goal-task-p1-design.md)（共享 policy 形态）、[`goal-task-p3-design.md`](./goal-task-p3-design.md)（工具链事项）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. 本片做什么

1. **Auto Debug 双份实现合并（第一步：共享语义）**：把回合预算、stall 阈值、证据上界、修复回合 prompt 契约抽到 `packages/runtime/src/auto-debug.ts`，TUI 与 app-server 都用它。
2. **修掉一个真实缺陷**：app-server 的 Auto Debug 此前每轮重复同一个 prompt（validator 证据没有回喂给模型），且预算（3 轮）与 TUI（6 轮）不一致；现在两端统一为 6 轮、2 次 stall，并且修复回合会带上脱敏、有界、控制字符清理后的验证证据。
3. **术语与决策定稿**：新增 ADR-0016（Goal Task 能力与不变式），并在 `CONTEXT.md` 登记 Goal Task / Goal Objective / Completion Criterion / Goal Turn / Goal Budget / Blocked Audit；`docs/usage/tui-commands.md` 补齐 `--tokens`。
4. **stdio 冒烟在进程内可用**：新增 `apps/app-server/src/stdio-smoke.test.ts`，用 `PassThrough` 在进程内跑与 `npm run smoke:app-server` 相同的 JSONL 命令与断言（不再依赖 spawn 子进程）；顺带修复非法 JSONL 行会把 stdio 循环变成未处理拒绝的问题（现在回协议错误信封），`runAppServer` 增加可选的 controller 选项以支持隔离测试。

## 2. 设计决策

1. **共享层只承载“语义”，不强求共用循环体**：两个客户端的回合循环形状不同（TUI 直接驱动 engine；app-server 还要处理队列、审批与协议事件），强行合并会引入第三种抽象；本片先把**会漂移的常量与 prompt 契约**收敛到 runtime，循环体合并作为后续可选。
2. **修复回合 prompt 契约**：`buildAutoDebugRoundPrompt({ goal, round, maxRounds, evidence })` —— 第 1 轮只给目标；后续轮在目标后追加 `[VERIFIER FAILED] round N of M; bounded evidence:` 与证据，并明确“修根因、不要改无关文件”。
3. **证据在处理入口就脱敏、清理、限长**：`boundAutoDebugEvidence` 用活动密钥与凭据形态脱敏、把控制字符（除 `\t`/`\n`）替换为空格、按 `MAX_AUTO_DEBUG_EVIDENCE_CHARS`(4096) 截断并标注；空证据给固定占位文本，避免把“空”渲染成可疑提示。
4. **steering 仍优先**：修复回合在存在排队 steering 时，先注入 steering 文本（用户优先），否则用共享的修复 prompt。
5. **预算统一后仍是“每轮检查”**：第 N 轮结束后才结算，因此最后一次可能超出边界（与 goal 预算同一约定）。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/runtime/src/auto-debug.ts`（新增）、`auto-debug.test.ts`（新增） | 常量、banner、修复 prompt 与证据处理 |
| `packages/runtime/src/index.ts` | re-export |
| `apps/tui/src/main.ts` | 使用共享常量/banner/prompt（删除本地副本） |
| `apps/app-server/src/main.ts` | 使用共享预算与修复 prompt；validator 证据回喂（脚本化补丁，见 §5） |
| `apps/app-server/src/main.test.ts` | 修复回合断言更新（steering 后一轮带证据） |
| `docs/adr/0016-goal-task-capability.md`（新增） | Goal Task 能力、状态机、预算与 token 口径、审计语义、安全不变式 |
| `CONTEXT.md` | 6 个新术语与“避免”列表 |
| `docs/usage/tui-commands.md` | `/goal` 表的 `--tokens` |

## 4. 测试矩阵（P5 门禁）

- runtime：`auto-debug.test.ts` 3 例（常量/banner、第 1 轮与修复轮 prompt、证据脱敏+清理+截断+空证据）。
- app-server：既有 35 例回归（其中“approval/steering/证据投影”用例更新为断言修复轮带证据）。
- TUI：既有 62 例回归（唯一失败是既有的嵌套沙箱 npm 脚本环境用例）。
- 定向合并跑：app-server 35 + TUI main + runtime auto-debug 共 114 例，113 通过 1 环境失败。

## 5. 工具链事项

P5 收尾同时解除了主要“因守卫误判而不可写”的文件（`pi-adapter/src/index.ts`、`app-server/src/{main,web-ui}.ts`、`web-ui.test.ts`、`protocol.test.ts`），现可用 Candy 自己的 `candy_write`/`candy_edit` 直接修改；仍未解除的文件清单与处理约定见 `goal-task-p3-design.md` §7。本片其余改动（如 adapter 测试文件的 `turn.usage` 期望更新）仍在任务边界内用一次性本地脚本完成，脚本用完即删，并在提交前对新增行重跑平台扫描（0 命中）。

## 6. 未完成 / 后续可选

1. **Auto Debug 循环体合并**：把“跑一轮 + 跑 validator + 记录进度 + 停因映射”做成 runtime 内的一个驱动函数，两个客户端只注入 turn/validator 回调。风险：两个客户端的任务状态与事件模型不同，需要先约定跨客户端契约。
2. **`/goal edit` 外部编辑器编辑（已尝试，暂缓）**：曾实现 surface 的 `editText()` + `goal-edit.ts`（格式/解析）+ `/goal edit` 无参走编辑器。编辑结果能成功写回目标（测试中 store 已更新），但 **pi-tui 的渲染循环在命令分发过程中被 stop/start 后，测试终端不再接收后续输入**（`:quit` 不生效、TUI 无法退出）；`setImmediate` 让出调用栈与 `#resume()` 里重新 `setFocus(editor)` 都未解决。本片已回滚该路径，`/goal edit` 仍然等价于 `/goal replace`（命令行文本），仅保留 `#resume()` 的重设焦点作为防御性修正。复现方式：`/goal <objective>` 后执行 `/goal edit`，用 `launchExternalEditor` 测试探针写回内容，观察 `:quit` 不再生效。建议的下一步：把目标编辑做成“预填输入行 + Ctrl+G”（复用已验证的输入行编辑器通道），或先与 pi-tui 确认 stop/start 后的事件与焦点恢复契约。
3. **普通主机补验项**：live provider 用量契约（P4 §5）；spawn 版 `npm run smoke:app-server`（进程内等价断言已在 `apps/app-server/src/stdio-smoke.test.ts` 覆盖，见 P3 §6）。
4. **协议层开放问题**：非法 JSONL 行目前结束该 stdio 循环（回错误信封后干净关闭）；是否改为“跳过该行继续服务”需在 protocol 层决定。
5. **Windows**：按用户要求，本阶段不处理。
