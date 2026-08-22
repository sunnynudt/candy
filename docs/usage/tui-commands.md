# Candy TUI 命令参考（Command Reference）

更新：2026-08-20 之后（本文件随命令元数据 `apps/tui/src/slash-commands.ts` 同步；TUI 内运行 `/help` 查看当前命令列表）。

## 约定

- 命令以 `/` 前缀为 canonical 形式（如 `/model`）；`:` 前缀（如 `:model`）仍作为兼容别名。
- 需要参数的已知命令在缺少参数时只显示 usage，**不会**作为提示词发给模型。
- 未知 `/...` 输入（例如绝对路径 `/private/...`）按普通提示词处理。
- 所有输出均有界并脱敏；凭据只显示 presence，绝不回读完整值。

## 任务与工作区

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/new` | `/new [prompt]` | 创建新任务；可带初始提示词 |
| `/workspace` | `/workspace [path]` | 显示或选择工作区（绝对路径） |
| `/tasks` | `/tasks` | 列出任务（状态/模型/工作区/revision） |
| `/use` | `/use <task-id>` | 选择已持久化任务继续操作 |
| `/transcript` | `/transcript [task-id]` | 显示已保存的对话记录 |

## 模型与附件

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/model` | `/model <deepseek-flash|deepseek-pro|minimax-m3>` | 选择主模型；无参时列出可选模型 |
| `/attach` | `/attach <absolute-path>` | 为下一个任务附加图片（仅 MiniMax M3） |
| `/attachments` | `/attachments` | 列出已选择附件 |

## 凭据

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/credentials` | `/credentials` | 显示 DeepSeek/MiniMax 凭据 presence |
| `/credential` | `/credential set|replace|delete <deepseek|minimax-cn>` | 设置/替换/删除凭据（不读回完整值） |

## 审查与变更

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/changes` | `/changes` | 显示当前任务变更 |
| `/diff` | `/diff [path]` | 显示有界脱敏 diff；`/apply` 前必须完整查看 |
| `/apply` | `/apply` | 将审阅后的任务变更显式应用到目标工作区（不自动提交） |
| `/discard` | `/discard` | 丢弃 Candy 自有的 Task Worktree |
| `/validate` | `/validate` | 运行已配置的 validator |
| `/validator` | `/validator <executable> [args]` | 配置任务 validator |

## 控制

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/steer` | `/steer <text>` | 向当前活动 turn 排队一条引导 |
| `/follow-up` | `/follow-up <text>` | 排队一条追问 |
| `/pause` | `/pause <task-id>` | 暂停任务 |
| `/resume` | `/resume <task-id> <continuation>` | 显式续跑；无 continuation 时只展示已保存证据，不重放任何中断的 turn |
| `/cancel` | `/cancel <task-id>` | 取消任务 |
| `/prioritize` | `/prioritize <task-id>` | 将排队任务提前 |
| `/approve` / `/deny` | `/approve <approval-id>` / `/deny <approval-id>` | 审批/拒绝待处理动作（如文件删除、网络命令） |
| `/quit` | `/quit` | 退出 Candy |

## 模式与资源

| 命令 | 语法 | 说明 |
| --- | --- | --- |
| `/profile` | `/profile read-only|auto` | 审批模式；`auto` 开放文件读写（删除仍需逐次审批） |
| `/worktree` | `/worktree on|off` | 默认 `off` 直接编辑当前工作区（允许已有未提交修改）；`on` 把 Auto 任务隔离到 `<workspace>/.git/candy-worktrees/` |
| `/trusted-shell`（`/shell`） | `/trusted-shell on|off` | 开启/关闭 Trusted Shell Auto；开启时会自动启用 Worktree，不需要先手动执行 `/worktree on`（平台 G2 通过后可用；macOS arm64 已批准） |
| `/prompt` | `/prompt <name> [args]` | 运行 Candy 自有提示词模板 |
| `/prompts` | `/prompts` | 列出提示词模板 |
| `/resources` | `/resources` | 显示 Candy 资源诊断 |
| `/help` | `/help` | 显示完整命令参考 |

## 安全边界

- `/apply` 前必须先查看 `/changes` 与未截断的 `/diff`；Candy 从不自动 commit/push。
- 直接模式（`/worktree off`）允许在已有未提交修改的本地工作区继续编辑，提交由用户用 git 完成；`/worktree on` 时才使用 `/apply` 合入。
- 普通开发无需配置：启动后默认就是 Auto + 直接模式；只有需要隔离或 Shell 时才需要额外命令。
- `/trusted-shell on` 会自动切换到 Worktree；如果平台 Trusted Shell 能力未通过 G2，Candy 会保留关闭状态并显示具体原因。
- `/resume` 必须带显式 continuation；重启后不自动续跑、不重放不确定的 turn。
- 凭据、提示词、工具参数、diff 与进程环境均做脱敏/有界处理；凭据只发往批准的 provider 端点。
- Shell 仅在平台 G2 通过后可用；未启用时显示为不可用能力而非隐藏。
