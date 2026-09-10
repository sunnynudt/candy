# Goal Task P0 实现设计：数据模型与 goal 状态机

状态：**已确认，P0 已实现并提交**（`task_metadata` schema 17→18 + `goal.ts` 状态机 + 存储 API + 测试）。P1（续跑 policy/工具集）起待续。
范围：Candy V1，macOS 先行；本次仅实现 **P0：持久化 schema 迁移 + goal 状态机 + 存储 API**，不引入回合续跑循环、不接 UI/协议。
前置：`packages/platform/src/index.ts`（`SQLiteTaskStore`、`TaskMetadata`）、`packages/platform/src/credential-guard.ts`。

> 原则：外部产品仅能力对照，不复制其代码/提示词/路径/标识符；本设计全部使用 Candy 自有术语。

## 1. P0 范围与不做什么

**做**
- `task_metadata` 增列 + 新增 `task_goal_runs` 表（`user_version` 17 → 18）。
- 新增 goal 类型、纯状态机（transition 校验）、goal 存储 API（CRUD/CAS/记账）。
- `taskMode` 联合类型扩为 `'build' | 'debug' | 'goal'`（只放宽类型与校验，行为仍待 P2）。
- 单元测试与 schema 迁移测试。

**不做（留到后续）**
- 回合续跑触发、goal 工具集、注入提示词（P1）。
- TUI `/goal` 命令、WebUI/protocol 事件（P2/P3）。
- token 用量记账与 token 预算（P4，依赖 Pi Adapter usage 透传）。
- 桌面（Electron）客户端。

## 2. 设计决策

1. **goal 状态机与校验放 `packages/platform`**（新增 `src/goal.ts`，从 `index.ts` re-export）。理由：`runtime` 已依赖 `platform`，而 `platform` 不能反向依赖 `runtime`；状态机同时被存储层（防写入非法状态）与后续 runtime policy 复用。
2. **goal 聚合字段放 `task_metadata`，最新进度放独立表 `task_goal_runs`**。不复用 `task_runs`，避免与 Auto Debug 的 `stop_reason` 语义混用。
3. **“无 goal”用 `goal_id IS NULL` + `goal_status = 'none'` 表达**；`TaskMetadata.goal` 为 `undefined`。
4. **预算字段现在就建**（token 预留），P0 只计算回合数 + 墙钟；token 字段为 `0/null` 直到 P4。
5. **所有 goal 变更走 revision CAS**（与 `updateModel` 等一致），关键变更额外带 `expectedGoalId` 防止目标已替换的竞态。

## 3. 涉及文件

| 文件 | 变更 |
|---|---|
| `packages/platform/src/goal.ts`（新增） | 类型 + 状态机 + 校验常量/函数 |
| `packages/platform/src/index.ts` | schema 迁移、`create()` taskMode、`mapTaskMetadata`、goal 存储方法、re-export |
| `packages/platform/src/platform.test.ts` | 迁移 + 状态机 + 存储测试 |
| `packages/runtime/src/index.ts`（可选） | re-export goal 状态机类型供后续 policy 使用（不改行为） |

## 4. Schema 迁移（`user_version` 17 → 18）

### 4.1 `task_metadata` 增列（additive，全可空或带默认）

```sql
ALTER TABLE task_metadata ADD COLUMN goal_id TEXT;
ALTER TABLE task_metadata ADD COLUMN goal_objective TEXT;
ALTER TABLE task_metadata ADD COLUMN goal_criterion TEXT;
ALTER TABLE task_metadata ADD COLUMN goal_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE task_metadata ADD COLUMN goal_token_budget INTEGER;      -- P4 使用
ALTER TABLE task_metadata ADD COLUMN goal_turn_budget INTEGER;
ALTER TABLE task_metadata ADD COLUMN goal_wall_clock_budget_ms INTEGER;
ALTER TABLE task_metadata ADD COLUMN goal_tokens_used INTEGER NOT NULL DEFAULT 0; -- P4 使用
ALTER TABLE task_metadata ADD COLUMN goal_turns_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_metadata ADD COLUMN goal_wall_clock_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_metadata ADD COLUMN goal_terminal_reason TEXT;
ALTER TABLE task_metadata ADD COLUMN goal_continuation_deferred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_metadata ADD COLUMN goal_consecutive_no_progress INTEGER NOT NULL DEFAULT 0;
```

约束全部在代码层校验（与现有 `task_mode`/`title` 一致，不用 DB CHECK）。

### 4.2 新增 `task_goal_runs`

```sql
CREATE TABLE IF NOT EXISTS task_goal_runs (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES task_metadata(task_id) ON DELETE CASCADE,
  rounds INTEGER NOT NULL,
  turns_used INTEGER NOT NULL,
  wall_clock_ms INTEGER NOT NULL,
  completed INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  last_fingerprint_hash TEXT,
  evidence_summary TEXT
);
```

### 4.3 迁移分支处理（对齐现有 `SQLiteTaskStore` 构造器）

- `schemaVersion === 0`（全新库）：在 `CREATE TABLE task_metadata` 中直接包含上述 goal 列，并 `CREATE TABLE task_goal_runs`；最终版本仍由构造器尾部统一置 18。
- 旧库（1..17）：在现有 additive 块之后新增一个“goal 列缺失则 ALTER + 建表”块（对 `0` 与 `18` 跳过）。
- 支持版本守卫：允许集合加入 `18`（继续跳过 14）。
- 构造器尾部 `PRAGMA user_version = 17` 改为 `18`。

## 5. 类型（`packages/platform/src/goal.ts`）

```ts
export const GOAL_STATUSES = [
  "active", "paused", "blocked", "budget_limited", "usage_limited", "complete",
] as const;
export type CandyGoalStatus = (typeof GOAL_STATUSES)[number];

export interface TaskGoalBudgets {
  readonly turnBudget?: number;          // >= 1
  readonly wallClockBudgetMs?: number;   // >= 1
  readonly tokenBudget?: number;         // P4 使用，>= 1
}

export interface TaskGoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: CandyGoalStatus;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly tokenBudget: number | null;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  readonly tokensUsed: number;
  readonly terminalReason?: string;
  readonly continuationDeferred: boolean;
  readonly consecutiveNoProgress: number;
}
```

`TaskMetadata` 增字段：`readonly goal?: TaskGoalSnapshot;`（无 goal 时 `undefined`）。

`TaskMetadata.taskMode` 类型改为 `"build" | "debug" | "goal"`；`create()` 的 taskMode 参数同步放宽并校验。

## 6. goal 状态机（`goal.ts`）

### 6.1 事件

```ts
export type GoalTransitionEvent =
  | { readonly type: "set"; readonly replace?: boolean }   // 创建/替换
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "block"; readonly reason?: string }
  | { readonly type: "complete"; readonly reason?: string }
  | { readonly type: "budget_limit"; readonly reason?: string }
  | { readonly type: "usage_limit"; readonly reason?: string }
  | { readonly type: "clear" };
```

### 6.2 转移表（`assertGoalTransition(current, event)`，非法即抛 `GoalStateError`）

| 当前 | 事件 | 结果 | 说明 |
|---|---|---|---|
| 无 goal | `set` | active | 新建 |
| complete | `set`（无 replace） | active | 终态后默认允许开启新 goal |
| 其它非终态 | `set`（无 replace） | 拒绝 | “goal already exists”；`replace:true` 时重置为新 active |
| active | `pause` | paused | |
| active | `block` | blocked | 带 reason |
| active | `complete` | complete | 带 reason |
| active | `budget_limit` | budget_limited | 带 reason |
| active | `usage_limit` | usage_limited | 带 reason |
| paused | `resume` | active | blocked audit 重置（见 §6.3） |
| blocked | `resume` | active | blocked audit 重置 |
| paused/blocked/active | `clear` | 无 goal | |
| 其它组合 | — | 拒绝 | 见 §6.4 |

### 6.3 resume 语义

- 只允许 `paused`/`blocked` → `active`。
- `budget_limited`/`usage_limited` 在 P0 **不**允许直接 resume；需 `clear` 后 `set` 新目标（或后续版本定义显式 resume）。
- resume 后清空 `consecutiveNoProgress`；模型侧 blocked 审计计数按“重新开始”处理（该语义属 P1 提示词，P0 只保证字段可重置）。

### 6.4 拒绝规则

- 终态（complete）之上除 `set`/`clear` 外不可再转移。
- `budget_limited`/`usage_limited` 不可 `pause/resume/block/complete`（先 clear/set 或后续扩展）。
- `clear` 在存在 goal 时允许（任意状态）。

## 7. 存储 API（`SQLiteTaskStore` 新增方法）

全部返回 `TaskMetadata`（内部 `require(taskId)`），revision CAS 与 `expectedGoalId` 语义与现有 `transition/updateModel` 一致。

```ts
getGoal(taskId: string): TaskGoalSnapshot | undefined;

setGoal(
  taskId: string,
  expectedRevision: number,
  input: {
    objective: string;
    completionCriterion?: string;
    turnBudget?: number;
    wallClockBudgetMs?: number;
    tokenBudget?: number;   // P4 前拒收
    replace?: boolean;
  },
): TaskMetadata;

updateGoalStatus(
  taskId: string,
  expectedRevision: number,
  status: CandyGoalStatus,
  options?: { expectedGoalId?: string; reason?: string },
): TaskMetadata;

updateGoalBudgets(
  taskId: string,
  expectedRevision: number,
  budgets: TaskGoalBudgets,
  options?: { expectedGoalId?: string },
): TaskMetadata;

accountGoalUsage(
  taskId: string,
  expectedRevision: number,
  expectedGoalId: string,
  usage: { turnDelta: number; wallClockDeltaMs: number; tokenDelta?: number },
): TaskMetadata;

setGoalContinuationDeferred(
  taskId: string,
  expectedRevision: number,
  expectedGoalId: string,
  deferred: boolean,
): TaskMetadata;

clearGoal(
  taskId: string,
  expectedRevision: number,
  options?: { expectedGoalId?: string },
): TaskMetadata;

recordGoalRun(progress: TaskGoalRunMetadata): void;
```

### 7.1 行为要点

- `setGoal`：校验后写入新 goal（`goal_id = randomUUID()`、`status='active'`、计数器 0、`goal_terminal_reason=NULL`、`goal_continuation_deferred=0`、`goal_consecutive_no_progress=0`），`revision+1`；已有非终态 goal 且无 `replace` 抛 `GoalStateError`。
- `updateGoalStatus`：先 `assertGoalTransition`；写 status + reason（terminal 状态写 `goal_terminal_reason`）；转 active 时清 `goal_continuation_deferred` 与 `goal_consecutive_no_progress`。
- `updateGoalBudgets`：写预算；若当前 active 且 `turns_used >= turnBudget` 或 `wallClockMs >= wallClockBudgetMs`，同语句内转 `budget_limited` 并写 reason（单条 UPDATE 保证原子）。
- `accountGoalUsage`：`turnDelta/wallClockDeltaMs >= 0`；更新 `goal_turns_used += turnDelta`、`goal_wall_clock_ms += wallClockDeltaMs`；active 且超预算 → 转 `budget_limited` + reason。`tokenDelta` P4 前拒收。
- `clearGoal`：goal 各列置回默认/`NULL`，`revision+1`。
- 所有变更同时 `updated_at = now`。

### 7.2 无进展计数（P1 用，P0 只提供读写）

- `goal_consecutive_no_progress` 由 P1 policy 在每回合结算时通过 `updateGoalStatus`/专用小方法更新；P0 只确保字段存在、可重置、CAS 保护。

## 8. 校验规则（`goal.ts`）

- `objective`：trim 后非空；长度 ≤ `MAX_GOAL_TEXT_CHARS = 4096`（与 `MAX_TUI_TURN_MESSAGE_CHARS` 对齐，新建常量在 goal.ts）；拒绝 `\0`/控制字符；拒绝 credential-shaped 内容（复用 `credential-guard.ts` 的 `containsCredentialMaterial`，与 title/prompt 同一守卫）。
- `completionCriterion`：同 objective 守卫，可空。
- 预算：`Number.isSafeInteger` 且 ≥ 1；`tokenBudget` P4 前抛“token budget not yet supported”。
- `goalId`：`uuid` 形（生成侧保证，读取侧只做存在性校验）。

## 9. 预算记账契约（P0 只定义，不驱动）

- 回合数：每续跑回合 `turnDelta=1`；起始用户回合是否计入在 P1 定稿（默认计入）。
- 墙钟：由 P1 在 goal 处于 active 的区间采样增量累加；P0 提供 `accountGoalUsage` 累加接口，不自行计时。
- token：字段预留 0/null，P4 才写入与校验。

## 10. 测试矩阵（P0 门禁）

1. **schema 迁移**
   - 全新库：`user_version=18`、goal 列存在且默认 `'none'/0/NULL`、`task_goal_runs` 存在。
   - v17 升级：构造 v17 库 → 打开 → 迁移到 18；旧任务 `goal` 为 `undefined`，其余字段不变。
   - v14 仍被拒绝（沿用既有守卫断言）。
2. **状态机**
   - 每条合法转移成功；每条非法转移抛 `GoalStateError`（含非终态 `set` 无 replace、终态 `pause/resume` 等）。
   - replace 语义：active→replace set 成功；complete→set 无 replace 成功。
   - resume 重置 no-progress 字段。
3. **存储 CRUD/CAS**
   - `setGoal/getGoal/clearGoal` 往返一致；`TaskMetadata.goal` 投影正确。
   - revision 过期写入被拒且不变更；`expectedGoalId` 不匹配被拒。
   - `updateGoalStatus` 拒绝非法转移（双保险）。
   - `accountGoalUsage` 累加正确；触发 `budget_limited` 与 reason；负 delta 被拒。
   - `updateGoalBudgets` 达到已有用量立即 `budget_limited`。
4. **校验**
   - 空/超长/控制字符/credential-shaped objective 或 criterion 被拒。
   - 非法预算（0、负、非整数）被拒；`tokenBudget` 被拒（P4 前）。

## 11. 验证门禁

- `npm run check`（含 prettier/eslint/类型检查）。
- 定向：`npm test` 中 platform 相关用例全绿；macOS 当前主机。
- Windows 11 适配整体推迟，本片不声称跨平台。
- 提交前 staged diff 做凭据扫描；本片不引入任何 provider 凭据路径。

## 12. 后续衔接（预告，不实现）

- P1 在 `packages/runtime` 复用本状态机实现 goal 续跑 policy 与工具集。
- P2 TUI 接线：`taskMode='goal'` 的创建路径 + `/goal` 命令族。
- P3 WebUI：app-server `runTask` 接 policy + protocol 事件。
