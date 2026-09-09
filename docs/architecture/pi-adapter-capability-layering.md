# 能力分层与 Pi 能力缺口决策

状态：参考文档（reference）—— 说明 Candy V1 既有架构，不是新的产品决策。
关联：`docs/architecture/candy-v1.md`、`docs/architecture/goal-task-proposal.md`、根目录 `AGENTS.md`。

## 1. 结论

Candy 的能力**不全部来自 Pi**。Pi 只是引擎底座；Candy 的产品能力在 Candy 自己的控制平面实现。当某个能力 Pi 不支持时，先判断它属于哪一层，再决定在哪里补齐：

- 缺**产品能力**（任务、goal、审批、预算、恢复、工作树、browser、UI…）→ 在 Candy 控制平面实现，**不要问 Pi**。
- 缺**引擎原语**（观测、取消、steering、usage…）→ 先看 Pi 是否已暴露；没有则在 **Pi Adapter 窄层**透传/包装；仍不可行才升级为 **Pi 兼容性升级门**。
- 缺 **provider 能力**（模型目录、端点、认证、限流、多模态声明…）→ 在 Candy Provider Module 实现，**永不静默 fallback**。

## 2. 三层归属

```text
┌─────────────────────────────────────────────┐
│ 产品/控制平面（Candy 自己，TypeScript）          │
│ tasks、goal、审批、工作树、凭据隔离、预算、       │
│ 恢复、调度、browser、TUI/WebUI、技能、协议       │
├─────────────────────────────────────────────┤
│ Provider 层（Candy 自己的 Provider Module）     │
│ 模型目录、no-fallback、国内端点、自定义模型       │
├─────────────────────────────────────────────┤
│ 引擎层（Pi，通过窄 Pi Adapter 访问）             │
│ turn + tools + model streaming + session      │
└─────────────────────────────────────────────┘
```

- **引擎层**：Pi 只负责“按一轮输入跑一个 turn”，Candy 通过 `packages/pi-adapter` 这个唯一允许 import Pi 包的模块访问它。
- **Provider 层**：Candy 的 Provider Module 隐藏模型目录、端点、认证、流式、限流、附件编码；`ModelRequest` 只含模型选择与附件 id，不含凭据。
- **控制平面**：任务/审批/持久化/策略/UI 全是 Candy 自己的，与 Pi 无关，只需要引擎层的 turn seam。

## 3. 引擎层的最小原语（Candy 对 Pi 的真实依赖）

| 原语 | 状态 |
|---|---|
| 跑一个 turn（`AgentEngine.runTurn`） | 具备 |
| 观测流（turn/tool/compaction/retrying/settled 等） | 具备 |
| 会话续用/恢复（`RecoverableAgentEngine.recoverPrompt`） | 具备 |
| 取消（AbortSignal） | 具备 |
| 回合内 steering（`PiAgentEngine.steer` → session.steer） | 具备 |
| token 用量透传 | 不具备（当前观测流无 usage） |

结论：只要 Pi 能满足“跑 turn + 观测 + 会话 + 取消 + steering”，Candy 就能在它之上构建任意产品能力。token 预算这类依赖缺失原语的能力，需要先补窄层透传（见 §4 ②）。

## 4. 能力缺口决策阶梯

### ① 缺的是产品能力 → 在 Candy 做

Pi 不需要“支持 goal、审批、预算、工作树”。Candy 用状态机、回合结算钩子、注入提示词、工具宿主，把多个 Pi turn 组合成更高层行为。已有实例：

- Auto Debug：`LongRunningTaskRunner` + TUI/app-server 的 `runTask`，在 Pi 之上把“模型回合 + validator + 证据回填 + 循环”组合成长循环。
- plan → build 两段式：Candy 自己的策略与注入指令。
- 审批/凭据隔离/commit 扫描/push 授权：Pi 的 agent harness 不内置权限系统，这套全部由 Candy 提供。
- 模型目录、no-fallback、MiniMax 国内端点、自定义模型（`models.json` + `CustomPiAgentEngine`）。

### ② 缺的是引擎原语 → 先看 Pi 是否已暴露

1. 已暴露 → 直接用（如 `turn.settled`、`steer`）。
2. 未暴露但可在 **Pi Adapter 窄层**补 → 在 adapter 里透传/包装，**不 fork Pi、不重写 agent loop**。例：给观测流加 usage 透传属于 adapter 契约变更，而不是改 Pi 的 agent loop。
3. 缺了且**必须修改 Pi 本身**才能满足 → 升级为 **Pi 兼容性升级门**（见 `AGENTS.md`：Pi 全家升级作为一次兼容性变更，重跑 macOS + Windows 的 Pi Adapter 矩阵）。这是最后手段，V1 应尽量避免。

### ③ 缺的是 provider 能力 → Candy Provider Module

模型能力声明、端点、认证、限流、错误映射都在 Candy；Pi 的 provider 只是底层通道。任何 provider 失败都显式暴露，永不跨 provider 静默 fallback。

## 5. 对 Goal Task 的映射

| goal 能力 | 归属 | 对 Pi 的要求 |
|---|---|---|
| goal 状态机、持久化、CAS | Candy（platform/runtime） | 无 |
| 空闲续跑循环、预算、无进展护栏 | Candy（runtime policy） | 只需 turn 结束观测 |
| 目标注入、审计提示词、goal 工具集 | Candy | 工具走 Candy Tool Host |
| 目标编辑 steering | Candy | `steer`（已有） |
| token 预算 | Candy | 需 usage 透传（后续切片 + 兼容性 spike） |

## 6. 边界（不可协商）

- 不 fork Pi、不重写 Pi 的 agent loop。
- Pi 类型、会话路径、provider 载荷不越过 Pi Adapter 边界进入客户端或其它包。
- 产品与 provider 逻辑只存在于 Candy 控制平面；Pi 升级必须作为兼容性变更整体进行。
- 本文与 `AGENTS.md`、`docs/architecture/candy-v1.md` 冲突时，以这两者为准。
