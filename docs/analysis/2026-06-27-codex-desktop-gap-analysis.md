# 天枢 vs Codex 2026：差距对照分析

> 分析日期：2026-06-27  
> 对照对象：OpenAI Codex CLI + Codex Desktop App（基于官方开发者文档及公开产品资料）  
> 天枢版本：Rivet v2.9.0 / 天枢桌面版 v0.0.1

## 结论速览

天枢桌面版已完成 **Antigravity 2.0 范式基座**（M0–N5）：本地 sidecar + Tauri 外壳、多会话、SSE 事件流、审批/Intent 双向协议、Artifacts 信任层、Cron 定时任务、浏览器验证面、可构建运行的 macOS `.app`。

但与 Codex 2026 相比，**分发成熟度、桌面交互面、运行时隔离、工具谱系** 仍有明显差距。最大短板在**打包分发**（无签名、无安装器、无自动更新、未内置 Node），其次是**桌面体验面**（无语音、IDE 同步弱、Git 可视化不足）和**云/网络隔离**。

---

## 一、分发与打包：差距最大

| 能力 | 天枢现状 | Codex Desktop 参考 |
|---|---|---|
| 安装包 | 仅 macOS 原始 `.app`；Windows 仅 `.exe`（`tauri.conf.json` 中 `targets: ["app"]`） | `.dmg`、`.msi`/`.msix`、安装器 |
| 签名/公证 | 无配置 | macOS Developer ID + Notarization；Windows 签名 |
| 自动更新 | 无 `tauri-plugin-updater` | Sparkle / 内置更新器 |
| Node 运行时 | **未内置**，`detect_node()` 探测系统 Node | 自带/托管 Node |
| 跨平台 CI | `.github/workflows/build-windows.yml` 期望 NSIS/MSI，但 `tauri.conf.json` 不产出这些格式 | 多平台签名发布流水线 |
| 应用商店 | 未配置 | Microsoft Store 等 |

**关键阻塞项**：
1. `tauri.conf.json` 的 `beforeBuildCommand` 引用 `desktop/scripts/pack-native.sh`，但该文件不存在（实际在仓库根 `scripts/pack-native.sh`）。干净 CI 构建会失败。
2. `bundle.targets` 只有 `["app"]`，与 Windows workflow 期望的 NSIS/MSI 路径不匹配。
3. 依赖用户系统已安装 Node.js，首次启动失败风险高。

---

## 二、桌面端交互：骨架已齐，体验面不足

**已具备**：多会话 dashboard、SSE 事件流、审批/Intent modal、diff 查看器、内嵌 xterm.js 终端、图片拖拽/渲染、artifacts 面板、schedule 管理、skills 管理、命令面板。

| 能力 | 天枢现状 | Codex 参考 |
|---|---|---|
| 语音输入 | ❌ 完全没有 | 实时语音转写 |
| IDE 同步 | ⚠️ 仅 `openFile` 打开外部编辑器 | VS Code/JetBrains 扩展，光标/文件上下文同步 |
| Git/Worktree 可视化 | ⚠️ 仅 worktree badge + diff artifact 列表 | 分支图、worktree 管理、可审查 diff 树 |
| 面板布局 | ⚠️ `splitMode` 状态是 stub，固定三栏+底部终端 | 可调整/可持久化的多面板布局 |
| Artifact 预览 | ⚠️ 仅 screenshot/raw/diff；无渲染 HTML/Markdown | PDF/表格/文档/网页预览 |
| 富文本编辑器 | ⚠️ textarea + `@` 提及 + `/` 命令，无块级内容 | 多模态 composer、图片生成快捷指令 `$imagegen` |
| 系统级 computer use | ❌ 无 | 可操控 macOS/Windows 桌面应用（看、点、输） |

---

## 三、运行时隔离与安全：本地 sandbox 有，云端/网络没有

| 能力 | 天枢现状 | Codex 参考 |
|---|---|---|
| 本地命令沙箱 | ✅ macOS `sandbox-exec` / Linux `bwrap`/`firejail` | 云 microVM |
| 云/容器隔离 | ❌ 无 Docker/Podman/Firecracker | 每次任务在隔离云环境运行 |
| 网络安全 | ❌ Bash/web fetch 可访问任意公网（仅 `web_fetch` 挡私网 IP） | 默认网络关闭，可按配置开放 |
| Windows 沙箱 | ❌ 无内核级隔离，仅靠 checkpoint 回滚 | 有隔离环境 |
| Computer Use | ⚠️ 仅 headless Playwright 浏览器（截图/text/click，强制审批+白名单） | 可操控桌面应用 |
| 安全扫描 | ❌ 无 SAST/依赖/密钥扫描工具 | Codex Security（漏洞检测+POC） |

浏览器工具当前采用 **fail-closed 域名白名单 + 每次审批**，这是安全设计，但也意味着它无法像 Codex 那样做开放式网页验证。

---

## 四、工具谱系：缺 AI 生成、音视频、网络沙箱

| 能力 | 天枢现状 | Codex 参考 |
|---|---|---|
| AI 图像生成 | ❌ `create_image` 只生成 SVG 标记，无 raster/AI 图像 | `gpt-image-2` 生成图片 |
| 图片输入 | ✅ 支持 base64 数据 URL 作为用户消息 | ✅ 支持 |
| 音频/视频输入 | ❌ 无 | 部分场景支持 |
| Web 搜索 | ✅ DuckDuckGo 抓取 | ✅ 内置 |
| MCP | ✅ 已接入 stdio/SSE/HTTP servers | ✅ 支持 |
| 插件/SDK | ❌ 只有 MCP，无正式插件市场/SDK | Skills API / 插件商店 |
| 安全扫描工具 | ❌ 无 | 有 |

---

## 五、多智能体与编排：有内核，缺舰队级 API

**已具备**：`delegate_task`、`delegate_batch`、`team_orchestrate`、星域人格、worker 会话持久化。

差距：Codex Desktop 把“并行多智能体”作为一等公民（同时管理多个线程，每个隔离 worktree，面板可视化）。天枢的编排能力在 runtime 层存在，但**桌面 API 仍以单会话 AgentLoop 为中心**，没有 first-class 的并行 agent fleet 管理面。

---

## 六、Git/GitHub 自动化：仅只读/提交级

| 能力 | 天枢现状 | Codex 参考 |
|---|---|---|
| Git 状态/diff/commit | ✅ 支持 | ✅ 支持 |
| PR 读取 | ✅ 通过 `gh` CLI 只读 | ✅ 支持 |
| push/pull/branch/merge/rebase | ❌ 未自动化，交回 `bash` | 可自动化 |
| PR 创建/合并 | ❌ 无 | 可自动生成 PR |

---

## 七、成本与预算治理：观察但未约束

天枢暴露了 `contextTokens`、`contextWindow`、每 turn usage，也有 cache 诊断。但**没有美元预算、token 预算上限、按 provider 的消费上限**。Codex 近期已加入 rollout token budgets 和剩余预算提醒。

---

## 八、天枢的差异化优势（不应丢）

- **Prefix cache 引擎**：frozen prefix + delta appendix + read-ref dedup，这是 Codex 没有强调的天枢核心差异化。
- **多 provider 自适应路由**：DeepSeek/Claude/GLM/Codex/MiniMax/MiMo。
- **Skills + 跨会话记忆**：`.rivet/skills/`、`.rivet/knowledge/memory.jsonl`。
- **审批与风险模型**：sensorium 驱动的 `auto-safe`、bash 前缀白名单、路径授权。
- **桌面端基础架构**：sidecar + Tauri + PTY + SSE 重连 + 持久化，N5 已能打出可运行的 `.app`。

---

## 建议优先级

1. **立即修** ✅ 已处理
   - 修正 `tauri.conf.json` 中 `scripts/pack-native.sh` 路径错误；
   - 补上 DMG/NSIS/MSI target，与 CI workflow 对齐。
2. **高优先级** ✅ 已完成（配置骨架）
   - 内置 Node 运行时：已实现（`desktop/scripts/fetch-node-runtime.{js,sh}`），构建期下载并打包；
   - 代码签名、公证、auto-updater：
     - `tauri.conf.json` 已配置 `bundle.macOS` / `bundle.windows` 签名占位；
     - CI workflows 已注入 `APPLE_*` / `WINDOWS_CERTIFICATE_*` / `TAURI_SIGNING_PRIVATE_KEY` env；
     - 更新器插件已接入，前端「检查更新」按钮已就位；
     - 需外部证书/更新服务器才能实际生效。

**本轮改动清单**：
- `desktop/src-tauri/tauri.conf.json`：修正 `beforeBuildCommand` 路径，target 扩展为 `["app", "dmg", "nsis", "msi"]`，增加 updater 插件占位配置，增加 `bundle.macOS` / `bundle.windows` 签名配置骨架。
- `desktop/scripts/fetch-node-runtime.{js,sh}`：按平台/架构下载官方 Node 二进制。
- `desktop/src-tauri/src/lib.rs`：sidecar 启动优先使用 bundled Node，其次系统 Node。
- `desktop/src-tauri/Cargo.toml` + `lib.rs`：接入 `tauri-plugin-updater`。
- `desktop/src/surfaces/SettingsSurface.tsx`：增加「检查更新」按钮。
- `.github/workflows/build-windows.yml`：加入 fetch-node-runtime，预留签名 secrets。
- `.github/workflows/build-macos.yml`：新增 macOS 构建 workflow。
- `desktop/DISTRIBUTION.md`、`desktop/.env.example`：分发与签名文档。

**仍需凭证才能生效**：Apple Developer ID / Windows 证书 / 更新服务器 endpoint + ed25519 keypair。
3. **产品差异化**：
   - 在桌面 UI 中可视化 prefix cache 优势、provider 路由、成本对比——这是 Codex 给不了的。
4. **补齐体验面** ✅ 部分完成：
   - ✅ Git 分支图：新增 `GET /git/graph`，桌面 `GitSurface`，Rail/侧边栏/快捷键入口；
   - ✅ Artifact 渲染预览：`markdown` / `html` kind 识别，ReviewPanel 渲染 + 沙盒 iframe + 源码切换；
   - ✅ 语音输入：Composer 麦克风按钮，Web Speech API 实时转写；
   - ⏳ IDE 扩展/同步：仍属独立项目，未开始。
5. **安全与合规**：
   - 网络 egress 白名单、可选容器/VM sandbox、安全扫描工具。
6. **多智能体舰队**：
   - 在桌面 API 上加 parallel thread / worktree fleet 的管理面，而不只是底层 delegation 工具。
