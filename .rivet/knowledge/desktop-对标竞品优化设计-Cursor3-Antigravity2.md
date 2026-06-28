# 天枢桌面端优化设计——对标 Cursor 3 / Antigravity 2.0 / Codex / Claude Code

> 时间：2026-07-01
> 对象：`desktop/`（Tauri 2 + React 18 + xterm.js 桌面端，package name: tianshu-desktop）
> 方法：两个探索 agent——一个完整测绘桌面端能力面（文件级证据），一个调研四款竞品 2025-2026 发布版（带来源）。关键事实（ROADMAP.md、updater placeholder）已二次核实。
> 定位基线：桌面端 ROADMAP.md 自述「忠实照搬 Antigravity 2.0 范式——独立桌面 App、无 IDE、agent-first」。

## 一、先纠正认知前提：这不是"终端套壳"

天枢桌面端**不是"薄 TUI 壳"**。架构是 **Tauri 2 壳 + React 18 + 结构化 HTTP/SSE sidecar**：

- agent 运行时（rivet）作为 **Node sidecar 进程**启动（`src-tauri/src/lib.rs:195` `spawn_sidecar`，绑 127.0.0.1 + 随机 token），不是把 TUI 灌进 xterm。
- 前端通过 **50+ 个 REST 端点 + SSE 流**（`src/runtime/client.ts` + `sse.ts`）与 sidecar 通信，SSE 带 seq、可重连可补读。
- 对话是 **React 组件重新渲染**的（`ThreadView.tsx` + `event-reducer.ts`），不是 PTY 透传。
- xterm/PTY（`src-tauri/src/pty.rs`）只是**附带的终端面板**，跑用户自己的 shell，和 agent 解耦。

这点和所有竞品都不同——Cursor 是 IDE 起家，Codex/Claude Code 是 CLI 套壳。**天枢架构上已走对路**（agent-first daemon client），优化不是"补壳"，是"补 agent-first 该有但还缺的能力"。

Tauri 原生命令只有 5 个（`runtime_info` + 4 个 `pty_*`），其余全走 HTTP。tray-icon/notification/dialog/window-state/updater 五个插件已注册。

## 二、天枢已领先的能力（优化时保护，不要丢）

竞品（尤其 Cursor/Claude Code）没有、天枢独有的差异化：

| 能力 | 位置 | 竞品对比 |
|---|---|---|
| 多会话编排 + delegation tree | `DelegationSurface.tsx` | Cursor 3（2026.4）才追上 Agents Window |
| 成本分析 per-worker/model/provider | `InsightsSurface.tsx` | 竞品都没有 |
| 信任层：autonomy 三档 + inline 审批 + checkpoint 回滚 + contested-file 跳过 | `ReviewPanel.tsx` | 比 Cursor 的 accept/reject 更细 |
| 调度任务 cron/interval/oneshot | `AutomationsSurface.tsx` | Claude Code 2026.4 才加 Routines |
| Plan Mode GUI（可审查 plan 文档 + approve/reject） | `PlanPanel` | 四家都在收敛这个范式 |
| attention inbox（跨会话待人工项聚合） | `InboxSurface.tsx` | 独有 |
| 语音转写（Web Speech）+ 图片粘贴 | `Composer.tsx` | 独有 |

## 三、竞品 2025-2026 收敛范式

四款竞品（Cursor 3 / Antigravity 2.0 / Codex / Claude Code）都在收敛到同一套范式：

**Plan → inline diff review → background/cloud agent + 通知**

具体共性：
1. **Plan Mode**：先读后改，编辑门禁。天枢已有。
2. **inline diff review 是主产出物**：用户真正 act on 的是 diff+accept/reject，不是聊天消息。这是 GUI 相对纯终端的核心价值。
3. **多 agent 编排面板**：Cursor 的 Agents Window、Antigravity 的 Manager view、Codex 的多终端、Claude Code 的多会话 sidebar。单聊天线程不再是模型，"监督者"才是。
4. **background/cloud 执行 + 完成通知**：长任务挪出本地，完成通知。四家都做。
5. **git worktree 作会话隔离单位**：并行 agent 不互相踩。
6. **持久 context/memory + plan artifacts**：跨会话保留约定，减少冷启动退化。

天枢已覆盖 Plan + 通知 + 多会话编排。缺的是 diff review 的持久化形态和几个关键能力。

## 四、真实 Gap（核实后确认）

### Gap 1（最大）：无文件树 / 工作区浏览器
`ProjectSidebar.tsx` 是**会话树**（按 cwd 分组的对话），不是文件树。没有文件系统浏览、没有任意文件打开。`FileViewer.tsx` 只读但只能从 review panel 进入。

但天枢定位是**"无 IDE"**（ROADMAP.md 明说），所以**不该做完整编辑器**。该做的是只读文件浏览器——补"看代码"，不补"改代码"，改代码交给 agent。

### Gap 2：diff 是 artifact 绑定的，无"工作树变更"持久视图
`DiffView.tsx` 能力够（unified + side-by-side + hunk + 行号），但只在 agent 产出 artifact（`a.kind === 'diff'`）或审批时**弹 modal**。没有 Cursor 那种"未提交变更"持久面板。`GitSurface.tsx` 只是 `git log --graph` 文本，无 commit 详情/暂存/per-file diff/commit 操作。

### Gap 3：auto-update 完全不工作 ⚠️ 用户直接感知
`tauri.conf.json:53-61` updater 端点是 placeholder（`https://example.com/tianshu-updates.json`），**pubkey 为空**，`SettingsSurface.tsx:153-183` 的 UI 直说"更新服务器尚未配置"。无法发布签名更新。**所有竞品都能自动更新。** 这是发布前必须修的。

### Gap 4：单终端，无多路复用
一个 PTY 面板（`TerminalPanel.tsx`），无 tabs/splits。Codex 的卖点之一就是多终端多文件并排。

### Gap 5：GitHub 只读
`GithubPanel.tsx` + `/github/prs` 能列 PR 和详情，但不能创建/review/comment/merge。

### Gap 6：无 keymap 配置 + 设置浅
快捷键硬编码（`App.tsx:59-131`）。设置无字体/字号/tab size/AGENTS.md 编辑/model 参数。

## 五、优化优先级（用户感知 × 实现成本）

| 优先级 | Gap | 用户感知 | 成本 | 建议 |
|---|---|---|---|---|
| **P0** | Gap 3 auto-update 接通 | 极高（无法更新=不可发布）| 低（配 endpoint + 公钥 + CI）| **立即做** |
| **P0** | Gap 2 工作树变更持久 diff 视图 | 高（agent-first 核心交互）| 中（复用 DiffView + 加 git status 聚合面）| 第二做 |
| **P1** | Gap 1 只读文件浏览器 | 高（看不了代码）| 中（文件树 + 复用 FileViewer）| 第三做 |
| **P1** | Gap 4 多终端 tabs/splits | 中 | 中 | 第四做 |
| **P2** | Gap 5 GitHub 写操作 | 中 | 中（创建/review/merge）| 按需 |
| **P2** | Gap 6 keymap + 设置深挖 | 低 | 低 | 按需 |

## 六、核心设计原则

天枢定位是 **"Antigravity 2.0 范式 agent-first 外壳"**（Cargo.toml + ROADMAP.md 明说），不是 Cursor 那种 IDE。优化方向：

- **强化 agent-first 差异化**（diff review 持久化、orchestration 可视化、trust 层细化）
- **不模仿 IDE**（不做 Monaco 编辑器、不做 hunk-level inline edit、不做代码补全）
- **Gap 1 文件浏览器保持只读**就是这个原则——补"看代码"，不补"改代码"，改代码交给 agent

这也呼应了 ROADMAP.md 的缰绳：「runtime 内核不重写，只在 `src/server/` 加 API 面；不破 prompt frozen/cache 不变量；sidecar 只绑 127.0.0.1 + token fail-closed；SSE 必带 seq、可重连、可补读；复用 ArtifactStore/TaskRegistry/SessionRegistry，各归其位不揉成上帝对象。」

## 七、对照竞品的能力矩阵

| 能力 | Cursor 3 | Antigravity 2.0 | Codex | Claude Code | **天枢** |
|---|---|---|---|---|---|
| 核心隐喻 | Agents Window | Editor+Manager 双视图 | 多终端多文件 | 多会话 sidebar | workspace 三栏 |
| Plan Mode | ✓ | ✓ Plan view | — | ✓ 旗舰 | ✓ PlanPanel |
| inline diff review | ✓ hunk 级 | ✓ Editor 内 | ✓ review 面板 | ✓ 编辑器内 | ✗ artifact/modal 绑定（Gap 2）|
| 多会话编排 | ✓ Agents Window | ✓ Manager | ✓ 多终端 | ✓ sidebar | ✓ **delegation tree** |
| background/cloud | ✓ cloud agents | ✓ 后台 | ✓ 持久 | ✓ Dispatch | ✓ 调度任务 |
| 完成通知 | ✓ | ✓ | ✓ | ✓ | ✓ **跨会话 + 三档** |
| 成本分析 | — | — | — | — | ✓ **独有** |
| 信任层/回滚 | accept/reject | — | — | — | ✓ **三档+checkpoint** |
| 文件树/浏览 | ✓ 完整 | ✓ 完整 | ✓ | ✓ | ✗ **Gap 1** |
| 编辑器 | ✓ 完整 IDE | ✓ 完整 IDE | 部分 | ✓ 编辑器内 | ✗（定位无 IDE）|
| auto-update | ✓ | ✓ | ✓ | ✓ | ✗ **Gap 3** |
| 多终端 | — | — | ✓ 卖点 | — | ✗ **Gap 4** |
| GitHub | ✓ 深 | — | — | — | 只读（Gap 5）|

**定位结论**：天枢在 orchestration/trust/cost 三个维度领先或独特，在 IDE-class 能力（文件树/编辑器/diff 持久化/多终端）有 gap——但其中编辑器 gap 是**有意的定位选择**，其余 gap 可补且应补。

## 八、关键文件索引

| 文件 | 角色 |
|---|---|
| `src-tauri/src/lib.rs:195` | sidecar spawn（agent 运行时）|
| `src-tauri/src/pty.rs` | PTY 终端（与 agent 解耦）|
| `src/runtime/client.ts` | HTTP API 面（50+ 端点）|
| `src/runtime/sse.ts` | SSE 流消费（seq/重连/补读）|
| `src/surfaces/*.tsx` | 8 个顶层视图 |
| `src/state/event-reducer.ts` | SSE → React 状态规约 |
| `src-tauri/tauri.conf.json:53-61` | updater placeholder（Gap 3 源）|
| `src/components/DiffView.tsx` | diff 渲染（Gap 2 复用基础）|
| `src/components/FileViewer.tsx` | 只读文件查看（Gap 1 复用基础）|
| `ROADMAP.md` | 迭代路线（缰绳 + I1/I7 未做）|

## 来源

- [Cursor 3 agent-first interface (InfoQ)](https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/)
- [Cursor 3 Agents Window guide (digitalapplied)](https://www.digitalapplied.com/blog/cursor-3-agents-window-complete-guide)
- [Antigravity deep dive (Medium)](https://www.medium.com/@vignarajj/coding-without-gravity-a-deep-dive-into-googles-antigravity-agent-first-development-platform-3b02eb1e69fd)
- [Antigravity getting started (Google codelabs)](https://codelabs.developers.google.com/getting-started-google-antigravity)
- [Codex app features (OpenAI)](https://developers.openai.com/codex/app/features)
- [Claude Code desktop docs](https://code.claude.com/docs/en/desktop)
- [Claude Code desktop redesign (miraflow)](https://miraflow.ai/blog/claude-code-desktop-redesign-parallel-sessions-routines-workspace-guide)
- [Claude Code autonomy (Anthropic)](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
