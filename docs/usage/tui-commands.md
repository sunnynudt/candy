# Candy TUI 命令参考（Command Reference）

更新：2026-08-20 之后（本文件随命令元数据 `apps/tui/src/slash-commands.ts` 同步；TUI 内运行 `/help` 查看当前命令列表）。

## 约定

- 命令以 `/` 前缀为 canonical 形式（如 `/model`）；`:` 前缀（如 `:model`）仍作为兼容别名。
- 需要参数的已知命令在缺少参数时只显示 usage，**不会**作为提示词发给模型。
- 未知 `/...` 输入（例如绝对路径 `/private/...`）按普通提示词处理。
- 所有输出均有界并脱敏；凭据只显示 presence，绝不回读完整值。

## 任务与工作区

| 命令          | 语法                                                      | 说明                                                                                                                      |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `/new`        | `/new [prompt]`                                           | 创建新任务；可带初始提示词                                                                                                |
| `/new`        | `/new --validator <absolute-executable> [args] -- <goal>` | 创建带 Validator 的新任务；`--` 后为任务目标                                                                              |
| `/plan`       | `/plan [prompt]`                                          | 创建只读规划任务（plan 模式）；规划 turn 绝不修改文件，审阅方案后用 `/build` 实施                                         |
| `/build`      | `/build [task-id]`                                        | 把已审阅的 plan 任务切换到当前 profile 并开始实施；无参时使用当前任务                                                     |
| `/debug`      | `/debug [prompt]`                                         | 创建 Auto Debug 任务：模型回合 + 验证器循环，直到验证通过、证据停滞或预算耗尽（需先配置 `/validator` 或传 `--validator`） |
| `/workspace`  | `/workspace [path]`                                       | 显示或选择工作区（绝对路径）                                                                                              |
| `/tasks`      | `/tasks`                                                  | 列出任务（标题/状态/创建更新时间/模型/工作区/revision/Validator）                                                         |
| `/status`     | `/status [task-id]`                                       | 查看当前或指定任务的状态、执行阶段、审批与恢复信息                                                                        |
| `/use`        | `/use <task-id>`                                          | 选择已持久化任务继续操作                                                                                                  |
| `/transcript` | `/transcript [task-id]`                                   | 显示已保存的对话记录                                                                                                      |

## 模型与附件

| 命令           | 语法                                                    | 说明                                                                                                                                                                             |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/model`       | `/model <deepseek-flash \| deepseek-pro \| minimax-m3>` | 选择主模型；键入裸 `/model` 会先显示“查看当前模型”和模型候选，直接 Enter 仍只列出当前模型与可选模型；从 M3 切到非 M3 会原子地解绑当前任务残留的图附件，避免后续 `/resume` 报错。 |
| `/attach`      | `/attach <absolute-path>`                               | 为下一个任务附加图片（仅 MiniMax M3）；也可复制图片后按 `Ctrl+V`                                                                                                                 |
| `/attachments` | `/attachments`                                          | 列出已选择附件                                                                                                                                                                   |

## 工作区上下文

在普通提示词中输入 `@`，然后使用补全选择当前 Local Workspace 内的文件或目录：

- `@src/index.ts` 会把该文本文件内容注入本次 prompt。
- `@src` 会递归注入目录下的有限数量文本文件；`.git`、`node_modules`、符号链接、二进制文件和超出大小限制的文件不会进入上下文。
- 只有选中的工作区路径可被补全和读取；越界或不可读路径会被跳过。
- 文件内容在进入模型上下文前会做凭据脱敏；图片不会通过 `@` 读取，可用 `/attach` 或复制图片后按 `Ctrl+V`。

## 凭据

| 命令           | 语法             | 说明                                |
| -------------- | ---------------- | ----------------------------------- |
| `/credentials` | `/credentials`   | 显示 DeepSeek/MiniMax 凭据 presence |
| `/credential`  | `/credential set | replace                             | delete <deepseek | minimax-cn>` | 设置/替换/删除凭据（不读回完整值） |

## 审查与变更

| 命令           | 语法                             | 说明                                                                                |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `/changes`     | `/changes`                       | 显示当前任务变更                                                                    |
| `/diff`        | `/diff [path]`                   | 显示有界脱敏 diff；`/apply` 前必须完整查看                                          |
| `/apply`       | `/apply`                         | 将审阅后的任务变更显式应用到目标工作区（不自动提交）                                |
| `/undo`        | `/undo [task-id]`                | 恢复隔离任务（`/worktree on`）最新一轮的变更快照；direct 模式请用 git restore/clean |
| `/checkpoints` | `/checkpoints`                   | 列出当前任务的 undo 快照                                                            |
| `/discard`     | `/discard`                       | 丢弃 Candy 自有的 Task Worktree                                                     |
| `/validate`    | `/validate`                      | 运行已配置的 validator                                                              |
| `/validator`   | `/validator <executable> [args]` | 为后续 `/new` 配置任务 Validator                                                    |

## 控制

| 命令                 | 语法                                             | 说明                                                                |
| -------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `/steer`             | `/steer <text>`                                  | 向当前活动 turn 排队一条引导                                        |
| `/follow-up`         | `/follow-up <text>`                              | 排队一条追问                                                        |
| `/pause`             | `/pause <task-id>`                               | 暂停任务                                                            |
| `/resume`            | `/resume <task-id> <continuation>`               | 显式续跑；无 continuation 时列出 paused/interrupted 任务（编号、任务标题、状态、模型、停止时长，最近更新的在前），不重放任何中断的 turn |
| `/cancel`            | `/cancel <task-id>`                              | 取消任务                                                            |
| `/prioritize`        | `/prioritize <task-id>`                          | 将排队任务提前                                                      |
| `/approve` / `/deny` | `/approve <approval-id>` / `/deny <approval-id>` | 审批/拒绝待处理外部动作（如受限网络命令）                         |
| `/quit`              | `/quit`                                          | 退出 Candy                                                          |

## 模式与资源

| 命令                         | 语法                    | 说明                                       |
| ---------------------------- | ----------------------- | ------------------------------------------ |
| `/profile`                   | `/profile read-only     | auto`                                      | 工作区模式；`auto` 自动执行受限文件读写删，结果通过变更审查确认                                                                                  |
| `/worktree`                  | `/worktree on           | off`                                       | 默认 `on`，把 Auto 任务隔离到 `<workspace>/.git/candy-worktrees/`；`off` 直接编辑当前工作区（允许已有未提交修改），作为显式覆盖                   |
| `/local`                    | `/local on              | off`                                       | 默认在已批准 macOS 的隔离 Auto Git 任务中启用离线本地命令；`off` 显式关闭后续任务的该能力，`on` 恢复默认（网络仍逐条确认）。`/trusted-shell`、`/shell` 是兼容别名 |
| `/prompt`                    | `/prompt <name> [args]` | 运行 Candy 自有提示词模板                  |
| `/prompts`                   | `/prompts`              | 列出提示词模板                             |
| `/skills`                    | `/skills`               | 列出 Candy 自有技能（名称/描述/来源/目录） |
| `/skill`                     | `/skill <name> [goal]`  | 显式加载技能正文并提交任务（无参列出技能） |
| `/resources`                 | `/resources`            | 显示 Candy 资源诊断                        |
| `/help`                      | `/help`                 | 显示完整命令参考                           |

## TUI 界面

- 顶部两行固定信息区优先显示人类可读的任务标题和当前交互状态；第二行显示工作区、Auto/Read-only、Direct/隔离、Shell、模型及待恢复任务数。`上轮完成` 表示本轮模型执行结束，仍可在底部继续当前任务。
- `↻ N 个可恢复任务 · /tasks` 表示已持久化的 paused/interrupted 任务数，不是本轮重试次数；先运行 `/tasks` 找到任务，再用 `/resume <task-id> <continuation>` 显式继续，Candy 不会自动重放。
- 用户消息与模型回复分别以 `你`、`Candy` 标识。模型回复（assistant 流式输出）以 markdown 渲染（标题加粗、引用/链接/分割线暗色、代码块保留原文）；transcript 使用终端当前可用宽度，并在终端 resize 时重新排版。
- 同一次工具调用在实时 transcript 中只占一条活动记录：开始、更新和完成会就地更新；工具行同时显示人类可读语义和实际事件工具名，完成后保留有界、脱敏的最终工具证据。等待审批使用独立的警示层级和可复制命令，不与普通工具活动混排。
- 输入区根据状态显示 `开始任务`、`Candy 正在处理`、`需要你的确认` 或 `继续任务`，底部只保留当前场景需要的命令提示。键入 `/` 打开 Candy 自有命令列表。
- transcript 视口只显示尾部窗口；内容超出视口时按 `PageUp`/`PageDown` 翻页回看历史（编辑器多行内容在同一情况下的 Page 键让位给 transcript 回看）。回看时顶部显示提示行，翻到底部即回到最新；回看期间有新内容到达会显示 `有新内容` 标记。
- 实时渲染窗口有上界（默认 192 KiB 滚动窗口），更早内容通过 `/transcript <task-id>` 查看完整已保存记录。
- `Ctrl+X` 把最近一段连续的模型回复（不含中间的工具/状态行）复制到系统剪贴板（macOS `pbcopy`；Windows PowerShell `Set-Clipboard`），回复为空或复制失败时显示提示行；复制的文本与 transcript 显示的一致（已脱敏）。
- `Ctrl+V` 只在用户主动按键时读取系统剪贴板中的图片，并把它直接存为 Candy 自有附件（不读取剪贴板文本、不写临时外部图片文件）；粘贴成功后显示 attachment id。图片附件需显式使用 `/model minimax-m3`，否则创建任务前会给出提示。
- `Ctrl+P` 在模型间向前循环（flash → pro → M3），`Ctrl+Shift+P` 向后循环；与 `/model` 相同的校验（活动 turn 不可切换）会拒绝并说明原因。从 M3 切换到非 M3 时，已存储的图附件会自动解绑以让后续 `/resume` 不带图，避免显式报错。
- 模型推理过程（thinking 流）默认折叠为一行暗色标记 `▸ 思考过程 · Ctrl+T 展开`，按 `Ctrl+T` 展开/收起暗色推理正文；thinking 只做实时展示，不写入任务存档（`/transcript` 回放不含推理），也不会进入 `Ctrl+X` 的复制内容。
- `Ctrl+G` 用外部编辑器编辑当前输入行：按 `$VISUAL` → `$EDITOR` → 平台默认（macOS `nano` / Windows `notepad.exe`）解析命令（支持 `code -w` 这类带参数值）；编辑期间 TUI 挂起，保存退出后输入回填（编辑器追加的尾部换行会被去掉，CRLF 归一为 LF），非零退出或启动失败时输入保持不变；临时文件位于 Candy 应用数据目录，退出后必删。

## Candy 自有技能

- 技能按优先级从多个根加载：① Candy 应用数据目录的 `skills/<名称>/SKILL.md`（Candy-owned，最高优先）→ ② `~/.agents/skills/`（agent 无关共享目录，默认启用，与 Pi/Claude Code 共享）→ ③ `CANDY_SKILL_DIRS` 环境变量列出的目录（`:` 或 `;` 分隔，`~` 可展开，如 `~/.pi/agent/skills`、`~/.claude/skills`、`~/.config/opencode/skills`）。重名时高优先级生效，`/resources` 显示 collision 诊断。
- `/skills` 列出技能元数据（名称/描述/来源 `candy|shared|configured`/目录）；模型可见清单上限 80 个技能，超出时更高优先级根优先并在诊断中说明。
- `/skill <name> [goal]` 显式触发技能：把该技能的 SKILL.md 正文（受限读、脱敏、有界）与可选目标拼成 prompt 提交，适合强制使用某个技能（如 `/skill tdd 为这个函数补测试`）；无参 `/skill` 列出全部技能。
- 已加载技能目录对 `candy_read`/`candy_list` 开放只读（绝对路径、64 KiB 单文件有界、拒绝符号链接、realpath 越界校验、凭据脱敏）；**写/删/搜索不进入技能目录**。
- 技能脚本（`scripts/`）是普通文件：通过隔离的本地命令执行（`bash <技能目录>/scripts/xxx.sh`），受常规命令策略约束；Candy 从不自动执行技能内容，也不继承用户全局 CLI PATH。
- 文件大小、目录深度、条目数与总字节均有上界；符号链接、越界路径与凭据形内容会被拒绝或脱敏。Pi 的 `~/.pi` 资源、扩展、包、主题与可执行资源不会进入 Candy 会话边界。

## 安全边界

- `/apply` 前必须先查看 `/changes` 与未截断的 `/diff`；Candy 从不自动 commit/push。
- 默认 Auto 任务运行在隔离 Task Worktree（`/worktree on`），结束时用 `/apply` 合入；`/worktree off` 显式切回直接模式，允许在已有未提交修改的本地工作区继续编辑，提交由用户用 git 完成。
- 普通开发无需配置：启动后默认就是 Auto + 隔离 Task Worktree；已批准 macOS 主机上的本地 `npm run` 等命令离线可用，复用已有依赖而不自动下载。
- `/local off` 会关闭后续任务的本地命令能力；如果平台能力未通过 G2，Candy 会保留关闭状态并显示具体原因。
- `@file` / `@directory` 上下文仅作用于当前 turn，不会修改工作区文件；目录上下文最多读取 100 个文件、总计 256 KiB，单文件最多 64 KiB。
- `/resume` 必须带显式 continuation；重启后不自动续跑、不重放不确定的 turn。
- `/plan` 创建只读规划任务：规划 turn 以 read-only profile 运行（不注册写入/删除/Shell 工具），模型只输出实施方案；审阅后用 `/build [task-id]` 把任务提升为当前 `/profile` 并提交一段显式实施 continuation（同一 Pi 会话保留方案上下文，不重放目标）。plan 任务不创建 Task Worktree、不启用 Trusted Shell，`/build` 只对 plan 任务生效。
- `/debug` 创建 Auto Debug 任务（`mode=debug`，要求已配置 validator）：每轮先跑模型回合，再自动运行 validator；失败时把有界、脱敏的验证证据追加到下一轮 prompt 继续修复，直到验证通过、连续两轮证据相同（stall）或达到预算（默认最多 6 轮）。中途可用 `/cancel` 停止；非通过停止会把任务置为 interrupted，只能通过显式 `/resume` 继续。进度写入任务 run 记录（`/status` 可查）。
- `/undo` 只作用于隔离任务（`/worktree on`）：每个会变动的模型回合开始前，Candy 会把当前 changed-file 内容以有界、脱敏快照存入内存 undo 历史（每任务最多 8 轮）；`/undo` 恢复最新一轮快照（凭据形内容永不快照/恢复），并清除过期的 review 状态，之后需重新 `/changes`+`/diff` 审查。direct 模式下 Candy 不重置本地修改，请用 git restore/clean。undo 历史不跨重启持久化，重启后仍需显式 `/resume`。
- 凭据、提示词、工具参数、diff 与进程环境均做脱敏/有界处理；凭据只发往批准的 provider 端点。
- Shell 仅在平台 G2 通过后可用；未启用时显示为不可用能力而非隐藏。
