# k1 · 桌面端对标 Codex 新版体验差距盘点

> 日期：2026-07-01
> 对标对象：OpenAI Codex 桌面端 2026 新版（含 4 月大更新：Computer Use、插件市场、持久记忆、应用内浏览器、长期自动化等）
> 记录范围：天枢桌面端当前已实现功能 vs Codex 桌面端新版在用户体验层面的核心差距

---

## 一、当前天枢桌面端已有的能力

- **线程工作台 + Composer**：@file 引用、图片上传、斜杠命令、Plan/Agent 模式切换、模型/星域/技能选择
- **审查面板（ReviewPanel）**：文件浏览器、Changes、Plan、Task、Artifacts、GitHub PR 列表
- **任务中控台（MissionControl）**：多会话卡片监控，支持 live SSE mini-stream
- **自动化（Automations）**：定时 / cron / 一次性任务
- **需处理中心（Attention/Inbox）**：跨会话待审批 / 失败 / 完成提醒
- **Git 分支图、Insights、委派树、议事会、Hooks、Skills、MCP 设置**
- **PlusMenu + 命令面板 + 全局快捷键**
- **个性化**：主题、字体、玻璃效果、UI 密度、存储位置、通知偏好
- **布局**：可折叠侧边栏 / 审查面板、可调整面板宽度

---

## 二、Codex 桌面端新版核心体验能力

基于公开资料与产品更新，Codex 2026 新版的核心体验能力可分为以下几层：

1. **Computer Use / 桌面 GUI 控制**
   - 在 sandboxed workspace 中控制 macOS/Windows 桌面应用
   - 点击、输入、滚动、拖拽、打开任意 App
   - 不阻塞用户当前焦点，与用户操作并行

2. **应用内浏览器（In-app Browser）**
   - agent 可在桌面端内浏览网页、查看文档、截图
   - 支持填写表单、搜索、读取网页内容作为上下文

3. **第三方插件市场 / 预置集成**
   - 90+ 官方插件：Linear、Slack、Notion、Gmail、Figma、Vercel、CircleCI 等
   - 插件可跨 CLI / IDE / 桌面端 / Cloud 共享

4. **持久记忆（Persistent Memory）**
   - 三层记忆：用户级、项目级、会话级
   - 记住用户偏好、过往修正、费时获取的信息

5. **长期任务调度与延续（Deferred Scheduling）**
   - 任务可跨数天/数周自动唤醒
   - 保留完整上下文继续执行
   - 支持条件触发、失败重试

6. **主动建议 / 每日摘要（Proactive Suggestions）**
   - 基于项目背景、已连接插件、记忆主动推荐下一步
   - 例如：识别 Google Docs 未处理评论，整合 Slack/Notion/代码库背景生成优先级行动清单

7. **多文件/多终端并排查看**
   - 同时打开多个文件、多个终端
   - 支持 PR review 多文件 diff

8. **实现方案预览系统（Preview System）**
   - 一次任务生成 2-4 种实现方案
   - 用户选择后再执行

9. **PR 评审工作流**
   - 查看 PR diff、逐文件评论、request changes、approve

10. **网络访问沙箱控制**
    - 仅包管理器 / 全网络 / 白名单 / 完全隔离

11. **图片生成**
    - agent 可按需生成图片并插入工作流

12. **移动端远程任务（iOS/Android）**
    - 手机端排队任务，桌面端/云端执行

---

## 三、天枢桌面端体验差距清单

### P0 — 体验代差级缺失

| 能力 | Codex 新版表现 | 天枢现状 | 影响 |
|---|---|---|---|
| **Computer Use / 桌面 GUI 控制** | 控制 macOS/Windows 桌面应用、点击、输入、滚动、拖拽 | 完全缺失 | Codex 2026 最大卖点；没有它，agent 只能操作文件和 shell |
| **应用内浏览器** | 内置浏览器查文档、看网页、截图、填表单 | 只能外部打开链接 | 极大限制 agent 自主获取上下文的能力 |
| **第三方插件市场 / 预置集成** | 90+ 官方插件，一键连接常用工具 | 只有通用 MCP 接口，无预置插件/市场 | 用户拿到产品后“什么都连不上”，需要手动配 MCP |
| **长期任务调度与延续** | 任务跨数天/数周自动唤醒，保留上下文继续执行 | 简单定时任务，无失败重试、无跨天延续 | 无法做“今晚跑完测试，明早继续”这类真实工作流 |
| **主动建议 / 每日摘要** | 根据记忆+项目状态+插件数据主动推荐下一步 | 完全缺失 | 产品被动，用户不知道 agent 能做什么 |

### P0 能力的市场与用户反馈

以下反馈来自公开社区讨论、评测文章、GitHub issue 与官方论坛，用于验证上述 P0 能力是否真的是用户痛点，以及 Codex 在这些方向上的实际表现与限制。

#### 1. Computer Use / 桌面 GUI 控制

- **市场定位**：这是 Codex 2026 年 4 月大更新的「headline feature」，被多家评测机构视为与 Claude Code 拉开差异化的核心能力。Codex 刻意采用「后台并行」设计：agent 拥有独立光标和上下文，可与用户当前工作并行，不打断焦点。
- **用户认可**：有用户在 GitHub 反馈中写道，Codex 基础很强，但「Claude increasingly feels like an agent system that is escaping the 'coding assistant' box」，希望 Codex 把 computer-use / remote-control 推到前台。
- **实际限制**：
  - 首发仅 macOS，Windows 用户被明确排除在外；后续 Windows 版本仍未完全上线 Computer Use。
  - EU、UK、Switzerland 不可用，企业出海场景受限。
  - Windows 上出现过严重隐私/安全 bug：Codex 本应在对话内输入的文本被错误路由到外部浏览器窗口的聊天输入框，导致本地路径、任务内容、邮件草稿泄漏。
- **对天枢的启示**：用户确实把「控制桌面 App」视为下一代 agent 体验的标志；但 Windows 兼容性与安全边界做不好，会直接劝退企业用户。

#### 2. 应用内浏览器

- **正面价值**：用户和评测者一致认为 in-app browser 的最大价值是「不再需要在代码编辑器、浏览器、反馈工具之间切换」。可以在渲染页面上直接批注「这个按钮再高 20px」，Codex 立即执行。
- **体验痛点**：
  - 浏览器自动化状态与用户可见状态不同步：Codex 报告已能看到页面，但用户侧面板仍显示空白。这种「模型看到、人看不到」的错位被用户直接形容为「看起来像幻觉」。
  - Windows 上 Chrome 插件/Native Messaging Host 注册表键缺失，导致认证后的浏览器自动化路径不可用，只能回退到无法共享用户 Chrome 会话的 in-app browser。
  - 地区限制：挪威/EU 用户即使安装了 Chrome 扩展并显示 Connected，插件市场仍搜索不到 Chrome plugin。
- **安全反馈**：官方文档明确提醒「treat page content as untrusted」，因为任意网页可能通过 prompt injection 影响 agent；若允许访问浏览器历史，内部 URL、搜索词、cookie 都可能进入上下文。
- **对天枢的启示**：应用内浏览器不是「加个 webview」那么简单，用户最在意的是「可见即可控」的同步感和 Windows/企业场景下的稳定性。

#### 3. 第三方插件市场 / 预置集成

- **市场反响**：2026 年 3 月 27 日 Codex 推出插件系统，首批覆盖 Slack、Figma、Notion、Gmail、Google Drive、Linear、Sentry、GitHub 等。被中文/英文媒体一致描述为 Codex 从「AI 代码生成工具」向「工作流协调器」转型的关键一步。
- **企业采用**：Fortune 报道 Cisco、NVIDIA、Ramp、Rakuten、Harvey 等企业已在开发团队部署 Codex 插件。Codex 周活跃用户超过 160 万，推出 GPT-5.3 Codex 后用户增长超过 3 倍。
- **用户视角**：
  - 评测指出「真实软件开发 80% 的工作是上下文理解——读 Slack 讨论、看 Figma 设计稿、整理 Notion 文档——而不是写代码」。没有插件时，AI 只是聪明的自动补全；有插件后，它才真正理解任务。
  - Figma 插件被单独点名：设计到代码的 handoff 是长期痛点，Codex 能直接读取设计文件消除了一个真实步骤。
  - 与 Claude MCP 的对比：MCP 是开放标准、社区贡献多；Codex 插件是封闭生态但「开箱即用」。两者都指向同一个目标——让 agent 融入既有工作流。
- **对天枢的启示**：用户不是想要一个「插件市场」这个概念，而是想要「拿到产品就能连 Slack/Notion/Figma/GitHub」。天枢目前只有通用 MCP 接口，等于把配置负担丢给用户。

#### 4. 长期任务调度与延续

- **市场需求**：用户明确提出希望 Codex 从「单次提示」转向「跨天/跨周的背景工程 agent」。这是 2026 年 agentic 工具的共同演进方向。
- **Codex 现状与痛点**：
  - Codex CLI 目前没有原生调度（公开 feature request），持久记忆也主要是 session history + AGENTS.md，而非跨项目的 living knowledge graph。
  - 桌面端 Automations 仅覆盖定时本地任务，缺少跨 session、跨 surface 的连续性。
  - 自动化任务出现「无消费上限」问题，有用户报告 headless/autonomous 模式下单次产生 $313、$350 账单，或因孤立进程持续计费。
  - 任务生命周期管理薄弱：孤立进程、cron 任务误报为 killed、会话恢复后 thinking block 损坏等问题频繁出现。
- **竞品对比**：Hermes、OpenClaw 等开源方案把「持久记忆 + 自托管调度 + 多平台消息网关」作为核心卖点；这说明市场已经把「长期自主运行」视为刚需。
- **对天枢的启示**：长期任务调度不能只做一个 cron 触发器，还需要预算控制、状态延续、失败重试、进程清理和会话恢复。

#### 5. 主动建议 / 每日摘要

- **用户期待**：Codex 用户在高赞反馈中把「更积极的 memory / continuity / repeated-use adaptation」和「主动推荐下一步」列为最大诉求之一，希望 Codex 从「按指令执行」进化到「知道我该做什么」。
- **市场趋势**：2026 年社区 digest 把「Persistent Memory & Context Bridging」和「Scheduling & Automation」并列为 agentic 工具的两大共同演进方向。Claude Cowork 等竞品已经在推动 agent 主动控制邮件、日历、表格。
- **当前体验落差**：Codex 用户更常抱怨的仍是「产品告诉我已经 reset 但仍在提示 quota 耗尽」「会话管理混乱」「CLI 与 Desktop 体验割裂」。这说明「主动建议」虽然被期待，但前提是基础的可预测性和连续性先做好。
- **对天枢的启示**：主动建议不能孤立做，它依赖于持久记忆、插件数据、项目状态三者的整合。天枢可以跳过 Codex 当前的「基础体验不连贯」阶段，直接把主动建议建立在稳定的记忆+调度之上。

### P1 — 明显体验短板

| 能力 | Codex/Cursor 表现 | 天枢现状 | 影响 |
|---|---|---|---|
| **输入框附件格式反馈** | 拖拽/选择不支持的格式（如压缩包）时即时提示“不支持的文件类型” | ✅ 已实现：选择/拖拽用 inline error，粘贴用 toast，压缩包明确提示解压 | 用户不知道为什么不生效，反复尝试产生挫败感 |
| **多文件/多终端并排编辑** | 同时打开多个文件、多个终端标签并排 | 文件浏览器只读；终端只有一个标签 | 复杂任务需要频繁切换，无法“在工具里完成” |
| **PR 评审工作流** | 查看 PR diff、逐文件评论、request changes | GitHub Panel 只有列表和文件清单 | review 体验停留在“看标题” |
| **实现方案预览/分支** | 一次生成 2-4 种实现让用户选 | Plan 模式单一路径 | 用户缺少控制权，plan 被否决成本高 |
| **网络访问沙箱控制** | 可选仅包管理器/全网络/白名单/隔离 | 无网络策略 UI | 安全感和企业场景受限 |
| **图片生成** | agent 可按需生成图片并插入 | 只支持上传图片（vision） | 前端/UI 任务能力不完整 |
| **更丰富的 Skills 发现/安装界面** | 可创建、分享、浏览 Skills | Skills 主要靠文件系统，无 UI 市场 | 普通用户难以发现和使用 |

### P2 — 加分项 / 远期

- **移动端远程排队**：Codex 有 iOS/Android app 可下发任务
- **Tab 自动补全 / 内联编辑**：Cursor 强项，天枢没有
- **更智能的记忆三层（用户/项目/会话）**：天枢有项目知识库和会话记忆，但缺少显式的“用户偏好学习”
- **CI/CD 原生集成**：Codex 可直接触发 CircleCI/GitLab 并读取结果

---

## 四、建议的近期落地优先级

如果按“最小可行追赶”排序：

### 阶段 1：补齐 agent 能控制的范围（进入 Codex 体验区间）

1. **应用内浏览器**
   - 在 ReviewPanel 新增 Browser tab
   - 让 agent 能请求打开 URL、截图、提取文本
   - 这是 Computer Use 的前置能力

2. **预置 MCP / 插件发现页**
   - 把常用集成（GitHub、Slack、Notion、Linear）做成一键启用的 MCP 配置模板
   - 在 Settings > Integrations 增加“推荐插件”列表

3. **长期任务/自动化的延续与重试**
   - 扩展现有 AutomationsSurface：失败重试、执行历史、状态看板
   - 让自动化任务能复用已有会话上下文

### 阶段 2：提升复杂任务工作效率

4. **多终端 + 文件编辑升级**
   - TerminalTabs 支持多标签并排（状态管理已存在，需 UI 升级）
   - 文件浏览器从只读升级为可编辑（至少支持简单文本修改）

5. **PR diff review**
   - 在 GitHubPanel 中增加 diff 查看和评论能力

### 阶段 3：差异化体验

6. **实现方案预览系统**
   - Plan 模式下生成多个方案供用户选择

7. **主动建议 / 每日摘要**
   - 基于记忆和项目状态生成建议

---

## 五、与 Cursor 的差异补充

Codex 走的是“异步云/桌面 agent”路线，Cursor 走的是“IDE 内实时协作”路线。天枢当前介于两者之间，但更偏 Codex。如果要同时补齐 Cursor 体验，还需要：

- **Composer 多文件编辑区**（不只是 chat + review panel）
- **Tab 自动补全**
- **Inline diff / Apply 确认流**
- **.cursorrules 等价规则文件 UI**

---

## 六、一句话总结

天枢桌面端在“agent 能控制什么”这个核心命题上缺口最大——不能控浏览器、不能控桌面 App、不能连常见第三方工具、不能让任务长期自主运行。先把这几块补上，才算真正进入 Codex 新版的体验区间。

---

## 七、四方对标 · 用户日常体验差距（2026-07-02 补充）

> 前六节以 Codex 桌面版为单一标尺，且偏“炫技型 P0”。本节把标尺扩到四家最新版，并把视角切到**用户每天都会碰到的体验**——不是“能不能做惊艳的事”，而是“日常工作流里有没有摩擦、有没有安全网”。
>
> 对标对象与关键日常特性来源：
> - **Cursor 3.0 / 3.2**（2026-04）：Agents Window 成主界面、Agent Tabs 并排/网格、agent chat 即编辑器标签页、Plan Mode（Shift+Tab）、`/best-of-n`（多模型/多温度并行 worktree + Conductor 择优）、`/multitask` 异步子代理、逐文件 reviewable diff、per-change 会话快照、Tab 补全/inline 编辑。
> - **Google Antigravity 2.0**（2026）：Artifacts 富交付物（任务清单/实现计划/walkthrough/截图/浏览器录制）作为“可验证”的一等公民、工具调用按 task 分组 + 高层摘要 + 进度、`/browser` 子代理、异步子代理、Cron sidecar 定时任务、语音转写、granular 工具审批门。
> - **Codex 桌面版 2026**：见第二~三节（Computer Use、应用内浏览器、插件市场、持久记忆、长期调度、主动建议、方案预览、PR 评审、网络沙箱、图片生成）。
> - **Claude Code 最新版**（2026）：自动 checkpoint（每次改动前快照，`/rewind` 或双击 Esc，可选**只恢复代码 / 只恢复对话 / 两者都恢复**，跨会话保留）、子代理（隔离上下文、`/agents`）、后台任务（`run_in_background` 不阻塞轮询）、Plan Mode、Auto Mode（分类器 gating 高危命令）、对抗式复查（`/code-review` 子代理在新上下文里审 diff 回填问题）。

### 7.1 先勘误：文档前几节把已交付的东西写成了缺口

盘点时点已过期，以下“现状”与代码实况不符，继续拿它排优先级会错配资源：

| 文档旧结论 | 代码实况 | 证据 |
|---|---|---|
| P1「输入框附件格式反馈：选择后无反馈或静默失败」 | **已实现**：不支持格式 toast「不支持的格式（仅 PNG/JPEG/WebP/GIF/BMP）」、超 5MB、超 4 张均有明确提示 | `desktop/src/components/Composer.tsx` `addFiles()` |
| P1「多终端：终端只有一个标签」 | **已实现多标签**：新建/关闭/切换，每标签独立 PTY，非活动标签保活 | `desktop/src/components/TerminalTabs.tsx` |
| P1「PR 评审停留在看标题 / review 体验弱」（本地部分） | **本地 Changes 已是 Antigravity 风格**：逐文件卡片、+/- 汇总、单/双列切换、懒加载 diff | `desktop/src/surfaces/ChangesTab.tsx` + `DiffView.tsx` |
| （未提）语音输入 | **已实现**：Composer 集成 Web Speech，中文识别、interim/final | `desktop/src/components/Composer.tsx` `toggleRecording()` |
| （未提）工具调用呈现 | **已实现 Cursor 3.0 风格分组**：read/search 折叠成摘要行、action 工具独立卡片、密度可切、run_tests 汇总 | `desktop/src/components/ToolGroup.tsx` |

天枢的**输入体验（@file / 图片 / 斜杠 / 语音 / IME 守卫 / mention chips）和工具流呈现**其实已经打平甚至局部领先——日常摩擦不在这里。真正的日常落差在下面。

### 7.2 日常体验对标矩阵

维度按“用户每次会话的触碰频率”排列。✅=达标 / 🟡=部分 / ❌=缺失。

| 日常维度 | Cursor 3.0 | Antigravity 2.0 | Codex 2026 | Claude Code | 天枢现状 |
|---|---|---|---|---|---|
| 计划前置（Plan Mode） | ✅ | ✅ | ✅ | ✅ | ✅ Shift+Tab |
| 工具流折叠 + 高层摘要 | ✅ | ✅ | ✅ | ✅ | ✅ ToolGroup |
| 输入体验（@/图/斜杠/语音） | ✅ | ✅(含语音) | ✅ | 🟡(终端) | ✅ |
| 多终端标签 | ✅ | ✅ | ✅ | 🟡 | ✅ TerminalTabs |
| 本地改动 diff 审查 | ✅ | ✅ | ✅ | ✅ | ✅ ChangesTab |
| **代码级回溯（恢复文件/对话）** | ✅ per-change 快照 | ✅ | 🟡 | ✅ /rewind 三选一 | 🟡 **只回退对话，不恢复代码** |
| **PR 逐文件 diff + 行内评论 + approve** | ✅ | ✅ | ✅ | ✅ | ❌ 仅列表+文件名+comment |
| **多方案 best-of-n / Plan 多路径** | ✅ /best-of-n | ✅ | ✅ 方案预览 | 🟡 | ❌ 单一 Plan |
| **多 agent 并排交互（Agent Tabs）** | ✅ 并排/网格 | ✅ Manager | ✅ | 🟡 后台 | 🟡 **仅监控看板，不可并排交互** |
| 富 Artifacts（walkthrough/录制/计划） | 🟡 | ✅ 一等公民 | ✅ | 🟡 | 🟡 有 ArtifactCard，偏文件 |
| 应用内浏览器（可见即可控） | 🟡 | ✅ /browser | ✅ | ❌ | 🟡 有 browser_debug + 截图内联，无可见浏览器面板 |
| 文件 inline 编辑 / Tab 补全 | ✅ 强项 | ✅ IDE | 🟡 | ❌ | ❌ FileViewer 只读 |
| 后台任务不阻塞 | ✅ | ✅ | ✅ | ✅ run_in_background | 🟡 JobsDock |
| 高危命令/网络 gating | ✅ | ✅ granular | ✅ 网络沙箱 | ✅ Auto Mode 分类器 | 🟡 3 档自治，无网络策略 UI |
| 对抗式复查（新上下文审 diff） | 🟡 | ✅ 自证 | 🟡 | ✅ /code-review | 🟡 有验证 hook，无 UI 化复查 |
| 主动建议 / 每日摘要 | 🟡 | 🟡 | ✅ | 🟡 | ❌ |
| 用户层持久记忆（偏好学习） | 🟡 | 🟡 | ✅ 三层 | 🟡 | 🟡 有项目+会话，缺用户偏好 |

### 7.3 按“日常摩擦”重排的提升清单

> 与第三节按“功能代差”排序不同，这里按**用户每天实际卡壳/没安全网**排序。

**Tier A — 每次会话都碰、且落差明确（建议先做）**

1. **代码级回溯（把 FileHistory 接到 Rewind UI）** — 性价比最高。
   - 现状：runtime **已有** `FileHistory`（`src/agent/__tests__/file-history.test.ts`：restores file to previous version / reports latest snapshot id），但桌面端 `RewindOverlay` 只调 `rewindSession` 回退对话并回填 prompt，**没有恢复文件内容的入口**。
   - 目标：对齐 Claude Code `/rewind` 的三选一——只恢复代码 / 只恢复对话 / 两者。这是四家都强调的“敢让 agent 大改”的安全网，缺它用户每次大改都心里没底。
   - 工程量：小-中（能力已在，主要是把 FileHistory 快照点接到现有 Rewind 面板 + 增加“恢复代码”动作）。

2. **PR 逐文件 diff + 行内评论 + approve/request-changes** — 本地 diff 已很好，PR 侧还停在“看文件名”。
   - 现状：`GithubPanel` 只有 PR 列表 + 变更文件名 + 顶层 comment，无 diff、无行评论、无审批动作。
   - 目标：复用已有 `DiffView`/`ChangesTab` 卡片式渲染，接 `gh pr diff` + `gh pr review`，让评审能在产品内闭环。

3. **多方案 / best-of-n** — 非平凡任务每天都要做的决策点。
   - 现状：Plan 模式单路径，plan 被否成本高。
   - 目标：Plan 模式下并行生成 2-4 个方案（可复用星域/多模型），给出取舍对比后由用户选，对齐 Cursor `/best-of-n` + Conductor、Codex 方案预览。

4. **多 agent 并排交互（Agent Tabs）** — 我们有并行能力却看不到、控不了。
   - 现状：`MissionControlSurface` 是监控看板（N 卡片 mini-stream，同时只有一个线程加载完整流）；`ThreadTabs` 有标签但并非并排对话。
   - 目标：让 2+ agent 会话像 Cursor Agent Tabs 一样并排/网格查看与介入，而非“只能围观”。

**Tier B — 高频、工程量更大**

5. **应用内浏览器（可见即可控）** — 已有 browser_debug 截图内联，缺的是“用户侧可见且与 agent 同步”的浏览器面板（Codex 的头号体验痛点就是“模型看到、人看不到”，别重蹈覆辙）。
6. **文件 inline 编辑 / Tab 补全** — `FileViewer` 只读，复杂任务仍需切到外部编辑器；这是 Cursor/Antigravity IDE 的日常强项（较大投入）。
7. **富 Artifacts** — 把 ArtifactCard 从“文件列表”升级为 Antigravity 式可验证交付物（实现计划、walkthrough、浏览器录制），让 agent 用 artifact 自证工作。

**Tier C — 差异化 / 远期**

8. 主动建议 / 每日摘要（依赖持久记忆 + 项目状态 + 集成数据，别孤立做）。
9. 用户层持久记忆（显式偏好学习，补齐三层记忆）。
10. 网络沙箱策略 UI（在现有 3 档自治上叠加“仅包管理器 / 白名单 / 全网 / 隔离”）。

### 7.4 一句话结论（日常体验版）

天枢的**输入、工具流呈现、本地 diff、多终端**已经进入第一梯队；日常体验真正的短板是**没有代码级安全网（回溯只回对话）、PR 评审不闭环、任务只有单方案、并行 agent 只能围观**。这四件 Tier A 都不是“新造惊艳能力”，而是把已有能力补上最后一公里——投入产出比远高于去追 Computer Use。
