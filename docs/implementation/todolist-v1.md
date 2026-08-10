# Candy V1 待办与进度

更新日期：2026-08-11
基线分支：`codex/candy-v1-foundation`
当前基线提交：`37d60ed9f22d1426449faa6cb75c2b69655913de`

标记约定：`☑️` 已完成；`◐` 已完成一部分（后续条件明确列出）；`⬜` 未开始或尚未达到可验收状态。

本文件是 V1 开发待办的进度基准。每完成一项或一个可独立验证的子项，都必须在此更新状态、验证证据和剩余条件；不能用局部测试通过替代完整验收。

当前执行范围：今晚仅在 Windows 11 Pro x64 主机执行和验证 Windows 项。macOS 项仅作为明天 MacBook Pro 会话的待办；跨平台项在两侧证据完成前不得标记为完成。

## 今晚执行：Windows 11 x64

执行顺序：先恢复本机确定性/原生检查和路径防逃逸，再完成 Windows 本地可用链路；需要凭据、Developer Mode、签名身份或外部服务时记录阻塞，继续推进其他 Windows 项。

- ☑️ 修复平台路径适配：应用数据根路径根据传入的目标平台选择 `path.win32` 或 `path.posix` 语义，并覆盖跨宿主的 macOS/Windows 模拟测试。
  证据：Windows 11 确定性检查通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ☑️ 重构 Task Worktree 关联校验：结构化解析 `git worktree list --porcelain -z`，对路径进行规范化并精确比较，同时要求精确的锁定原因；不再使用模糊字符串匹配。
  证据：Windows Git 工作树创建、Apply、丢弃和重启交接 fixtures 通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ◐ 建立 Windows reparse-point 测试前置条件并验证防逃逸。
  已完成：普通 Windows 用户会话下的目录 junction 覆盖，确认 Pi 工作区边界拒绝经 junction 访问的外部文件；原生 runner 预检拒绝 workspace/cwd reparse component，并在本机 smoke 中拒绝真实 junction、完成 fixture 清理。
  当前未完成/阻塞：2026-08-10 的真实 symlink 探针返回“Administrator privilege required”；探针目录已从 `%TEMP%` 清理。需要启用 Developer Mode 或取得等效授权后，补齐 symlink、其他 reparse point、运行期 race/path escape 和清理流程的真实 Windows 矩阵。

- ☑️ 在干净依赖目录重跑完整门禁、TUI/App Server smoke 与原生检查。
  证据：`npm ci --ignore-scripts` 后 `npm run check`（92 个测试）以及 TUI/App Server smoke 通过；Windows `npm run check:native` 于 2026-08-10 以退出码 0 通过。Rust 编译器仍报告未使用代码警告，不影响检查结果；Windows G2 的实际 Job Object 与安全验收仍单列为未完成项。

- ◐ 将 `G0-WIN` 更新为 Windows 验收进行中，并执行 Windows 确定性矩阵。
  已完成：已确认当前主机为 Windows 11 Pro x64，`G0-WIN` 已更新为 `In progress`。
  已完成：ACC-12 Windows 确定性子集完成 10 轮测量：TUI cold start p95 `1239 ms`（目标 <= `2000 ms`），Desktop cold start 到 task-list smoke p95 `1419 ms`（目标 <= `5000 ms`）；脱敏报告为 `out/acceptance/windows/responsiveness-latest.md`，由 `.gitignore` 排除，source revision 为 `37d60ed9f22d1426449faa6cb75c2b69655913de`。
  待完成：Runtime event 到 UI、取消、Browser Take Control、三任务并发冻结/丢事件等 ACC-12 指标，以及 ACC-01、ACC-02、ACC-05、ACC-06、ACC-08、ACC-11 的完整 Windows 矩阵。

- ◐ 完成 Windows G2：Job Object 所有权、完整后代进程取消、命令无网络/工作区隔离、Windows reparse 防逃逸与安全评审。在验收前，Windows Shell Auto 和 Shell Auto Debug 必须保持禁用。
  已完成：Rust runner 以 suspended process 创建后先加入 Job Object，设置 `KILL_ON_JOB_CLOSE` 后恢复；Windows native smoke 通过正常完成、`network:true` fail-closed、workspace 逃逸、junction reparse 拒绝和 runner 取消后的后代清理；app-server 已接入 Windows `.exe` runner/validator 路径。
  未完成条件：`network:true` 拒绝只是协议/策略边界，不等于命令的 OS 级无网络；尚未完成任意命令的 OS 级 workspace ACL/AppContainer containment、运行期间 reparse/race 防逃逸、签名/正式发布打包路径和独立安全评审。Shell Auto 与 Shell Auto Debug 继续禁用。

- ◐ 验收 Windows Browser Workspace：打包 Electron 中的 `WebContentsView`、站点授权、观察版本、防陈旧操作、Take Control、下载和对抗性页面测试。
  已完成：packaged Windows fixture 通过 allowlist 后加载本机页面，阻止不允许的 redirect、popup、permission 和 download，并验证显式 Take Control/return-to-agent revision；Browser profile 使用 Candy-owned persistent partition，页面没有 Candy preload 或 provider credential。
  待完成：完整 click/type/submit agent action、真实 renderer stale-action matrix、截图转 attachment、输入来源识别与物理输入转移、更多对抗性页面和完整 ACC-09/ACC-12 Browser 指标。当前实现继续使用 ADR-0006 的显式 Take Control fallback。

- ◐ 补齐 Windows 长运行/Auto Debug：用户 steering、审批等待、最终证据摘要及 Windows 原生 validator 集成。
  已完成：有界 Auto 执行、停止原因、持久化进度、暂停/恢复、崩溃中断和 Desktop 进度投影的确定性覆盖；Windows Job Object validator 已接入 app-server，原生 smoke 通过。
  待完成：用户 steering/审批交互、最终证据摘要、OS 级命令 containment、安全评审以及 Windows 打包证据。

- ◐ 在用户明确授权并预先配置 Candy 自有凭据后，于 Windows 执行 DeepSeek `LIVE-DS-01..04`、MiniMax `LIVE-MM-01..05` 和 MiniMax Token Plan entitlement 验证。
  已完成：DeepSeek 已通过 Windows 本机 Gate 的全部 7 项：`LIVE-DS-01..04`、取消、受控 401/429/超时、无密钥会话扫描和密钥租约释放。只访问 `https://api.deepseek.com`；脱敏本地报告为 `out/acceptance/live/deepseek-latest.md`，由 `.gitignore` 排除。
  已完成：经用户授权的脱敏读取确认 Claude Code 已声明 MiniMax，配置模型标识为 `MiniMax-M3[1M]`，认证信息存在，且端点为 `https://api.minimaxi.com`；未读取或复制 Token。此项仅为发现证据，Candy 没有 Claude Code → MiniMax 自动导入器。
  待完成：MiniMax Windows Gate 与 Token Plan entitlement。Claude Code/OpenCode 配置均不作为自动凭据来源；Windows 结果也不能替代明天 macOS 的独立证据。

- ◐ 完成 Windows Credential Manager、桌面打包、签名、恢复和响应性矩阵。
  已完成：Desktop 凭据输入框按运行平台显示存储位置；Windows 显示 `Windows Credential Manager`，macOS 显示 `macOS Keychain`，并有独立合同测试；Candy 自有 Windows Credential Manager 适配器的合成 fixture 已完成 `absent -> present -> present -> absent`（set/replace/has/delete），未输出或读取 fixture 值；在用户提供的已验证 Electron `43.2.0` Windows x64 本机运行时下，设置 `$env:ELECTRON_OVERRIDE_DIST_PATH` 后执行 `npm run smoke:desktop` 通过，输出 `desktop app-server JSONL smoke ok`；真实 app-server 子进程重启后 queued metadata 与 active owner crash interruption 快照恢复 smoke 通过。
  已完成：从已验证的 Electron `43.2.0` Windows x64 目录生成 `out/windows/Candy` 未签名开发包，嵌入 Node `v22.23.2`、app-server 和 Windows native runner；`npm run smoke:desktop:packaged:windows` 通过，输出 `packaged unsigned Windows Desktop app-server JSONL smoke ok`；随后使用包内 `resources/node/node.exe` 和 bundled keyring addon 完成 packaged Credential Manager synthetic lifecycle smoke，DeepSeek presence 保持不变。
  待完成：DeepSeek Candy 账户本次已存在，smoke 未触碰该真实账户；对该固定账户补做替换/删除需要用户授权的可恢复测试窗口或专用空账户。Windows 正式安装/下载、签名、active-owner/工具中断恢复和完整响应性矩阵仍未完成。该开发态 smoke 不替代 Windows 签名、恢复或完整 Desktop 验收。

- ◐ 重新生成当前提交的 Windows 验收证据。
  已完成：在干净提交 `37d60ed9f22d1426449faa6cb75c2b69655913de` 上执行 `npm run acceptance:windows`，13/13 个确定性步骤通过，包含 queued/active crash recovery、未签名 packaged Desktop、Browser fixture 和 packaged Credential Manager fixture smoke；脱敏报告为 `out/acceptance/windows/latest.md`，由 `.gitignore` 排除。
  未完成：报告仍明确保留 Windows 签名/正式安装、完整 Browser、完整 G2 安全、active-owner/工具中断恢复、live MiniMax/Token Plan、完整 ACC-01..12 和 product-owner acceptance 阻塞；不可替代完整 Windows 验收或跨平台结果。

## 明天执行：macOS `26.5.2` Apple Silicon

- ⬜ 执行 macOS 工具链、TUI、Desktop App Server、Runtime/session-remap、Worktree/Apply 和 ACC-12 响应性矩阵，并生成新的 macOS 脱敏证据。

- ⬜ 完成 macOS Sandbox Runner/Seatbelt、后代取消、网络与工作区隔离及安全评审；在验收前继续禁用 macOS Shell Auto 和 Shell Auto Debug。

- ⬜ 验收 macOS Keychain presence/set/replace/delete、Apple 签名/公证、打包 Desktop、恢复和响应性矩阵。

- ⬜ 验收 macOS Browser Workspace 的打包、输入归属、Take Control、权限、重定向、下载和对抗性页面矩阵。

- ⬜ 在同一套 Candy 自有凭据路径下重跑 macOS 的 DeepSeek/MiniMax Live Provider Gate；不得以 Windows 结果替代 macOS 证据。

## 跨平台收尾：Windows 与 macOS 均完成后

- ⬜ 对照 ACC-01 至 ACC-12 汇总两个平台的精确构建、版本、脱敏证据和未决项；任何一侧 `Blocked`、`Fail`、P0 或 P1 均阻止 Candy V1 Release 声明。

- ⬜ 重新生成当前提交的全量验收证据，替换仍指向 `0710d00` 的旧报告，并更新 macOS 基线表述。

## 已追加的实现检查点

- ☑️ 持久化排队任务重排：SQLite 在立即事务内保存重排后的连续队列位置；协议和 App Server 支持受限的 `task.reorder`；TUI 提供 `:prioritize <task-id>` 并显示队列位置。
  证据：92 个确定性测试、TUI/App Server smoke 通过；提交 `a556df122c2759049b9803e2e9df46bc8b6896d8`。跨进程恢复和 Desktop 队列面板仍是后续工作，未在此项宣称完成。

- ☑️ Windows 凭据界面平台标识：Windows Desktop 不再错误提示 `macOS Keychain`，而是显示 `Windows Credential Manager`；非 Windows 平台保留准确的系统存储标签。
  证据：Windows `npm run check` 93/93、`smoke:tui-task` 和 `smoke:app-server` 于 2026-08-10 通过。该 UI 修正不替代真实 OS 凭据存储或 Desktop 启动验收。
