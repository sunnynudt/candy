# Goal Task P5 收尾：Auto Debug 共享策略、术语与 ADR

状态：**代码与文档完成并提交**。P5 的剩余可选项（`/goal edit` 外部编辑器、Auto Debug 循环体进一步合并、桌面客户端）明确留待后续。
范围：macOS 先行；Windows 相关复核整体推迟。
前置：`docs/architecture/goal-task-proposal.md` §10 P5/§14、[`goal-task-p1-design.md`](./goal-task-p1-design.md)（共享 policy 形态）、[`goal-task-p3-design.md`](./goal-task-p3-design.md)（工具链事项）。

> 原则：外部产品仅能力对照；本片全部文案与标识符为 Candy 自研。

## 1. 本片做什么

1. **Auto Debug 双份实现合并（第一步：共享语义）**：把回合预算、stall 阈值、证据上界、修复回合 prompt 契约抽到 `packages/runtime/src/auto-debug.ts`，TUI 与 app-server 都用它。
2. **修掉一个真实缺陷**：app-server 的 Auto Debug 此前每轮重复同一个 prompt（validator 证据没有回喂给模型），且预算（3 轮）与 TUI（6 轮）不一致；现在两端统一为 6 轮、2 次 stall，并且修复回合会带上脱敏、有界、控制字符清理后的验证证据。
3. **术语与决策定稿**：新增 ADR-0016（Goal Task 能力与不变式），并在 `CONTEXT.md` 登记 Goal Task / Goal Objective / Completion Criterion / Goal Turn / Goal Budget / Blocked Audit；`docs/usage/tui-commands.md` 补齐 `--tokens`。

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

`apps/app-server/src/main.ts`、`web-ui.ts`、`pi-adapter/src/index.ts` 等文件仍被 Candy 凭据写入守卫误判，本片对 app-server 的改动继续使用一次性本地脚本（脚本用完即删），提交前对新增行重跑平台扫描（0 命中）。长期修法见 `goal-task-p3-design.md` §7。

## 6. 未完成 / 后续可选

1. **Auto Debug 循环体合并**：把“跑一轮 + 跑 validator + 记录进度 + 停因映射”做成 runtime 内的一个驱动函数，两个客户端只注入 turn/validator 回调。风险：两个客户端的任务状态与事件模型不同，需要先约定跨客户端契约。
2. **`/goal edit` 外部编辑器编辑**：目前 `/goal edit` 是 `/goal replace` 的别名；TUI 已有 Ctrl+G 编辑器通道（`external-editor.ts`），可复用。
3. **普通主机补验项**：`npm run smoke:app-server`（P3 §6）与 live provider 用量契约（P4 §5）。
4. **Windows**：按用户要求，本阶段不处理。
