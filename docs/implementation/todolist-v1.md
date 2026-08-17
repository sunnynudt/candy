# Candy V1 待办与进度

更新日期：2026-08-17
基线分支：`codex/candy-v1-foundation`
本工作包起始提交：`b7cab12a8ecfd18d46c2813653e19dd978143ee4`

当前代码 HEAD `50074c2` 已发布并完成 current-host macOS `26.6.1` arm64 acceptance **14/14**，内含 `npm run check` **241/241**。Issue #4 最新 workspace write ordering checkpoint：`50074c2` 让 `candy_write` 先验证 opened regular-file handle 与 workspace binding，再通过该 handle truncate/write；最新标准扫描 `721c4ab5-ccdf-4052-9a28-b695323b3b70` 绑定当前 HEAD，报告 **4 个开放 finding（全部 medium）**，此前的 low file-metadata finding 已处理，且本次局部写入修复只降低风险、不构成 security clearance。该扫描使用 parent validation fallback。精确 macOS `26.5.2` 在当前 `26.6.1` 主机 preflight blocked，Windows 11、独立 G2、签名和最终 V1 acceptance 仍待完成；`.omo/` 保持 user-owned 未跟踪。

标记约定：`☑️` 已完成；`◐` 已完成一部分（后续条件明确列出）；`⬜` 未开始或尚未达到可验收状态。

本文件是 V1 开发待办的进度基准。每完成一项或一个可独立验证的子项，都必须在此更新状态、验证证据和剩余条件；不能用局部测试通过替代完整验收。

`b672d5a` 后当前主机复验：`npm run acceptance:macos` 通过 **14/14**，source revision 为 `b672d5a7e0f08c6b5dfe6f1c8299c88be79f40f2`，固定 Node `22.23.2`/npm `10.9.8`，`npm run check` 为 **213/213**；`npm run acceptance:macos:baseline` 在当前 `26.6.1` 主机正确以 preflight blocked 结束。下方较早的结果仅保留为历史 checkpoint 证据。

`a28606c` 后当前主机复验：`npm run acceptance:macos` 通过 **14/14**，固定 Node `22.23.2`/npm `10.9.8`，`npm run check` 为 **203/203**；新增 retry 成功投影、compaction 到 settled 顺序和已取消 turn 不启动 provider 的证据。

`236b2f2` 后当前主机复验：`npm run acceptance:macos` 通过 **14/14**，`npm run check` 为 **204/204**；TUI 新增 `:resources`，可报告 Candy-owned skill/prompt 的 malformed/collision diagnostics，且不显示资源内容。

当前范围说明：Issue #4 已将 V1 收敛为 macOS/Windows 11 TUI；Desktop、Browser Workspace 及其依赖流程延后到 V2。下方较早条目保留为历史证据，不改变当前 [产品范围](../product/candy-v1.md) 与 [TUI 验收合同](../product/acceptance-v1.md)。实现 checkpoint `819d8a7` 已接入 Windows 11 toolchain gate 及仅在 Windows 11 x64 执行的核心 TUI journey，`c632f74` 已接入仅在支持平台执行的 OS-store TUI credential lifecycle smoke，`456bab2` 已接入真实 PiAgentEngine 驱动的确定性 TUI journey，覆盖批准的 DeepSeek endpoint、Candy-owned session persistence 和 session credential exclusion，`737d7d7` 已接入 Pi-backed `candy_write` tool-loop workspace mutation，`34ae949` 已接入 credential revocation evidence，证明删除凭据后下一次真实 Pi 操作返回 `needs_credentials` 且不再发起 provider request、历史保留、session 无凭据，`a36aac4` 已接入 bounded workspace review metadata persistence 和真实 Pi coding journey，覆盖 review、restart、transcript/tool evidence、显式 Apply 且不改变 HEAD/index，`54b54c1` 已接入真实 Pi provider stream cancellation，观察 abort 且无 false completion；新增 production Pi compaction fixtures 覆盖 overflow recovery、continuation 和 in-flight cancellation；当前 macOS TUI-only acceptance 报告绑定代码 checkpoint `50074c2`，为 14/14（macOS `26.6.1` arm64，Node `22.23.2`/npm `10.9.8`），确定性检查为 241/241，并覆盖有界、凭据脱敏的工具参数及增量/完成输出、presence-only credential evidence、revocation、Pi-backed projection/persistence/workspace mutation/review-restart-apply/cancellation 和 TUI-only 十轮响应性门槛；标准扫描绑定 `50074c2` 仍有 4 个 medium findings；Windows 仍待目标主机执行，精确 `26.5.2` 在当前主机 preflight blocked，独立 G2、签名和最终 V1 acceptance 也未完成。

新增确定性证据：TUI 在 compaction 已开始后执行 `:cancel`，最终状态为 `cancelled`，且不投影 settled/completed。

新增生产 Pi 确定性证据：`PiAgentEngine` 在 context overflow 后完成 compaction summary 并继续当前 turn；compaction provider request 未完成时取消会 fail as cancelled，且不投影 `turn.completed`。

新增当前 revision provider 证据：`7f2d967` 的 Candy-owned DeepSeek live Gate 通过 **7/7**，国内 MiniMax live Gate 通过 **8/8**；报告仅保留脱敏摘要。

新增 current-HEAD 原生 containment 证据：`38775e2` 的 macOS strict Sandbox Runner matrix 通过 workspace/symlink、Git metadata/ref/reflog、默认网络、后代取消和 parent-exit cleanup 检查；该结果不等于独立 G2 通过。

新增 clean-install 证据：固定 Node `22.23.2`/npm `10.9.8` 下 `npm ci --ignore-scripts` 不修改 `package-lock.json`，并通过 toolchain assertion 与 build。

新增 Pi session-root 安全证据：`e6170b6` 对 Candy-owned `sessionRoot/taskId`、`sessionRoot/pi-agent` 做最终目录 symlink rejection，reload/recovery 和已有 session 选择使用 regular-file/no-follow handle validation；Pi adapter focused tests **47/47**，全量 `npm run check` **238/238**，current macOS acceptance **14/14**。该项只覆盖已回归的 symlink route，不替代 descriptor-relative/OS-level replacement-race、Windows 11、精确 `26.5.2` 或独立 G2 证据。

新增 workspace binding 安全证据：`6f63c3e` 对 Pi workspace 文件读写绑定 selected root identity，在打开文件后复核 regular-file identity 与 canonical containment；non-Git snapshot 对每个 traversed directory 在 enumeration 后复核 identity，并新增 selected-root symlink regression。全量 `npm run check` **239/239**，current macOS acceptance **14/14**，报告 source revision 为 `6f63c3e`。该项只降低常见 final-file/root replacement route，不替代 descriptor-relative/reparse-safe directory、Apply/worktree、session-manager、file-level snapshot race、Windows 11、精确 `26.5.2` 或独立 G2 证据。

新增 Apply/worktree root binding 安全证据：`2c4215b` 对 Git worktree create/inspect/status/reset/clean/change 及 Apply Changes 的 source/target roots 做 identity 与 canonical-path recheck，并在 Git 命令、collision 检查、opened untracked file 和最终写入周围增加 fail-closed 校验；新增 worktree containment 与 target-root replacement 回归。全量 `npm run check` **241/241**，current macOS acceptance **14/14**，报告 source revision 为 `2c4215b`。该项降低常见 root replacement route，但不替代 descriptor-relative/reparse-safe directory、Git cwd/path atomicity、session-manager、file-level snapshot race、Windows 11、精确 `26.5.2` 或独立 G2 证据。

新增 non-Git snapshot file binding 安全证据：`88b60be` 为每个普通非 Git 快照文件打开 no-follow final-path handle，比较 opened handle 与前后 lstat 的 identity，并以 opened handle 的 size/mtime 记录快照；对象变化、变成 symlink、非 regular file 或无法安全打开时 fail closed。全量 `npm run check` **241/241**，current macOS acceptance **14/14**，报告 source revision 为 `88b60be`；标准扫描 `78bc305c-c0e7-4880-bd6a-d76954ddd465` 报告 4 个 open medium findings。该项关闭此前 low file-metadata race，不替代 descriptor-relative/reparse-safe intermediate directory、Git worktree、session-manager、Trusted Shell、Windows 11、精确 `26.5.2` 或独立 G2 证据。

新增平台 preflight 审计证据：当前 HEAD `b66a725` 的 `npm run acceptance:macos:baseline` 在 macOS `26.6.1` arm64 上生成 **0 passed / 0 failed / 1 blocked** 的 source-bound report，明确未执行精确 `26.5.2` acceptance；`npm run acceptance:windows` 在成功 build 后因当前主机不是 Windows x64 而停止，未产生 Windows acceptance。两者都不能替代目标平台证据；Windows 11、精确 `26.5.2`、平台 G2、签名和最终 V1 acceptance 仍待完成。

新增 workspace write handle-ordering 安全证据：`50074c2` 移除 `O_TRUNC` 的 pre-validation 使用，先对 opened regular-file handle 做 workspace identity/canonical 校验，再通过同一 handle truncate/write；Pi Adapter focused workspace/security regressions **48/48**、全量 `npm run check` **241/241**、current macOS acceptance **14/14**，报告 source revision 为 `50074c2`。标准扫描 `721c4ab5-ccdf-4052-9a28-b695323b3b70` 仍报告 4 个 open medium findings；该项是 defense in depth，不替代 descriptor-relative/reparse-safe intermediate directory、Git worktree、session-manager、Trusted Shell、Windows 11、精确 `26.5.2` 或独立 G2 证据。

## 2026-08-17 Issue #4 Pi-backed TUI journey checkpoint

- `456bab2` 新增 `smoke:tui:pi`：使用 Candy 生产 `PiAgentEngine` 和真实 Candy TUI 控制环，以 mock DeepSeek SSE 保持确定性；断言只访问 `https://api.deepseek.com/chat/completions`，Pi 响应投影到 TUI，任务/transcript 写入 Candy-owned SQLite/session storage，并扫描 session 内容确认 fixture credential 未进入持久化数据。
- 当前 macOS Tahoe `26.6.1` arm64 acceptance 通过 **10/10**；`npm run check` 通过 **197/197**，native gate、TUI credential presence-only、十轮 responsiveness、macOS TUI journey 和真实 PTY terminal matrix 均通过。该报告仍只代表当前 macOS 主机。
- Windows 11 x64 acceptance、精确 macOS `26.5.2` regression、平台 Trusted Shell G2、live provider cancellation、签名发布和最终 V1 acceptance 仍未完成；不得用本次 macOS 结果替代 Windows 或精确 baseline 证据。

## 2026-08-17 Issue #4 Pi-backed tool-loop checkpoint

- `737d7d7` 新增 `smoke:tui:pi:tool`：使用生产 `PiAgentEngine` 和真实 Candy TUI 控制环，以确定性 mock DeepSeek SSE 触发 `candy_write`，再完成第二次 provider turn；断言 approved DeepSeek endpoint、workspace 文件写入、TUI 工具事件、task/transcript/session 持久化及 session credential exclusion。
- 当前 macOS Tahoe `26.6.1` arm64 acceptance 通过 **11/11**；`npm run check` 通过 **197/197**，native gate、TUI credential presence-only、十轮 responsiveness、Pi text journey、Pi tool-loop journey、macOS TUI journey 和真实 PTY terminal matrix 均通过。该报告仍只代表当前 macOS 主机。
- Windows 11 x64 acceptance、精确 macOS `26.5.2` regression、平台 Trusted Shell G2、live provider cancellation、签名发布和最终 V1 acceptance 仍未完成；不得用本次 macOS 结果替代 Windows 或精确 baseline 证据。

## 2026-08-17 Issue #4 credential revocation checkpoint

- `34ae949` 新增 `smoke:tui:credential-revocation`：使用 Candy in-memory credential store、生产 `PiAgentEngine`、真实 TUI 控制环和确定性 mock DeepSeek SSE，不修改用户 Keychain；初始 provider turn 完成后执行 TUI delete，下一次 provider operation 返回 `needs_credentials`，且没有第二次 provider request。
- 该 smoke 同时断言历史 transcript 保留、Candy-owned session 不含 fixture credential。当前 macOS Tahoe `26.6.1` arm64 acceptance 通过 **12/12**，`npm run check` 通过 **197/197**。
- 该检查点只关闭当前主机 TUI credential revocation evidence；Windows 11 x64、精确 macOS `26.5.2` regression、平台 Trusted Shell G2、live provider cancellation、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 Pi coding review/restart checkpoint

- `a36aac4` 新增 bounded、sanitized workspace review metadata 的 Candy-owned SQLite 持久化；TUI 重启后可恢复 review 状态并继续显式 Apply，新 continuation 会清除旧 review 状态。
- `smoke:tui:pi:coding` 使用生产 `PiAgentEngine` 驱动 `candy_write`，执行 `:changes`、`:diff`、退出重启、`:transcript` 和 `:apply`；断言两个 approved DeepSeek request、task/transcript/tool evidence、workspace mutation、Git HEAD/index 不变和 session 无凭据。
- 当前 macOS Tahoe `26.6.1` arm64 acceptance 通过 **13/13**，`npm run check` 通过 **199/199**。Windows 11、精确 macOS `26.5.2` regression、平台 Trusted Shell G2、live provider cancellation、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 Pi provider cancellation checkpoint

- `54b54c1` 新增 `smoke:tui:pi:cancellation`：使用生产 `PiAgentEngine` 和真实 TUI 控制环，以确定性 DeepSeek SSE stream 发送 partial output；输入 `:cancel` 后观察 provider abort，并断言 task 为 `cancelled`、没有 false completion。
- 该 smoke 同时断言 partial assistant transcript 保留、仅有一次 approved domestic DeepSeek request，且 Candy-owned session 不含凭据。当前 macOS Tahoe `26.6.1` arm64 acceptance 通过 **14/14**，Node `22.23.2`/npm `10.9.8`，`npm run check` 通过 **199/199**。
- 该证据只代表当前 macOS 主机 TUI。Windows 11、精确 macOS `26.5.2`、平台 Trusted Shell G2、live-provider 完整门禁、签名发布和最终 V1 acceptance 仍未完成；不得用 macOS 结果替代 Windows 或 exact baseline。

## 2026-08-17 Issue #4 Candy prompt invocation checkpoint

- `961537a` 新增 `:prompts` 和 `:prompt <name> [args]`。模板只从 Candy-owned app-data 的 `prompts/*.md` 经过 restricted loader 读取；支持带引号参数及 `$1..$99`、`$ARGUMENTS`、`$@` 展开，并在未知模板、引号不闭合、控制字符、超长参数、空模板或凭据内容时 fail closed。
- 新增 TUI 回归覆盖模板列表、带空格参数、active secret 脱敏、未知模板和参数边界；固定 Node `22.23.2`/npm `10.9.8` 下 `npm run check` 通过 **201/201**。
- 该 checkpoint 只补齐 Issue #4 user story #27 的确定性实现证据；Windows 11、精确 macOS `26.5.2`、新 revision 的 live-provider 重跑、G2、签名和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 lifecycle projection checkpoint

- `a28606c` 补齐 TUI 的 provider retry 成功状态；retry 开始、成功/失败、compaction 开始/完成、`turn settled` 和最终完成现在按顺序可见。
- Pi Adapter 对已取消的 turn 在获取 credential lease 和发起 provider/session 之前 fail closed；新增 TUI/adapter 回归后固定工具链下 `npm run check` 为 **203/203**，当前 macOS acceptance 为 **14/14**。
- 该 checkpoint 是确定性实现证据，不替代 Windows 11、精确 macOS `26.5.2`、新 revision live-provider、G2、签名或最终 V1 acceptance。

## 2026-08-17 Issue #4 resource diagnostics checkpoint

- `236b2f2` 新增 TUI `:resources`，只输出 Candy-owned skills/prompts 的 bounded diagnostics（类别、类型、消息、路径），不输出资源正文或凭据。
- 回归覆盖 malformed skill frontmatter 和 duplicate prompt name；固定工具链下 `npm run check` 为 **204/204**，当前 macOS acceptance 为 **14/14**。
- 该 checkpoint 只补齐个人资源的用户侧诊断证据；Windows 11、精确 macOS `26.5.2`、新 revision live-provider、G2、签名和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 production Pi compaction checkpoint

- 新增 production `PiAgentEngine` fixture，覆盖 context overflow、compaction summary、continuation，以及 compaction provider request 未完成时的取消；取消路径返回 cancelled 且没有 false completion。
- 固定 Node `22.23.2`/npm `10.9.8` 下 `npm run check` 通过 **207/207**。Windows 11、精确 macOS `26.5.2`、native Trusted Shell G2、新 revision live-provider、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 live provider revalidation checkpoint (source `7f2d967`)

- 当前 revision 的 Candy-owned DeepSeek live Gate 通过 **7/7**，国内 MiniMax live Gate 通过 **8/8**；两者均覆盖取消、受控错误契约、session 无凭据扫描和 lease release，MiniMax 另覆盖图片与 thinking/tool replay。
- 报告位于 `out/acceptance/live/`，仅保留脱敏摘要并绑定 `7f2d967`。该 checkpoint 只关闭当前主机 provider revalidation；Windows 11、精确 macOS `26.5.2`、G2、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 historical live provider checkpoint (source `b23383a`)

- source revision `b23383a` 的 Candy-owned DeepSeek live gate 通过 **7/7**，使用批准的 `https://api.deepseek.com`，覆盖 streaming、tool/replay、cancellation、受控错误合同、session 无凭据扫描和 lease release。
- 同一 revision 的国内 MiniMax live gate 通过 **8/8**，使用 `https://api.minimaxi.com`，覆盖 text、image、thinking/tool replay、cancellation、受控错误合同、`LIVE-MM-05` 产品策略、session 无凭据扫描和 lease release。
- 脱敏报告保留在 `out/acceptance/live/`，不含 credential value、fingerprint、header、prompt 或 raw provider payload。该 checkpoint 只关闭当前主机 provider-path evidence；Windows 11、精确 macOS `26.5.2`、平台 Trusted Shell G2、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 current macOS native containment revalidation checkpoint (source `38775e2`)

- `npm run smoke:sandbox:macos` 通过 strict matrix：workspace guard 和 native runner 均拒绝外部/symlink/symlink-swap 读写、Git metadata/ref/reflog 写入及默认 loopback 网络；普通、脱离和 parent-exit 后代清理均通过，显式 network capability 单独可用。
- 这是当前主机 native implementation evidence，不是独立 G2 approval；Windows 11、精确 macOS `26.5.2`、签名发布和最终 V1 acceptance 仍未完成。

## 2026-08-17 Issue #4 clean-install checkpoint (source `fd070e1`)

- `npm ci --ignore-scripts` 在固定 Node `22.23.2`/npm `10.9.8` 下完成，lockfile 未变化、npm audit 报告 0 vulnerabilities，随后 `check:toolchain` 与 build 通过。
- 该 checkpoint 只关闭当前主机 ACC-TUI-01 安装/构建证据；Windows 11、精确 macOS `26.5.2`、G2、签名发布和最终 V1 acceptance 仍未完成。

当前接力规则：白天在 MacBook Pro 上优先实现、测试和记录当前 macOS Tahoe `26.x` Apple Silicon 能力；只有在声明精确兼容性时才运行 macOS `26.5.2` 回归基线。晚上在 Windows 11 PC 上只实现、测试和记录 Windows 专属能力。共享 TypeScript 改动先以当日 macOS 验证为准，Windows 兼容性改动留在晚间 Windows 清单中。任何一侧的结果都不得代替另一侧的验收证据。

## Windows 11 夜间接力（暂缓，必须在 Windows PC 上执行）

执行顺序：在 Windows PC 上先恢复本机确定性/原生检查和路径防逃逸，再完成 Windows 本地可用链路；需要凭据、Developer Mode、签名身份或外部服务时记录阻塞，继续推进其他 Windows 项。不得在 macOS 上执行或以 macOS 结果更新本节证据。

- ☑️ 修复平台路径适配：应用数据根路径根据传入的目标平台选择 `path.win32` 或 `path.posix` 语义，并覆盖跨宿主的 macOS/Windows 模拟测试。
  证据：Windows 11 确定性检查通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ☑️ 重构 Task Worktree 关联校验：结构化解析 `git worktree list --porcelain -z`，对路径进行规范化并精确比较，同时要求精确的锁定原因；不再使用模糊字符串匹配。
  证据：Windows Git 工作树创建、Apply、丢弃和重启交接 fixtures 通过；提交 `d4d38e489c5ded8d29a866f7034a06afce54a525`。

- ◐ 建立 Windows reparse-point 测试前置条件并验证防逃逸。
  已完成：普通 Windows 用户会话下的目录 junction 覆盖，确认 Pi 工作区边界拒绝经 junction 访问的外部文件；原生 runner 预检拒绝 workspace/cwd reparse component，并在本机 smoke 中拒绝真实 junction、完成 fixture 清理。
  当前未完成/阻塞：普通非管理员会话仍无法创建真实文件 symlink，2026-08-10 的探针返回“Administrator privilege required”；探针目录已从 `%TEMP%` 清理。当前合约通过注入 filesystem seam 保留文件 symlink 拒绝断言，真实 symlink、其他 reparse point、运行期 race/path escape 和清理流程矩阵仍需 Developer Mode 或等效授权。

- ☑️ 在干净依赖目录重跑完整门禁、TUI/App Server smoke 与原生检查。
  证据：`npm ci --ignore-scripts` 后 `npm run check`（93 个测试）以及 TUI/App Server smoke 通过；Windows `npm run check:native` 以退出码 0 通过。Rust 编译器仍报告未使用代码警告，不影响检查结果；Windows G2 的实际 Job Object 与安全验收仍单列为未完成项。

- ◐ 将 `G0-WIN` 更新为 Windows 验收进行中，并执行 Windows 确定性矩阵。
  已完成：已确认当前主机为 Windows 11 Pro x64，`G0-WIN` 已更新为 `In progress`。
  已完成：当前 HEAD 的 ACC-12 Windows 确定性子集完成 10 轮测量：TUI cold start p95 `905 ms`（目标 <= `2000 ms`），Desktop cold start 到 task-list smoke p95 `1370 ms`（目标 <= `5000 ms`），Runtime event 到可见 Desktop projection p95 `1 ms`（目标 <= `200 ms`），用户取消到任务进程树终止 p95 `12 ms`（目标 <= `5000 ms`），Browser Take Control 到禁用 agent action p95 `1 ms`（目标 <= `500 ms`），三任务并发 renderer frame gap p95 `17 ms`（目标 <= `1000 ms`）且 10 轮 `9/9/9=>9/9/9` 无事件丢失；脱敏报告为 `out/acceptance/windows/responsiveness-latest.md`，由 `.gitignore` 排除。
  待完成：Provider stream stop、完整 UI/recovery、物理 Browser input-origin、完整 ACC-12 指标，以及 ACC-01、ACC-02、ACC-05、ACC-06、ACC-08、ACC-11 的完整 Windows 矩阵。

- ◐ 完成 Windows G2：Job Object 所有权、完整后代进程取消、命令无网络/工作区隔离、Windows reparse 防逃逸与安全评审。在验收前，Windows Shell Auto 和 Shell Auto Debug 必须保持禁用。
  已完成：Rust runner 以 suspended process 创建后先加入 Job Object，设置 `KILL_ON_JOB_CLOSE` 后恢复；Windows native smoke 通过正常完成、`network:true` fail-closed、workspace 逃逸、junction reparse 拒绝和 runner 取消后的后代清理；app-server 已接入 Windows `.exe` runner/validator 路径，独立 user-cancel smoke 也验证了任务取消后的 validator 后代清理。
  已完成：runner 在 `CreateProcessW` 解析后、`ResumeThread` 前重新 canonical 校验 workspace/cwd/executable 并比对身份，关闭启动 TOCTOU 窗口；缺失 executable 与符号链接 executable 被拒绝；子进程超大输出截断至 1 MiB；native smoke 新增 missing-executable 与大输出负向 fixture。
  未完成条件：`network:true` 拒绝只是协议/策略边界，不等于命令的 OS 级无网络；尚未完成任意命令的 OS 级 workspace ACL/AppContainer containment、post-resume 运行期 reparse/race 防逃逸、签名/正式发布打包路径和独立安全评审。Shell Auto 与 Shell Auto Debug 继续禁用。

- ◐ 验收 Windows Browser Workspace：打包 Electron 中的 `WebContentsView`、站点授权、观察版本、防陈旧操作、Take Control、下载和对抗性页面测试。
  已完成：packaged Windows fixture 通过 allowlist 后加载本机页面，阻止不允许的 redirect、popup、permission 和 download，并验证显式 Take Control/return-to-agent revision；对凭据 URL、非 loopback HTTP、script URL、未授权 host、畸形 structured action、缺失 selector 和错误 target 做 fail-closed 检查；Browser profile 使用 Candy-owned persistent partition，页面没有 Candy preload 或 provider credential。
  已完成：packaged fixture 通过窄桥接执行 selector-scoped click/type/confirmed-submit，拒绝未确认 submit、stale revision、NUL/非法 CSS selector 和 Take Control 后的 user-owned action；截图写入 Candy AttachmentStore，snapshot 只返回不透明 `att_...` id。当前实现继续使用 ADR-0006 的显式 Take Control fallback。
  已完成：packaged Windows fixture 现包含 macOS 同等的对抗性页：prompt-injection 文本按不可信内容观察且 trap 未被自动触发、同 revision 双导航竞态只接受一个 revision-fenced 请求（slow 命中）、Take Control 后的冲突 action 被拒绝，且页面 marker 未进入 packaged stdout/stderr、app-server JSONL stdout 或 Candy 自有 session/state/协议数据（仅浏览器 profile/partition 缓存按设计保留页面数据）。
  已完成：下载策略改为默认拒绝但状态可见，用户对已授权站点单次确认后保存到 Candy app-data `downloads/`（文件名净化），提供 `browser.downloads()`/事件展示 denied/completed/failed 状态，绝不自动打开或进入模型上下文；packaged Windows smoke 验证确认下载落盘且内容不含页面 marker。
  待完成：可靠的物理输入来源识别；完整 ACC-09/ACC-12 Browser 指标仍未完成。

- ◐ 补齐 Windows 长运行/Auto Debug：用户 steering、审批等待、最终证据摘要及 Windows 原生 validator 集成。
  已完成：有界 Auto 执行、用户 `task.cancel`、停止原因、持久化进度、暂停/恢复、崩溃中断和 Desktop 进度投影的确定性覆盖；Windows Job Object validator 已接入 app-server，独立 Windows smoke 验证用户取消会终止 validator 及其后代进程，延迟 marker 未写入。
  已完成：新增 `smoke:desktop:packaged:long-running:windows`，packaged Windows Desktop 现通过真实 approval 等待（`waiting_approval` + 正确 approvalId）、steering 下一轮、validator-only 完成、最终证据摘要（`validator-pass`）与 renderer 投影；该步骤已接入 `npm run acceptance:windows`。
  待完成：OS 级命令 containment、安全评审、签名后打包证据与真实 Provider 取消延迟。

- ◐ 补齐 Windows ACC-03 核心编码旅程与重开 transcript。 已完成：SQLite schema v10 新增 `task_transcripts`，app-server 持久化 user/assistant/tool 有界 transcript 并在 snapshot 中恢复；修复 Desktop app-server 重启时旧进程 exit handler 清空新 child 的竞态；新增 packaged Windows coding-journey smoke（create → 流式 → 编辑 → validator → diff 审查 → Apply → 重启后完整 transcript 恢复），验证本地变更未提交、Git index 未动、无 commit。 待完成：真实 DeepSeek/MiniMax 驱动的 ACC-03/04 live 旅程与签名 Desktop 复验。

- ◐ 在用户明确授权并预先配置 Candy 自有凭据后，于 Windows 执行 DeepSeek `LIVE-DS-01..04` 与 MiniMax `LIVE-MM-01..04`；`LIVE-MM-05` 按产品策略默认 Pass，不等待控制台 entitlement、额度或扣减确认。
  已完成：DeepSeek 已通过 Windows 本机 Gate 的全部 7 项：`LIVE-DS-01..04`、取消、受控 401/429/超时、无密钥会话扫描和密钥租约释放。只访问 `https://api.deepseek.com`；脱敏本地报告为 `out/acceptance/live/deepseek-latest.md`，由 `.gitignore` 排除。
  已完成：经用户授权的脱敏读取确认 Claude Code 已声明 MiniMax，配置模型标识为 `MiniMax-M3[1M]`，认证信息存在，且端点为 `https://api.minimaxi.com`；未读取或复制 Token。此项仅为发现证据，Candy 没有 Claude Code → MiniMax 自动导入器。
  待完成：MiniMax Windows live Gate。Claude Code/OpenCode 配置均不作为自动凭据来源；Windows 结果也不能替代 macOS 的独立证据。

- ◐ 完成 Windows Credential Manager、桌面打包、签名、恢复和响应性矩阵。
  已完成：Desktop 凭据输入框按运行平台显示存储位置；Windows 显示 `Windows Credential Manager`，macOS 显示 `macOS Keychain`，并有独立合同测试；Candy 自有 Windows Credential Manager 适配器的合成 fixture 已完成 `absent -> present -> present -> absent`（set/replace/has/delete），未输出或读取 fixture 值；在用户提供的已验证 Electron `43.2.0` Windows x64 本机运行时下，设置 `$env:ELECTRON_OVERRIDE_DIST_PATH` 后执行 `npm run smoke:desktop` 通过，输出 `desktop app-server JSONL smoke ok`；真实 app-server 子进程重启后 queued metadata 与 active owner crash interruption 快照恢复 smoke 通过。
  已完成：新增 packaged Windows Desktop credential-isolation smoke：将 fixture 值经可信 IPC 写入 MiniMax 空账户后，renderer 尝试 `has`、枚举 `window.candy`/`credentials` 键与属性名，均无法观察到完整值；随后删除并验证 `absent`，fixture 值未出现在 packaged 进程输出中。
  已完成：从已验证的 Electron `43.2.0` Windows x64 目录生成 `out/windows/Candy` 未签名开发包，嵌入 Node `v22.23.2`、app-server 和 Windows native runner；`npm run smoke:desktop:packaged:windows` 通过，输出 `packaged unsigned Windows Desktop app-server JSONL smoke ok`；随后使用包内 `resources/node/node.exe` 和 bundled keyring addon 完成 packaged Credential Manager synthetic lifecycle smoke，DeepSeek presence 保持不变。
  待完成：DeepSeek Candy 账户本次已存在，smoke 未触碰该真实账户；对该固定账户补做替换/删除需要用户授权的可恢复测试窗口或专用空账户。Windows 正式安装/下载、签名和完整响应性矩阵仍未完成；active validator interruption、用户取消、owner crash interruption、non-owner read-only fencing、attachment restart recovery、bounded three-slot concurrency、packaged active-owner/tool recovery 和 packaged sequential cross-client handoff 已有本机 smoke 证据。该开发态 smoke 不替代 Windows 签名、恢复或完整 Desktop 验收。

- ☑ 重新生成当前提交的 Windows 验收证据。
  已完成：在干净提交 `b7cab12a8ecfd18d46c2813653e19dd978143ee4` 上执行 `npm run acceptance:windows`，22/22 个确定性/native/packaged 步骤通过，包含 queued/active crash recovery、用户取消长运行 validator、attachment restart recovery、non-owner read-only fencing、bounded three-slot concurrency、未签名 packaged Desktop、packaged active-owner/tool recovery、packaged sequential cross-client handoff、packaged coding journey/transcript recovery、扩展后的 Browser action/security fixture 和 packaged Credential Manager fixture smoke；脱敏报告为 `out/acceptance/windows/latest.md`，由 `.gitignore` 排除。
  ACC-12 确定性子集本次全部通过：TUI/Desktop cold start p95 `905/1370 ms`，Runtime projection `1 ms`、取消终止 `12 ms`、Take Control `1 ms` 与三任务并发 frame gap `17 ms`，10 轮均 `9/9/9=>9/9/9` 无事件丢失；完整 ACC-12 仍要求真实 Provider 取消延迟与完整 UI/recovery 证据。
  未完成：报告仍明确保留 Windows 签名/正式安装、真实 Credential Manager 完整生命周期、完整 Browser physical input-origin/ACC-09、完整 G2 OS containment、安全评审、live MiniMax/Token Plan、完整 ACC-01..12 和 product-owner acceptance 阻塞；不可替代完整 Windows 验收或跨平台结果。

- ☑ 完成签名独立部分的 Windows release 打包/校验脚本（`package:desktop:windows:release`、`verify:desktop:windows:release`）：`node --check`、Prettier 与 `git diff --check` 通过；正式签名安装/升级/回滚/卸载仍因签名身份缺失而 Blocked。

## macOS 白天主动队列：当前 macOS Tahoe `26.x` Apple Silicon

- ☑️ 2026-08-14 Issue #3 macOS TUI Personal Preview 在 source revision `9c5afadb74895de9c688445b4889773de873d34a` 完成 G2 source review 后启用：normal composition root 仅在 macOS arm64 注入能力；用户仍须显式选择 Auto、开启 Trusted Shell，并使用 Git-backed Candy Task Worktree。普通命令离线自动执行，网络命令逐条审批，publication/外部动作 fail closed；Desktop、Windows 和 Shell-based Auto Debug 继续禁用或单独 gated。标准安全扫描覆盖 168 个文件、0 reportable findings；current-host macOS `26.6.1` acceptance 21/21、`npm run check` 178/178、Rust 7/7、DeepSeek live 7/7、真实 Provider/Pi journey 3 次、dogfood 3/3（安全失败 0）和真实 PTY matrix 均通过。精确 `26.5.2`、Windows、签名和最终 V1 仍未声明。
- ◐ macOS TUI Trusted Shell Auto Personal Preview 已完成实现路径（ADR-0010），但正常 composition root 仍保持 capability flag off，等待独立 macOS G2 review：只有显式开启、Auto profile、Git-backed Candy Task Worktree 三项同时满足时，任务才持久化 Trusted Shell capability。普通 `candy_bash` 通过 native runner 离线自动执行；需要 outbound network 的完整命令必须通过独立 `candy_bash_network` 工具逐次审批，拒绝、取消、超时、TUI 退出和 owner loss 均不重放；真实 linked Worktree 的 Git status 可读且 Git HEAD/ref/reflog metadata 写入被 native profile 拒绝。`npm run check` 171/171、Rust 7/7 通过；native runner 另有父进程被杀后的延迟后代清理 smoke。证据所绑定的实现 revision `fb400aa` 在 macOS `26.6.1` arm64 真实终端矩阵覆盖中文 UTF-8 输入、括号粘贴、resize、启动/运行时失败恢复和 Ctrl+C，矩阵扫描完整临时 Worktree/app-data/PTY fixture；三次 clean real-PTY/DeepSeek Flash journey 通过，三类 dogfood（理解、小修复、失败测试诊断）3/3 且安全失败 0。TUI deterministic recovery tests additionally cover approval settlement on exit, stale approval rejection after restart, and dead-owner no-replay recovery；默认 TUI composition root 的回归测试确认 G2 未启用时仍拒绝 Trusted Shell；当前实证仍不等于 OS-level IME composition。未完成条件：精确 `26.5.2` regression、独立 G2 security review、Windows parity、签名和最终 V1 acceptance；Windows Trusted Shell Auto 继续禁用。
- ☑️ 2026-08-14 修复 current HEAD `aea91a6d3fcd9a0eb09ea2dac2460808747dd1b7` 的 Trusted Shell 凭证脱敏遗漏：TUI 在完整 turn 内保持 active provider leases，并将全部 active secrets 传到 Pi adapter；adapter 去重后配置 Native Runner redaction。`npm run check` 172/172、当前 macOS `26.6.1` acceptance 21/21、新 security diff scan 17/17 items 且 0 findings；三次真实 Provider/Pi journey、dogfood 3/3（安全失败 0）和真实 PTY terminal matrix 均通过。该项只更新 macOS Personal Preview implementation evidence，不解除独立 G2、精确 `26.5.2`、Windows、签名或最终 V1 门槛。
- ◐ 2026-08-14 独立 macOS G2 security review 已完成首轮标准扫描，但发现 3 个高危、2 个中危问题：脱离进程组的后代可在正常命令完成后继续运行，Pi 文件读取可把 active provider secret 带入会话，Trusted Shell 未在 spawn 前阻断 `git commit/push`；另有 approval owner fence 与 Desktop attachment secret screening 缺口。当前 macOS 仅保留 default-off Personal Preview implementation path，须完成修复、重跑当前 host/精确 `26.5.2` 与 Windows 相关矩阵并重新接受 G2 后，才能讨论正常 composition root enablement。

- ☑️ macOS 验收环境已拆分：默认 `npm run acceptance:macos` 以当前 Tahoe `26.x` arm64 主机为 primary（当前主机为 `26.6.1`，最低保留 `26.5.2`），精确 `npm run acceptance:macos:baseline` 作为 `26.5.2` 兼容性回归。两者报告分离，current-host 运行不再因缺少旧版本主机而 preflight 阻断；这不等于跨版本行为自动兼容或最终 V1 Pass。

- ☑️ TUI 同一任务连续对话已接入：普通输入默认继续 current task，`:new [prompt]` 创建新任务，`:use <task-id>` 选择已持久化任务，`:tasks` 显示 current 标记、状态、模型、workspace、revision 和队列位置；TUI 通过 Candy-owned SQLite 恢复控制器和有界脱敏 transcript，并将稳定 task id 继续传给同一 Pi session 路径。active owner 重入、取消任务继续、stale revision 与 non-owner 控制均 fail closed。测试先行后 `npm test` 通过 144/144。此项仍不替代 macOS/Windows 真终端、跨客户端恢复、live provider 或完整 ACC-03/05/11 验收。

- ☑️ TUI 工作区浏览/搜索已接入：Candy 自有 `candy_list` 与 `candy_search` 通过 Node 文件系统 API 提供有界目录列表和 literal UTF-8 文本搜索；Read-only/Auto 两个 profile 都只开放这两个只读能力，未开放 Shell、`rg` 或 Pi builtin。路径 containment、symlink/reparse-style fail-closed、控制/非法编码、Candy app-data/依赖缓存排除、二进制跳过、取消、输出/行/文件上限和活动 secret 脱敏均有测试。此项仍不替代真实 macOS/Windows 终端、G2、Shell Auto、完整 ACC-03 或最终 V1 验收。

- ☑️ TUI 工作区选择已接入：`:workspace [absolute-path]` 展示当前默认目录，拒绝相对路径、控制字符、缺失路径和非目录，支持带空格的绝对路径，并在选择后 canonicalize；它只影响后续 `:new`，已存在任务继续使用其持久化 workspace。任务创建会先快照 workspace，再异步保存 baseline，避免切换竞态。TUI 单测和当前 macOS Tahoe `26.6.1` arm64 的真实 PTY journey 均覆盖该入口；这不是 macOS `26.5.2` 正式验收 Pass。

- ☑️ TUI 文件增删改查已接入：启动仍为 Read-only，`:profile auto` 为后续任务开放 `candy_read`、`candy_edit`、`candy_write` 与 `candy_delete`；删除逐次要求 `:approve <id>` / `:deny <id>`，并拒绝越界、symlink、目录、控制字符路径和审批期间目标变化。固定 Node `22.23.2`/npm `10.9.8` 下 `npm run check` 139/139、native check 与两个 TUI smoke 通过。此项不包含 Shell、validator、diff UI、模型/图片选择或完整 ACC-03。

- ☑️ TUI 变更审查与显式 validator 已接入：任务创建时保存 workspace baseline，`:changes` 展示 tracked/untracked/removed，`:diff [path]` 做安全路径过滤并将渲染限制为 64 KiB；`:validator <absolute-executable> [args]` 与 `:validate` 通过 Candy native runner/Runtime `CommandValidator` 执行，支持 pass/fail/cancel/timeout、bounded redacted evidence 和 native unavailable blocked。无自动 Apply、stage、commit、push，Shell 仍禁用。Node `22.23.2`/npm `10.9.8` 下 `npm run check` 150/150、`check:native`、TUI/App Server/safe-edit smoke 和 `git diff --check` 通过。此项不替代真实 macOS/Windows 终端、G2、live provider、完整 ACC-03/05/11 或最终 V1 验收。

- ☑️ TUI Git Task Worktree / Apply / Discard 已接入：Auto Git 任务先在 Candy app-data 下创建并持久化锁定 Worktree，Pi turn、恢复、validator 和 diff 均不直接改 Local；`:apply` 仅在 completed/ownerless 且用户依次查看当前完整 `:changes` 与未截断全量 `:diff`（含 untracked 文本内容；untracked binary fail-closed）后可用，并在 transfer 前重新检查/指纹比对；`:discard` 只清理 Candy-owned Worktree。Apply 同时阻断 active DeepSeek/MiniMax credential 出现在路径、tracked patch 或 untracked 文件字节中；native 两层凭证形态检测不会再把 `task-<id>` 中的内部 `sk-` 误判为凭证。根目录新增 `npm run tui`；`npm run check` 160/160、Rust 6/6 和当前 macOS `26.6.1` real-PTY 的 validator → 完整审查 → Apply → restart journey 通过。Shell/Auto Debug 仍等待 G2，未据此宣称 Windows、签名或最终 V1 Pass。

- ☑️ TUI 显式模型/图片附件已接入：`:model` 支持 `deepseek-flash`、`deepseek-pro`、`minimax-m3` 并将 canonical id 持久化到任务；活动/排队任务禁止换模，MiniMax M3 使用独立 provider engine，DeepSeek 图像 turn 不自动 fallback。`:attach <absolute-path>` / `:attachments` 复用 Candy-owned AttachmentStore，仅将 attachment id 与有界元数据放入任务状态；workspace/Candy app-data、symlink、video、unsupported MIME、超大/损坏图片和 credential-bearing 内容均拒绝，MiniMax image attachment 可在重启后恢复。Node `22.23.2`/npm `10.9.8` 下 `npm test` 155/155，Pi typed-image/domestic-endpoint/no-fallback 与 provider 错误脱敏契约通过。此项仍不替代真实终端、完整 Desktop attachment UX、live MiniMax/Token Plan、G2、完整 ACC-03/04/11 或最终 V1 验收。

- ☑️ TUI provider 失败恢复已接入：Pi `ProviderContractError` 仅映射为固定脱敏类别；中断任务显示 `:resume <task-id>`、显式 `:model` 和 `:cancel <task-id>`，paused/interrupted 任务可显式取消且不自动重放。Node `22.23.2`/npm `10.9.8` 下 targeted TUI provider-recovery test 通过；当前-host runner 与精确 `26.5.2` baseline runner 已分离，分别记录各自平台证据。

- ◐ TUI Personal Preview 真实 PTY 旅程：新增 `:transcript [task-id]` 和 macOS Expect-backed PTY smoke；当前 macOS Tahoe `26.6.1` arm64 从工作区父目录启动后，通过 TUI 选择带空格的 workspace，完成两轮同任务编码、Candy workspace tools、逐次删除审批、MiniMax M3 图片、changed files/diff、显式 native validator、退出重启恢复和 terminal cleanup，并验证 Git index/HEAD/commit、workspace 外 sentinel 与 PTY/app-data/diff/Expect stdout-stderr 敏感证据边界不变；当前-host runner 可在此运行，精确 `26.5.2` baseline runner 需在对应主机上重跑；不替代 Windows、live provider、G2 或最终 V1 证据。

- ☑️ 修复 macOS Git Task Worktree 关联校验：原生路径比较现在通过 `realpath` 解析 `/var` 与 `/private/var` 的 canonical-path alias；跨宿主 Windows fixture 显式注入 `path.win32`，不再使用 macOS POSIX 语义。Worktree 根目录仍使用 lexical containment，锁定原因仍要求精确匹配，且新增 macOS alias 与跨宿主回归覆盖。已发布提交 `91f4f12d3d6b92d2d657d341ff14c14ef3482369` 在干净工作树上通过 `npm run check`（94/94 tests）和 `npm run acceptance:macos`（9/9 deterministic/native/Desktop steps）；报告为 `out/acceptance/macos/latest.md`，未运行 live provider。

- ◐ 在 Worktree 基线恢复后，已发布提交 `261bb346f12b6c28288a292db5bf77e26d531127` 的工具链、Runtime/session-remap、TUI、Desktop App Server、Worktree/Apply、源 app-server 恢复、packaged Node/app-server 恢复、packaged Browser adversarial 子集和 ACC-12 cold-start 子集确定性 smoke 通过；干净 macOS acceptance 为 14/14，TUI p95 `878 ms`、Desktop p95 `1693 ms`，报告 source revision 为该提交。恢复证据覆盖 queued 元数据、owner interruption、`crash_interrupted` 快照和 macOS validator 后代清理；ACC-12 其余指标、物理输入归属、完整 UI/跨客户端恢复、完整 Browser 矩阵、签名和完整 macOS 接受矩阵仍待完成。
- ◐ macOS packaged sequential cross-client handoff 已完成确定性覆盖：第一个 packaged app-server 在 validator 运行中暂停到 revision `2` 并释放 owner，macOS validator 子进程清理窗口后无残留 marker；第二个 packaged app-server 从相同 Candy-owned SQLite 状态拒绝 stale revision `1` resume，保持 ownerless paused revision `2`，只能显式 resume 到 revision `3`，执行第二次 validator invocation，再在 revision `4` 取消并验证后代清理。未迁移 in-flight tool call。该 smoke 已加入 macOS acceptance，当前 expanded runner 为 16/16；完整 UI/ACC-05 恢复、签名、物理 Browser 输入归属、完整 ACC-12、G2、live provider 和 product-owner acceptance 仍未完成。

- ◐ macOS Sandbox Runner 严格 fail-closed 修复 checkpoint：default-deny Seatbelt profile 已 canonicalize workspace/cwd/executable，支持合法 validator，并阻断工作区外读写、symlink 读写、`lstat` 后 symlink-swap 越界；loopback network deny、普通/脱离后代取消与正常完成回收、provider credential request/child isolation 也通过。相关 packaged validator fixture 的 marker 已收回任务 workspace。该 checkpoint 不等于 G2：独立 security review、签名/打包、Windows OS containment、跨平台证据仍 Blocked，验收前继续禁用 macOS Shell Auto 和 Shell Auto Debug。

- ◐ macOS Keychain fixture、打包 Desktop JSONL、packaged Node/app-server recovery 已通过；仍需 OS Keychain 完整受控生命周期、Apple 签名/公证、完整 Desktop/UI 恢复和未覆盖的 ACC-12/Provider 指标。

- ◐ macOS packaged Browser 本机 fixture 已通过 allowlist、typed click/type/confirmed-submit、URL credentials、恶意/NUL/oversized selector、stale revision、disallowed redirect/popup/permission/download default-deny、截图 attachment id，以及显式 Take Control 后的 user ownership。source revision `951283bd4c8f3c0ae8778ab50bd6ed4044f436e7` 还通过提示注入文本不触发 trap、同 revision 双导航竞态只接受一个请求，并扫描 packaged 输出、app-server JSONL stdout 与 Candy 临时 app-data 未出现页面 marker。物理输入来源不可可靠判定，仍保留显式 Take Control fallback；更广 hostile-page/navigation、live Provider/session/protocol、完整 ACC-09/ACC-12 矩阵仍待完成。

- ◐ 补齐 macOS ACC-12 可测确定性指标：`measure:macos:responsiveness` 已执行十轮真实 Desktop event/projection、用户取消到 validator 父子进程树终止、显式 Take Control 后 agent action 禁止，以及三任务并发 frame-gap/event delivery。已发布 source revision `d9a0fe2` 的 `out/acceptance/macos/responsiveness-latest.md` 记录 p95 `2/12/2/19 ms`，三任务十轮均 `9/9/9=>9/9/9` 且无 event loss；TUI/Desktop cold p95 为 `983/2053 ms`，完整 `acceptance:macos` 为 15/15。Provider stream stop、完整 UI/recovery/Windows parity 和完整 ACC-12 仍 Blocked，Shell Auto 与 Shell Auto Debug 保持 disabled。

- ☑️ 在同一套 Candy 自有凭据路径下重跑 macOS 的 DeepSeek/MiniMax Live Provider Gate；不得以 Windows 结果替代 macOS 证据。
  证据：macOS DeepSeek Gate 于 `e3449a5` 7/7 通过；MiniMax Gate 于 `44be499` 7 通过 0 失败（LIVE-MM-01 文本、LIVE-MM-02 图片理解、LIVE-MM-03 思考/工具回放、LIVE-MM-04 取消与受控 401/429/超时错误契约、secret 检查全部通过）。LIVE-MM-05 按产品策略默认 Pass，不要求控制台 entitlement、额度、余额或扣减确认；`G0-LIVE-MM` 为 Pass。

## 跨平台收尾：Windows 与 macOS 均完成后

- ⬜ 对照 ACC-01 至 ACC-12 汇总两个平台的精确构建、版本、脱敏证据和未决项；任何一侧 `Blocked`、`Fail`、P0 或 P1 均阻止 Candy V1 Release 声明。

- ⬜ 重新生成当前提交的全量验收证据，替换仍指向 `0710d00` 的旧报告，并更新 macOS 基线表述。

## 已追加的实现检查点

- ☑️ 持久化排队任务重排：SQLite 在立即事务内保存重排后的连续队列位置；协议和 App Server 支持受限的 `task.reorder`；TUI 提供 `:prioritize <task-id>` 并显示队列位置。
  证据：92 个确定性测试、TUI/App Server smoke 通过；提交 `a556df122c2759049b9803e2e9df46bc8b6896d8`。跨进程恢复和 Desktop 队列面板仍是后续工作，未在此项宣称完成。

- ☑️ Windows 凭据界面平台标识：Windows Desktop 不再错误提示 `macOS Keychain`，而是显示 `Windows Credential Manager`；非 Windows 平台保留准确的系统存储标签。
  证据：Windows `npm run check` 93/93、`smoke:tui-task` 和 `smoke:app-server` 于 2026-08-10 通过。该 UI 修正不替代真实 OS 凭据存储或 Desktop 启动验收。

## 2026-08-13 Windows Personal Preview checkpoint

- WP1 Pi Bash adapter: implemented and deterministically verified with Pi `0.84.1`; live execution remains fail-closed because the fixed Git Bash path is absent on this host.
- WP2 Trusted Shell approval: implemented as an explicit Auto-only task capability with bounded command/cwd/timeout approval, deny/cancel/restart no-replay behavior, and credential rejection before approval/spawn.
- WP3 Task Worktree: implemented and covered by Git fixture review/Apply/Discard tests; non-Git Personal Preview tasks are rejected before Worktree creation.
- Verification: TypeScript build plus `scripts/run-tests.mjs` passed 136/136. This is not a complete G2 or Windows V1 release claim.
