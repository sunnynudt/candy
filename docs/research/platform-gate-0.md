# Candy V1 Platform Gate 0：macOS / Windows 11 平台兼容性研究

- 状态：技术方案条件通过，存在阻断项
- 核查日期：2026-08-09
- 范围：研究与实施规划；本文件不包含产品代码
- 目标基线：macOS Sequoia 15+、Windows 11、Electron Desktop、packaged Node 22 app-server / TUI

> 后续决策（2026-08-09）：Candy 已接受 macOS Sequoia 15+、一个仅承载 OS 隔离与 Windows Job Object 所有权的窄 Rust Sandbox Runner，以及自动接管不可可靠验证时的显式 Take Control 回退。原生后端、进程树、打包和安全测试仍须通过本报告定义的 Gate；接受实现方向不等于验证已经完成。

## 1. 结论摘要

Candy V1 可以继续进行非 Shell 能力的技术设计和编码实施规划，但不能按当前证据宣称已经具备“Codex 级本地命令强沙箱”。浏览器、凭据、任务元数据、Git worktree 均有可落地的官方能力或仍在维护的窄依赖；命令隔离和 Windows 子进程树可靠回收仍需单独过 Gate。

| 领域 | Gate 结论 | 精确选择 |
| --- | --- | --- |
| 可见 Browser Workspace | 条件通过 | Electron `WebContentsView` + Candy-owned persistent `Session` + `webContents.debugger`；不把 Playwright、agent-browser 或 browser-use 放入 V1 运行时核心 |
| Electron 安全基线 | 通过 | 沙箱化 renderer、`contextIsolation: true`、`nodeIntegration: false`、窄 preload/contextBridge、默认拒绝导航/新窗口/权限 |
| 模型 Shell 命令沙箱 | **阻断** | 目前没有被官方合同覆盖、可直接复用且同时可靠支持 macOS/Windows 11 的 Node/Electron 方案；不得用 workspace guard + approval 冒充强沙箱 |
| OS credential store | 条件通过 | `@napi-rs/keyring@1.3.0` 置于 `CredentialStore` Adapter 后；`keytar` 不采用 |
| 进程生命周期 | 条件通过 | Node `child_process` + `ProcessSupervisor`；Windows 必须补 Job Object 级进程树所有权能力 |
| app-data / 文件锁 | 通过 | Electron `app.getPath()`；锁和数据库仅放本机 app-data，不放仓库或网络文件系统 |
| 任务元数据 / FIFO / execution lease | 条件通过 | 以 app-server/TUI 的 Node 22.23.2 `node:sqlite` 为首选；Electron main 不直接访问数据库，采用前完成双平台恢复验证 |
| Git worktree | 通过 | 直接调用 Git CLI 参数数组；使用 `git worktree` 的稳定 porcelain 合同，不解析 `.git/worktrees` 内部文件 |

### Gate blockers

1. **PG0-SBX-01 — 强 Shell 沙箱缺失。** 在本研究限定的官方资料和官方仓库中，没有找到可直接复用的、稳定的跨 macOS/Windows 11 Node/Electron 命令沙箱合同。Shell-enabled Auto 和依赖 Shell 的 Auto Debug 在解决前不得按强沙箱模式发布。
2. **PG0-PROC-01 — Windows 进程树回收。** Node 的 `kill()` 不是“终止整个后代进程树”的合同。长任务、取消、退出清理需要 Windows Job Object 或等价的、仍受维护的原生能力。
3. **PG0-BROW-01 — 自动 user takeover 事件来源。** Electron 的输入事件结构没有公开的“物理用户输入 / CDP 合成输入”来源字段。必须在打包应用中验证；若不能可靠区分，V1 必须使用显式“接管控制”按钮，不能声称自动即时接管。
4. **PG0-DATA-01 — `node:sqlite` 运行拓扑验证。** `node:sqlite` 在目标 Node 22.23.2 中仍为 Stability 1.1 — Active development。采用前必须在 TUI 和 packaged Desktop app-server 两种 Pi-compatible 拓扑中通过导入、并发、崩溃恢复及打包测试；Electron main 只通过协议访问 app-server 投影。

## 2. 研究方法和版本基线

本研究只使用以下来源：操作系统厂商文档、Electron/Node.js/Git/SQLite 官方文档，以及被评估开源项目自身的官方仓库。没有读取或复制无关本地仓库内容。

可变事实均在相应条目旁提供直接链接和核查日期。技术建议不是上游承诺；它们是基于已核实合同对 Candy V1 的选择。

### 2.1 参考版本

**事实**

- 2026-08-09 时，Electron 官方稳定发布页列出的最新版本为 **43.2.0**，内含 Chromium 150.0.7871.129、Node.js 24.18.0；Electron 43 的计划 EOL 为 2027-01-05。[Electron 43.2.0 release](https://releases.electronjs.org/release/v43.2.0)、[Electron release schedule](https://releases.electronjs.org/schedule)（核查：2026-08-09）
- Electron 43.2.0 的官方 `DEPS` 固定 Node `v24.18.0`。[electron/electron v43.2.0 DEPS](https://raw.githubusercontent.com/electron/electron/v43.2.0/DEPS)（核查：2026-08-09）

**建议**

- Desktop shell 的可复现基线固定为 Electron 43.2.0 / embedded Node 24.18.0；Agent Runtime 单独固定为 packaged Node 22.23.2。真正开始发布构建时，升级到当时仍受支持的 Electron patch，并重新跑本文件的兼容性矩阵。
- TUI 与 Desktop app-server 使用相同的 Node 22.23.2 和 `node:sqlite` 合同；Electron main 不直接打开任务状态库。

**风险**

- Electron 的 Chromium/Node 升级遵循 Electron 自己的 SemVer 映射；Electron major 升级可带来 Node major 和 Chromium 变更。[Electron versioning](https://www.electronjs.org/docs/latest/tutorial/electron-versioning)（核查：2026-08-09）
- 此处固定的是研究基线，不是永久版本承诺。若编码开始时间明显晚于本核查日期，应先刷新本节。

## 3. 可见 Browser Workspace

### 3.1 Electron 原生能力

**事实**

- `BrowserView` 已弃用，官方要求迁移到 `WebContentsView`；Electron 官方迁移说明称该弃用从 Electron 30 开始。[BrowserView](https://www.electronjs.org/docs/latest/api/browser-view)、[Migrating from BrowserView to WebContentsView](https://www.electronjs.org/blog/migrate-to-webcontentsview)（核查：2026-08-09）
- `WebContentsView` 是 main-process View，可持有或接收一个指定的 `WebContents`；同一个 `WebContents` 同时只能附着到一个 `WebContentsView`。[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)（核查：2026-08-09）
- Electron 不推荐用 `<webview>` tag 承载此类内容，官方建议考虑 `WebContentsView` 等替代方案。[webview tag](https://www.electronjs.org/docs/latest/api/webview-tag)（核查：2026-08-09）
- `session.fromPartition('persist:...')` 会创建持久 Session；相同 partition 名共享同一 Session；不带 `persist:` 的 partition 只在内存中。[session](https://www.electronjs.org/docs/latest/api/session)（核查：2026-08-09）
- Session 暴露 `will-download`，`DownloadItem` 支持保存路径、进度、暂停、恢复和取消。Electron 43 改变了默认下载目录行为，因此 Candy 必须显式设置下载策略，不能依赖默认值。[session](https://www.electronjs.org/docs/latest/api/session)、[DownloadItem](https://www.electronjs.org/docs/latest/api/download-item/)、[Electron 43 release](https://www.electronjs.org/blog/electron-43-0)（核查：2026-08-09）
- `webContents.debugger` 是 Electron 提供的 Chrome DevTools Protocol 替代传输，可直接附着到目标 `WebContents`、发送 CDP command 并接收事件；打开 DevTools 可能导致已附着 debugger 被分离。[Debugger](https://www.electronjs.org/docs/latest/api/debugger)（核查：2026-08-09）
- `webContents` 提供 `before-input-event`、`before-mouse-event`、`input-event` 和 `sendInputEvent()`。公开的 `InputEvent` / `MouseInputEvent` 结构没有说明输入来自物理用户还是自动化。[webContents](https://www.electronjs.org/docs/latest/api/web-contents/)、[InputEvent](https://www.electronjs.org/docs/latest/api/structures/input-event)、[MouseInputEvent](https://www.electronjs.org/docs/latest/api/structures/mouse-input-event)（核查：2026-08-09）

**建议**

- Browser Workspace 由 Electron main 中的 `BrowserModule` 独占管理：
  - `WebContentsView` 负责可见页面；
  - `persist:candy-browser-v1` 或等价的 Candy-owned absolute session path 负责登录态、Cookie 和缓存；
  - `DownloadItem` 负责下载，不另写下载器；
  - `webContents.debugger` 只附着当前任务绑定的那个可见 `WebContents`；
  - app-server 只能调用语义化的窄 Browser Adapter，不得获得原始 `WebContents`、Session 或任意 CDP command 权限。
- V1 使用一个 Candy-owned 持久 Browser Profile，共享用户登录态；每个 tab 仍绑定单一 Candy Task，并有单一控制所有者。Cookie 值不得进入任务事件、模型上下文或日志。
- 下载必须经过 Candy 路径选择与状态展示；文件名规范化、禁止自动打开或执行、禁止自动将下载内容交给模型。
- 控制状态使用显式的 `user` / `agent` lease。Gate 测试若证明物理输入可被可靠识别，则物理输入立即取消当前 agent action 并切回 user；否则只提供显式“接管控制”按钮。
- 不在生产构建暴露 browser-level remote debugging port。内部调试若必须开放，应为开发构建、短生命周期、显式开关。

**风险**

- 一个共享 Profile 会让任务间共享站点登录状态；错误的 tab/task 绑定可能造成跨任务浏览器状态泄漏。
- 页面内容是非可信输入。登录、上传、下载、支付、发布、删除、发送消息等敏感动作即使站点已授权也必须单次确认。
- CDP 随 Chromium 版本演进。Candy 的 Adapter 应只覆盖 V1 所需命令，并在每次 Electron major 升级时跑合同测试。
- DevTools 可使 debugger 分离。V1 应在打开 DevTools 时暂停 agent 控制，不能静默继续执行。

### 3.2 与 Playwright、agent-browser、browser-use 的技术合同比较

**事实**

- Playwright `connectOverCDP()` 连接的是 Chromium browser-level HTTP/WebSocket endpoint，官方明确说明它只适用于 Chromium、只有默认 context 可访问，并且相较 Playwright protocol 是“significantly lower fidelity”。[Playwright BrowserType.connectOverCDP](https://playwright.dev/docs/api/class-browsertype)（核查：2026-08-09）
- Playwright 的 Electron API 用于由 Playwright 启动并测试 Electron 应用，不是“接收现有 Electron `webContents.debugger` 传输并控制其中一个 WebContentsView”的运行时合同。[Playwright ElectronApplication](https://playwright.dev/docs/api/class-electronapplication)（核查：2026-08-09）
- agent-browser 的官方仓库描述的是独立 CLI/daemon；默认管理自己的 Chromium，也可通过 `--cdp` 连接 browser-level endpoint，并提供自己的 profile/lifecycle 选项。[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)（核查：2026-08-09）
- browser-use 是 Python 库并包含自己的 Agent/LLM orchestration；其 browser 连接可走 CDP，但这不是 Electron 单个 `WebContents` 的 in-process debugger transport。[browser-use/browser-use](https://github.com/browser-use/browser-use)（核查：2026-08-09）

| 方案 | 精确控制同一个可见 WebContentsView | 直接共享 Electron Session | 新增运行时/进程 | V1 判断 |
| --- | --- | --- | --- | --- |
| `WebContentsView` + `webContents.debugger` | 是，官方 API 直接附着目标 `WebContents` | 是 | 无 | **采用** |
| Playwright `connectOverCDP` | 需另开 browser-level endpoint；不是 Electron alternate transport 合同 | 可间接访问默认 context，但隔离边界更宽 | Node Playwright runtime | 仅作外部测试工具，不进入生产 BrowserModule |
| agent-browser | 需 browser-level CDP endpoint | 可间接使用，但其 daemon/profile 生命周期与 Candy 重叠 | CLI/daemon，通常还管理 Chrome | 不采用为 V1 核心 |
| browser-use | 需 browser-level CDP endpoint | 可间接使用 | Python + 自有 Agent loop | 不采用为 V1 核心 |

**建议**

- Candy 不实现浏览器内核，也不实现 CDP 协议栈；直接复用 Electron Chromium 和官方 debugger transport。
- Playwright 可用于黑盒启动 Candy Desktop、验证 UI/安全策略，但不作为运行时页面控制层。
- agent-browser/browser-use 的观察模型可作为独立研究对象，但 V1 不引入其 daemon、浏览器生命周期或 Agent loop。

**风险**

- 为兼容第三方 CDP 客户端而开启 remote debugging endpoint，会把控制面从“一个目标 WebContents”扩大为 browser-level targets，增加调试端口发现、跨 tab 控制和 profile 泄漏风险。
- “能连 CDP”不等于“能共享同一可见嵌入页面和相同 Candy profile 且保持同等隔离”。V1 不应以项目 README 的营销描述替代上述连接合同。

## 4. Electron 安全基线

### 4.1 事实

- Electron 官方安全清单要求：远程内容禁用 Node integration，启用 context isolation 和 sandbox，保持 `webSecurity`，定义 CSP，限制导航和新窗口，处理 Session 权限请求，并验证 IPC sender。[Electron security](https://www.electronjs.org/docs/latest/tutorial/security)（核查：2026-08-09）
- `contextBridge` 是隔离 preload 与页面世界的官方机制；Electron 明确警告不要直接暴露原始 `ipcRenderer`，应为每个允许的消息提供一个窄方法。[Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)（核查：2026-08-09）
- Electron renderer sandbox 是 Chromium renderer/utility-service 级隔离，不是任意 `child_process.spawn()` 出来的模型 Shell 命令沙箱。[Electron sandbox](https://www.electronjs.org/docs/latest/tutorial/sandbox)（核查：2026-08-09）
- Session 同时提供 permission request 和 permission check handler；只配置其中一个不能构成完整默认拒绝策略。[session](https://www.electronjs.org/docs/latest/api/session)（核查：2026-08-09）

### 4.2 建议

- Candy app renderer：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。
- Browser Workspace 的远程页面：不注入 preload，不暴露 Candy IPC，不提供 Node；默认拒绝权限，由 main 按 task/site/permission 三元组做最小授权。
- preload/contextBridge 只暴露产品语义命令，例如 `task.list()`、`task.sendMessage()`、`credential.has()`、`credential.set()`；不得暴露任意 channel、任意文件路径、任意 Shell、原始 CDP 或完整 credential read。
- main 必须拦截：
  - 非 Candy 自有 app URL 的 renderer navigation；
  - `setWindowOpenHandler` 中所有未显式允许的新窗口；
  - 未登记的外部协议；
  - 来源 frame/URL 不匹配的 IPC。
- 使用自定义 app protocol 加载本地 UI，配置无 `unsafe-eval` 的 CSP；不以 `file://` 作为长期产品合同。
- Electron fuses：关闭 `nodeOptions`、`nodeCliInspect` 和 `runAsNode`，启用 cookie encryption、ASAR integrity 和 only-load-from-ASAR。app-server 由 Candy 打包的独立 Node 22 executable 启动，不依赖 Electron 的 Node mode，见 7.1。

### 4.3 风险

- contextBridge 只是 API 边界；如果桥接方法接受任意 IPC channel、命令或路径，它仍会绕过隔离目标。
- Browser Workspace 和 app renderer 必须使用不同 WebContents/Session 权限策略。不能把应用 preload 注入网页。
- Electron renderer sandbox 与模型 Shell sandbox 是两个不同安全域。任何文档和 UI 都必须使用不同术语。

## 5. macOS + Windows 11 模型 Shell 命令沙箱

### 5.1 macOS

**事实**

- Apple App Sandbox 是通过 entitlement 对应用及其 helper 施加的应用级能力边界；嵌入 helper 需要继承相应 sandbox。它不是为每条模型命令动态生成 workspace allowlist 的通用 Node API。[Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)、[Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)、[Embedding a helper tool in a sandboxed app](https://developer.apple.com/documentation/Xcode/embedding-a-helper-tool-in-a-sandboxed-app)（核查：2026-08-09）
- Apple Developer Forums 的 Apple 资料将 `sandbox-exec` 及相关 sandbox profile 接口描述为 deprecated / unsupported API；不能把它当作长期稳定产品合同。[Apple Developer Forums thread 661939](https://developer.apple.com/forums/thread/661939)（核查：2026-08-09）
- OpenAI Codex 官方仓库当前 macOS 实现调用 `/usr/bin/sandbox-exec` 并生成 Seatbelt profile，但这是 Codex 自身的原生实现，不是 Apple 提供的稳定 SDK，也不是 Candy 可依赖的已安装系统服务。[Codex core sandboxing overview](https://github.com/openai/codex/blob/main/codex-rs/core/README.md)、[Codex seatbelt implementation](https://github.com/openai/codex/blob/main/codex-rs/sandboxing/src/seatbelt.rs)（核查：2026-08-09）

**建议**

- 不将整个 Candy Desktop 放进 App Sandbox 来代替每命令隔离；这会改变终端工具链、Git、编译器和用户仓库访问合同，也无法覆盖独立 TUI 拓扑。
- 将未来 macOS 实现收敛到 `SandboxRunner` Adapter；只有在选定可审计、可维护的原生 runner 并完成真实机器安全验证后，才启用 Shell Auto。

**风险**

- 直接复制 Codex Seatbelt profile 会让 Candy 自己承担 deprecated OS 接口、profile 正确性和未来 macOS 兼容性，且违反“不要自建安全产品”的边界。
- 仅校验 `cwd` 或命令字符串不能阻止子进程访问用户主目录、Keychain helper、网络或其他进程。

### 5.2 Windows 11

**事实**

- AppContainer 是 Windows 的官方进程隔离边界，可通过 capabilities 和 ACL 控制资源；创建与启动 AppContainer 需要原生 Windows 安全 API。[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)、[Implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)（核查：2026-08-09）
- Windows 提供 restricted tokens、Job Objects 和 Windows Filtering Platform，但它们分别解决 token 权限、进程组生命周期和网络过滤，并非一个 Node API 即可组合成正确的 workspace-write/no-network 沙箱。[Restricted tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)、[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Windows Filtering Platform](https://learn.microsoft.com/en-us/windows/win32/fwp/windows-filtering-platform-start-page)（核查：2026-08-09）
- Windows 11 新的 `Experimental_CreateProcessInSandbox` 文档明确标为 experimental、subject to change，使用动态解析且没有公开 header；当前协议版本为 0.1.0，不能作为 V1 稳定基础。[CreateProcessInSandbox](https://learn.microsoft.com/en-us/windows/win32/secauthz/createprocessinsandbox)（核查：2026-08-09）
- OpenAI Codex 官方仓库包含自己的 Windows native sandbox/restricted-token 实现，但未发布为 Candy 可依赖的稳定跨平台 Node/Electron sandbox SDK。[openai/codex](https://github.com/openai/codex)、[Codex core sandboxing overview](https://github.com/openai/codex/blob/main/codex-rs/core/README.md)（核查：2026-08-09）

**建议**

- 不自行拼接 restricted token + AppContainer + WFP + ACL 成为 V1 安全产品；这需要专门的 native security engineering、审计和攻防验证。
- 未来 Windows runner 必须至少证明：workspace 外拒写、网络默认拒绝、provider credential 不可见、子孙进程继承限制、取消时整树终止。

**风险**

- Restricted token 单独使用不等于文件系统和网络都被隔离；Job Object 单独使用也只解决生命周期，不解决资源权限。
- `taskkill`、WMI 枚举或按进程名终止不是安全边界，存在 PID 重用、竞态和遗漏后代进程问题。

### 5.3 Gate 决定与诚实降级

**事实**

- 在本研究限定的官方资料中，未找到可直接复用、仍受稳定支持、同时覆盖 macOS 与 Windows 11、并由 Node/Electron 暴露“每命令 workspace-write + no-network”合同的方案。（核查：2026-08-09）

**建议**

- **PG0-SBX-01 保持 blocker。** 在 blocker 关闭前：
  - 文件读写工具可使用 `WorkspaceGuard`，但 UI 和文档必须标注为路径保护，不是 OS sandbox；
  - 每一条 Shell 命令都必须显式确认，展示完整命令、shell、cwd、预计网络需求和变更范围；
  - Shell 子进程使用环境变量 allowlist，绝不继承 provider credential；
  - “只读”模式默认不运行 Shell；
  - Shell-enabled Auto 与依赖 Shell 的 Auto Debug 不启用；
  - 产品文案使用“审批式受控执行”，不得使用“强沙箱”“workspace-only”“网络已阻断”等表述。
- 最小只读垂直切片可以继续，不需要等待 Shell sandbox；任何把 Shell 纳入 V1 Auto 的实施必须先更新产品决策和 ADR。

**风险**

- workspace canonicalization、symlink/reparse-point 检查和 post-diff 都有 TOCTOU 边界；任意获批 Shell 仍可能访问 workspace 外文件和网络。
- 用户确认是授权，不是隔离。即使 UI 做得完善，也不能把它转述为技术 containment。

## 6. OS Credential Store

### 6.1 事实

- macOS Keychain Services 的 generic password item 适合保存服务凭据，官方通过 `SecItemAdd` / `SecItemCopyMatching` 等接口管理。[Adding a password to the Keychain](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain)、[`kSecClassGenericPassword`](https://developer.apple.com/documentation/security/ksecclassgenericpassword)（核查：2026-08-09）
- Windows 官方建议新开发使用 Credential Manager 的 `CredWrite` / `CredRead` 保存凭据；凭据由当前用户登录会话保护。[Handling passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)、[WinCred API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/)（核查：2026-08-09）
- `atom/node-keytar` 仓库于 2022-12-15 archived，最新 release 7.9.0 发布于 2022-02；不满足“仍可维护”要求。[atom/node-keytar](https://github.com/atom/node-keytar)（核查：2026-08-09）
- Electron `safeStorage` 在 macOS 使用 Keychain、Windows 使用 DPAPI 提供加解密，但它返回/接收密文字节，并不是“凭据只存在 OS credential store”的完整存储合同。[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)（核查：2026-08-09）
- `@napi-rs/keyring` 1.3.0 在 2026 年仍发布维护，官方源码针对 macOS Security.framework 和 Windows Win32 Credential API，并提供 macOS/Windows 多架构 Node-API 构建。[npm `@napi-rs/keyring`](https://www.npmjs.com/package/%40napi-rs/keyring)、[keyring-node](https://github.com/Brooooooklyn/keyring-node)、[keyring-node package.json](https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/package.json)、[keyring-node Cargo.toml](https://raw.githubusercontent.com/Brooooooklyn/keyring-node/main/Cargo.toml)（核查：2026-08-09）

### 6.2 建议

- 采用精确版本 `@napi-rs/keyring@1.3.0`，封装为 `CredentialStore`：`set`、`replace`、`delete`、`has`、trusted-runtime-only `getSecretLease`。
- service 使用稳定、版本化的 Candy 标识；account 使用 provider ID（如 `deepseek`、`minimax`），不使用仓库路径或用户输入作为 key。
- Renderer 只能查询 presence、写入、替换和删除；不得读回完整 secret。
- Desktop app-server 和 TUI 只能在发起 provider HTTPS 请求的可信路径临时取出 secret；不得写入 session、SQLite、JSON、日志、事件或子进程环境。
- 在 macOS arm64/x64、Windows x64，以及实际承诺分发的 Windows arm64 上做签名后安装包测试，覆盖 native addon 装载和凭据升级/删除。
- 加载失败时返回 `credential_store_unavailable`。不回退到 keytar、safeStorage + 文件、`security`/`cmdkey` CLI、明文文件或 repo `.env`。

### 6.3 风险

- 这是 Candy V1 无法完全避免的 native dependency；需要处理 Electron/Node ABI、ASAR unpack、代码签名和不同架构的预编译产物。
- OS credential store 主要隔离静态存储，不保证抵御同一用户上下文中的恶意进程。Renderer/Browser 与 trusted runtime 的进程边界仍然必要。
- JavaScript 无法保证 secret buffer 被确定性清零；应缩短引用寿命并禁止复制，而不能宣称内存零残留。

## 7. 进程生命周期、取消、app-data、文件锁和路径

### 7.1 Desktop app-server transport

**事实**

- Electron `utilityProcess.fork()` 支持 Node 和 MessagePort，但其 `stdin` 只能配置为 `ignore`，不能满足既定的双向 typed JSONL-over-stdio 合同。[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)（核查：2026-08-09）
- Node `child_process.spawn()` 支持显式 executable、参数数组以及独立 `stdin`/`stdout`/`stderr` pipes，满足 typed JSONL-over-stdio 传输所需的进程合同。[Node child process](https://nodejs.org/download/release/v22.23.2/docs/api/child_process.html)（核查：2026-08-09）
- Electron 的 `runAsNode` fuse 可以阻止 Electron executable 通过 `ELECTRON_RUN_AS_NODE` 变成通用 Node 进程；独立 Node child 方案不需要保留这一能力。[Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)（核查：2026-08-09）

**建议**

- 保持已接受的 Desktop 架构：main 用随 Candy 签名和打包的 Node `22.23.2` executable 启动 app-server，stdin/stdout 为 JSONL pipes，stderr 独立诊断，环境变量使用显式 allowlist。
- app-server 不 detached，不继承 provider credential，不允许用户输入修改 executable path 或 bootstrap script path；启动前校验 executable 和入口属于只读签名应用资源。
- 关闭 `runAsNode`、`nodeOptions` 和 `nodeCliInspect` fuses，启用 ASAR integrity、only-load-from-ASAR 与 cookie encryption。

**风险**

- 打包独立 Node runtime 增加安装体积、签名资产和安全补丁责任。收益是 TUI 与 Desktop app-server 使用同一 Pi-compatible runtime，Electron 升级不再隐式改变 Pi 的 Node 环境。

### 7.2 取消和进程树

**事实**

- Node `child_process` 的 AbortSignal 最终调用子进程 kill；官方同时说明 `.kill()` 成功返回不等于进程已经终止，Windows 对 POSIX signal 的支持有限，父进程退出也不保证孙进程退出。[Node child_process](https://nodejs.org/api/child_process.html)（核查：2026-08-09）
- `detached: true` 在 Windows 允许子进程在父进程退出后继续运行，在非 Windows 创建新的 process group/session。[Node child_process](https://nodejs.org/api/child_process.html)（核查：2026-08-09）
- Windows Job Object 是官方的进程组生命周期机制；`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 可在最后一个 handle 关闭时终止 job 内进程，`TerminateJobObject` 可终止整个 job。[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[TerminateJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject)（核查：2026-08-09）
- Microsoft 的 `node-pty` 明确是终端/PTY 能力，子进程与父进程处于相同权限级别，不是 sandbox。[microsoft/node-pty](https://github.com/microsoft/node-pty)（核查：2026-08-09）

**建议**

- `ProcessSupervisor` 负责 spawn、stdout/stderr backpressure、graceful cancel、强制终止、退出清理和取消不完整状态。
- macOS：模型命令运行于独立 process group，取消顺序为协作取消 → `SIGTERM` → 有界等待 → group `SIGKILL`；app-server 自身不 detached。
- Windows：在长任务和 Auto Debug 前必须接入 Job Object 级所有权。纯 Node 没有官方 Job Object API，因此 PG0-PROC-01 在选定受维护原生依赖或极小自有 native bridge 并安全评审前保持 blocker。
- Shell 使用平台明确的 shell 合同；非 Shell 的 Git、编译器探测和 helper 调用均使用 executable + args 数组，不使用 `shell: true`。

**风险**

- Windows 上依赖 PID 枚举再逐个 kill 存在竞态；macOS 上只 kill 直接 child 会遗留后代。
- 原生 Job Object bridge 可以做成很窄的 Platform Adapter，但它仍属于安全/生命周期关键 native code，必须真机验证崩溃、强制退出和 installer upgrade。

### 7.3 app-data 与 Browser profile

**事实**

- Electron `app.getPath('userData')` 在 Windows 默认位于 `%APPDATA%/<app>`，macOS 位于 `~/Library/Application Support/<app>`；`sessionData` 默认等于 `userData`，可在 `ready` 前调整。[Electron app](https://www.electronjs.org/docs/latest/api/app)（核查：2026-08-09）

**建议**

- 所有 Candy session、task metadata、lease、worktree registry 和 browser profile 都从 `app.getPath()` / TUI 同源 `AppPaths` Adapter 派生，不手拼 OS 目录。
- 将 `sessionData` 或 Browser Session path 指向独立 `browser-profile/`，避免 Chromium cache 与任务数据库混在一起。
- provider credentials 不进入 app-data。

**风险**

- Desktop 与 TUI 如果推导出不同 app-data 根，会破坏跨客户端 execution ownership。两者必须共享同一 `AppPaths` 合同和安装身份。

### 7.4 文件锁与路径边界

**事实**

- Node `fs.open(..., 'wx')` 使用 exclusive-create 语义；官方警告先 `access()` 再 `open()` 会产生 TOCTOU，exclusive flag 在某些网络文件系统上可能不可靠。[Node fs](https://nodejs.org/api/fs.html)（核查：2026-08-09）
- Windows reparse points 可把路径重定向到另一个位置；Windows 默认路径比较、保留名称和长路径行为与 POSIX 不同。[Reparse points](https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points)、[Naming files, paths, and namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)、[Maximum path length limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)（核查：2026-08-09）
- macOS 常见 APFS volume 可配置为大小写敏感或不敏感，不能仅按 OS 名称假设比较规则。[Apple files and directories](https://developer.apple.com/documentation/technologyoverviews/files-and-directories)（核查：2026-08-09）
- Git 会在 init/clone 时探测 filesystem case behavior 并设置 `core.ignoreCase`；Windows 默认 `core.protectNTFS=true`，macOS 默认 `core.protectHFS=true`。[git-config](https://git-scm.com/docs/git-config)（核查：2026-08-09）

**建议**

- 若只需要迁移锁或一次性 bootstrap lock，可在本机 app-data 使用 `open('wx')`，内容包含 owner nonce、PID、创建时间、heartbeat；不得只凭 PID 判定 stale。
- authoritative execution lease 使用第 8 节 SQLite 事务，不再用仓库内 lock file 充当多客户端调度器。
- `WorkspaceGuard` 使用 canonical/real path、volume-aware comparison，并在 Windows 检查 reparse-point escape，在 macOS 检查 symlink/case behavior；拒绝无法解析的路径。
- 文件修改后仍执行 Git diff 和 secret scan。该组合是纵深防御，不是 Shell sandbox。

**风险**

- 路径“检查后再打开”仍可能遭受 symlink/reparse-point 替换。只有 OS sandbox 或 handle-relative 原生操作才能显著收紧此类竞态。
- 杀进程、睡眠/唤醒、杀毒软件和索引服务会改变锁与文件删除时序，必须真机测试。

## 8. `node:sqlite`：任务元数据、FIFO 和 execution lease

### 8.1 稳定性与 packaged Node 可用性

**事实**

- Node 22.23.2 的 `node:sqlite` 为 **Stability 1.1 — Active development**；它不再需要 `--experimental-sqlite`。当前公开数据库类是 `DatabaseSync`，所有 API 同步执行。[Node 22 SQLite](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html)（核查：2026-08-09）
- `DatabaseSync` 支持 file-backed database、busy `timeout`、prepared statements 和 transactions 所需的 SQL；extension loading 默认关闭，默认 busy timeout 为 0，因此 Candy 必须显式设置非零有界 timeout。[Node 22 SQLite](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html)（核查：2026-08-09）
- Node 22 当前发行线已经升级到 SQLite 3.53.1；SQLite 官方记录的 WAL-reset corruption bug 在 3.51.3 修复，因此目标版本已越过受影响范围。[Node v22 changelog](https://github.com/nodejs/node/blob/v22.23.2/doc/changelogs/CHANGELOG_V22.md)、[SQLite WAL documentation](https://www.sqlite.org/wal.html)（核查：2026-08-09）
- Node 22 的公共 `node:sqlite` 合同没有 Node 24 的 `defensive` 选项。Candy 不能把该选项写入 Node 22 实施合同；应通过不执行不可信 SQL、prepared statements、禁用 extensions、固定 schema/migrations 和应用数据目录权限控制风险。
- `node:sqlite` 是 Node 内建模块，不需要随 Candy 分发 `.node` addon。相比之下，Electron 官方说明第三方 native Node module 通常需要针对 Electron ABI 重编译，并在 Electron 升级后重新验证。[Electron native Node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)（核查：2026-08-09）

**建议**

- **有条件采用 `node:sqlite`，不在 V1 首选 native addon。** 通过 `TaskStore` Adapter 隔离 SQL、迁移和 Node 22 API 的 Active development 变动。
- 数据库位于本机 Candy app-data，例如概念路径 `state/candy-v1.sqlite`；不得位于仓库、Git worktree、同步盘或网络共享。
- 数据库只存：task identity/status、repo/worktree reference、FIFO queue entry、execution lease、schema version 和轻量索引。Pi session/消息继续使用 Candy-owned session machinery；provider secret、prompt、完整 tool output 不复制进 SQLite。
- 每个连接设置：
  - `allowExtension: false`；
  - 非零有界 busy timeout（Gate 建议值 5 秒，最终由并发测试校准）；
  - `PRAGMA journal_mode=WAL` 并验证返回值确为 `wal`；
  - durability 优先使用 `PRAGMA synchronous=FULL`；
  - 所有写事务保持短小，不在事务中调用 Git、Shell、浏览器或模型。
- TUI、Desktop app-server 可各自持有短生命周期连接；Electron main、renderer 和 Browser Workspace 不得直接访问数据库。

**风险**

- Stability 1.1 仍处于 Active development；API 可能在未来 Node 版本中变化。精确 runtime pin + Adapter + migration tests 是采用前提。
- `DatabaseSync` 会阻塞所在 JS event loop。Candy 的元数据操作很小，预计可接受；禁止长查询、大 BLOB、session 全文或大型 migration 在热路径同步执行。
- WAL 允许 readers 与 writer 并行，但同一时刻仍只有一个 writer；SQLite 也明确不支持 WAL 跨网络文件系统。[SQLite WAL](https://www.sqlite.org/wal.html)（核查：2026-08-09）

### 8.2 FIFO 与 execution lease 合同

**事实**

- SQLite transaction 是原子的；WAL 下 readers 可与 writer 并行，但 writer 仍串行。进程异常退出后，SQLite 通过 journal/WAL 恢复已提交状态。[SQLite transactional](https://www.sqlite.org/transactional.html)、[SQLite isolation](https://www.sqlite.org/isolation.html)、[SQLite WAL](https://www.sqlite.org/wal.html)（核查：2026-08-09）

**建议**

- FIFO queue 使用不可变 enqueue sequence；多个客户端在一个 `BEGIN IMMEDIATE` 短事务中完成：清理已确认过期 lease → 计算 active count → 选择最老 queued task → 创建/续约 execution lease → 更新 task state。
- execution lease 至少包含 `task_id`、`owner_id`、随机 nonce、递增 generation/fencing token、`acquired_at`、`heartbeat_at`、`expires_at`。
- 任何改变 task 状态或触发 side effect 的 owner 都必须携带当前 generation；过期 owner 即使恢复运行也不能继续控制任务。
- heartbeat 丢失不立即等于任务可抢占：先校验 lease 超时、owner 进程身份和保存状态，再由用户可见的恢复流程接管。
- 每个 task 始终只有一个 execution owner；无 owner 的 Desktop/TUI 连接只读保存状态，不能发送 cancel/steer。

**风险**

- 仅靠 `expires_at` 会受睡眠/唤醒和 wall-clock 调整影响。实现时要同时记录 monotonic observation，并将恢复过程设计为有 fencing token 的原子换代。
- 长期持有数据库 transaction 作为“运行中锁”会阻塞所有 writer，因此明确禁止；lease 必须是持久 row + 短 heartbeat transaction。
- SQLite 解决原子 ownership，不会自动终止旧 owner 的 OS 进程；仍依赖第 7.2 节 `ProcessSupervisor`。

### 8.3 与 JSON/锁文件和 native addon SQLite 比较

| 方案 | 优点 | 缺点 | Candy V1 判断 |
| --- | --- | --- | --- |
| `node:sqlite` | 内建、无 addon 重编译；跨进程原子事务；适合 FIFO/lease；SQLite 3.53.1 已修复已知 WAL-reset bug | Node 22 API 仍为 Active development；同步 API；没有 `defensive` 选项 | **条件采用** |
| JSON + `open('wx')` lock | Node core 即可；可读、易备份；适合 immutable descriptor、日志和极小 bootstrap lock | 多文件更新无统一事务；stale lock/队列抢占/崩溃恢复需自建；Windows rename/delete 与 TOCTOU 更复杂 | 可保留给 session/descriptor，不作为 authoritative FIFO/lease |
| `better-sqlite3` / `sqlite3` native addon | 项目成熟、API 已被广泛使用；可作为 fallback 调研对象 | Electron ABI/rebuild、macOS/Windows 多架构产物、ASAR、签名和 Electron upgrade 都增加 Gate；还需兼容独立 TUI Node | 不作为首选；仅在 `node:sqlite` Gate 失败后重新决策 |

第三方 addon 的维护和打包事实来源：[`better-sqlite3` official repository](https://github.com/WiseLibs/better-sqlite3)、[`node-sqlite3` official repository](https://github.com/TryGhost/node-sqlite3)、[Electron native Node modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)（核查：2026-08-09）。

### 8.4 PG0-DATA-01 通过条件

必须在签名/打包后的真实产物中完成：

1. macOS 和 Windows 11：packaged Node 22 app-server 与独立 TUI 均能导入 `node:sqlite`，并记录 `process.versions.node` 与 SQLite runtime version；Electron main 只能通过 versioned protocol 访问状态投影。
2. 两个独立客户端并发 enqueue/claim 时保持 FIFO、全局并发上限和 one-owner-per-task，不发生双 owner。
3. owner 在事务前、事务中、提交后、heartbeat 中被强制终止时，数据库可恢复，fencing token 阻止旧 owner 继续写。
4. WAL 文件存在时执行应用退出、升级、备份和恢复；不得只复制主 `.sqlite` 而遗漏 `-wal` / `-shm`。SQLite 官方说明 WAL 是数据库持久状态的一部分。[SQLite WAL](https://www.sqlite.org/wal.html)（核查：2026-08-09）
5. 路径含空格、中文、长路径；Windows 杀毒/索引干扰；macOS/Windows 睡眠唤醒后行为可预测。
6. corruption 检查、schema migration rollback 和未知未来 schema 拒绝打开均有确定行为。

若任一条件失败，优先延后数据层或升级到已经验证的 Node/Electron 组合；不要无审查地切换 native addon，也不要退回自建多文件事务。

## 9. Git worktree

### 9.1 事实

- `git worktree add --detach --lock --reason`、`list --porcelain -z`、`remove`、`prune --dry-run` 和 `repair` 都有 Git 官方合同；porcelain 格式被声明为跨 Git 版本和用户配置稳定。[git-worktree](https://git-scm.com/docs/git-worktree)（核查：2026-08-09）
- Git 默认只允许删除 clean worktree；dirty worktree 或带 submodule 的 worktree 需要 `--force`，locked worktree 可能需要两次 `--force`。[git-worktree](https://git-scm.com/docs/git-worktree)（核查：2026-08-09）
- Git 明确建议不要直接读取 `.git/worktrees` 内部 ref 文件，而应使用 `git rev-parse` / `git update-ref` 等命令。[git-worktree](https://git-scm.com/docs/git-worktree)（核查：2026-08-09）

### 9.2 建议

- `GitWorktree` Adapter 只调用系统 Git executable + args array；先探测 `git --version` 和所需 option，不走 shell，不解析人类输出。
- 并发 writable task 使用 app-data 下 Candy-owned worktree path，创建时采用 detached HEAD + `--lock --reason candy:<task-id>`；只有用户明确要求创建 branch/commit 时才创建命名分支。
- inventory 使用 `git worktree list --porcelain -z`。
- 清理使用 `git worktree remove`；dirty 时拒绝自动删除。`--force`、unlock、prune 或直接丢弃均需要明确用户授权，先执行 dry-run。
- worktree path 与 task metadata/lease 在 SQLite 中关联，但 Git 自己仍是 worktree 事实来源。

### 9.3 风险

- submodule worktree、主仓库被移动、branch 已在另一 worktree checkout、Windows 长路径/大小写和杀毒锁均需真机覆盖。
- 不得用递归文件删除代替 `git worktree remove`；否则会遗留 Git administration state。

## 10. 精确技术选择与 Adapter 边界

| Adapter / 模块 | V1 后端 | Candy 自己负责 | Candy 不得自己实现 |
| --- | --- | --- | --- |
| `BrowserWorkspace` | Electron `WebContentsView` + Session + DownloadItem + debugger | tab/task ownership、allowlist、审批、可见状态、窄 CDP 映射 | 浏览器内核、通用 CDP server、下载协议栈 |
| `CredentialStore` | `@napi-rs/keyring@1.3.0` | provider/service 命名、renderer write-only API、错误映射 | Keychain/Credential Manager、凭据加密格式、CLI fallback |
| `TaskStore` | `node:sqlite`（PG0-DATA-01 后） | schema、migration、prepared SQL、备份/恢复 | SQLite 引擎、跨文件 JSON transaction |
| `ExecutionLeaseRepository` | SQLite short transactions | FIFO、lease、heartbeat、fencing、恢复 UX | 用长事务充当运行锁、PID-only stale 判定 |
| `ProcessSupervisor` | Node child process + macOS process group + Windows Job Object 能力 | 生命周期状态机、取消升级、输出 backpressure | WMI/taskkill 竞态式“进程树” |
| `SandboxRunner` | **未选定，blocker** | capability contract、policy mapping、审计证据 | 自研 Seatbelt/AppContainer/WFP sandbox 产品 |
| `WorkspaceGuard` | Node fs/path + OS path Adapter | canonicalization、allowlist、diff/secret scan | 宣称其等价 OS sandbox |
| `AppPaths` | Electron `app.getPath()` + TUI 同源规则 | 子目录布局、迁移、安装身份 | 手拼 `%APPDATA%` / `~/Library` 路径 |
| `GitWorktree` | Git CLI | task/worktree policy、用户确认、错误映射 | Git worktree metadata 和 ref 解析器 |

### 明确禁止的 V1 方向

- 不 fork Chromium，不写最小浏览器，不把 agent-browser/browser-use 的 Agent loop 嵌入 Candy。
- 不复制 Codex 的 macOS/Windows sandbox 实现，不依赖用户已安装 Codex。
- 不使用 archived keytar，不用 safeStorage 密文文件冒充 OS credential store。
- 不用 JSON + 多个 ad-hoc lock file 自建 FIFO/lease transaction。
- 不用 `taskkill`、进程名或 PID-only 方案宣称可靠取消整棵进程树。
- 不读取/修改 `.git/worktrees` 内部管理文件。

## 11. 必须完成的真实机器验证矩阵

以下测试必须在所有实际分发架构执行；至少包括 Windows 11 x64 和 macOS Apple Silicon。若产品分发 Windows arm64 或 macOS Intel，则对应架构也是 release gate。

| 维度 | 验证项 |
| --- | --- |
| 安装与签名 | packaged app、签名/notarization、升级安装、ASAR/fuse、native keyring 装载 |
| Browser | 同一可见页面 CDP 观察/操作、持久登录、下载、上传、权限拒绝、DevTools detach、user takeover |
| Credential | set/replace/has/delete、OS 登出/重启、权限拒绝、旧版本升级、renderer 无法读回 |
| SQLite | 三运行拓扑导入、两进程并发、WAL/crash recovery、迁移、Unicode/长路径、sleep/wake |
| Process | cancel shell/PTY/编译器及其孙进程、app crash/quit、输出洪泛、Windows Job close、macOS process group |
| Path/guard | symlink、junction/reparse point、大小写差异、保留名、长路径、仓库位于外置盘 |
| Git worktree | dirty repo、branch collision、submodule、Unicode/空格/长路径、stale worktree、repair/remove |

在两平台真机结果完成前，不得声称“macOS + Windows 11 已验证”。CI 模拟和开发机单平台结果只能算预检。

## 12. 后续编码实施方案（本轮不执行）

### Phase 0：先关闭或接受 Gate

1. 明确 PG0-SBX-01 的产品决策：要么 Shell/Auto Debug 延后，要么批准独立 native Sandbox Runner 研究；若接受审批式降级，先更新产品文案和 ADR。
2. 选择 Windows Job Object 的仍维护实现路径，完成 PG0-PROC-01 安全评审。
3. 固定 Electron 43.2.0 与 packaged agent runtime Node 22.23.2 两条版本线，执行独立 Node child、PG0-DATA-01 和 credential addon 打包 smoke test。
4. 执行 Browser takeover spike；自动来源识别不可靠时固定显式 takeover UX。

### Phase 1：平台最小合同

1. 定义 `AppPaths`、`CredentialStore`、`TaskStore`、`ExecutionLeaseRepository`、`ProcessSupervisor`、`BrowserWorkspace`、`GitWorktree` 的最小 TypeScript 接口和错误码。
2. 每个接口先写跨平台合同测试和故障注入场景；不为远期插件或云端抽象。
3. 建立 provider secret 的静态/运行时泄漏测试，保证不进入 session、event、SQLite、log、tool args 或 child env。

### Phase 2：无 Shell 的最小垂直切片

1. 实现 AppPaths 和 CredentialStore。
2. 实现 `node:sqlite` TaskStore、migration、FIFO 和 fenced execution lease。
3. 接通 TUI in-process 与 Desktop app-server JSONL，使非 owner 只能观察。
4. 只接一个无副作用只读工具，验证 provider → Pi Adapter → task persistence → 两客户端 ownership 全链路。

### Phase 3：生命周期与 Git

1. 实现 ProcessSupervisor，先覆盖 app-server，再覆盖普通非 Shell helper。
2. Windows Job Object Gate 通过后加入长任务取消；失败时保留明确 `cancellation_incomplete`，不得假报成功。
3. 实现 GitWorktree Adapter 和 dirty/locked/submodule/cleanup UX。

### Phase 4：Electron 安全与 Browser Workspace

1. 固化 renderer/preload/main 边界、CSP、navigation/window/permission handlers 和 fuses。
2. 实现 `WebContentsView`、Candy Session、DownloadItem 和窄 debugger Adapter。
3. 完成 profile、tab/task ownership、敏感动作审批和 takeover Gate。
4. Playwright 只作为 packaged-app 外部验收测试使用。

### Phase 5：Shell 与 Auto Debug

1. 仅在 PG0-SBX-01 关闭后实现 Shell Auto。
2. 若 V1 接受审批式降级，只实现“每命令确认 + WorkspaceGuard + scrubbed env + ProcessSupervisor”，并在 UI 中持续标明没有强 OS sandbox。
3. Auto Debug 的轮数/时间预算不扩大安全权限；每轮 Shell 仍遵守同一 sandbox/approval policy。

### 完成标准

- 每个 Gate 都有真实机器证据、版本、日期和失败日志；不能以“本地跑过一次”关闭。
- 所有能力从 TUI 与 Desktop 共用同一 runtime contract；不存在 Desktop-only 的隐藏权限升级。
- 任何降级都在产品 UI、文档和事件模型中可见，且不会被命名为更强的安全保证。
