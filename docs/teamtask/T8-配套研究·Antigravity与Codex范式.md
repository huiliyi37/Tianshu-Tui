# 配套研究报告 — Antigravity vs Codex 范式（T8 事实地基）

> 日期：2026-06-09。来源：web 搜索核实，信源见末。
> 用途：T8 的事实地基。**但注意：本报告是"敌情侦察"，不是"图纸"。** 借鉴四支柱只是认清战场，真正的路见 T8-极限版（杀出别人看不见的路）。
> 关键校正：天枢的建设周期是 **25 天（2026-05-15 起，1988 次提交），不是几个月。** 子代理研究时误判为大厂级多月工程——错了。这个误判本身就是线索：见 T8-极限版 §0。

---

## 1. Google Antigravity

**核心范式：agent-first，不是 editor-first。** Agent Manager 是产品中心，editor 退为 agent 的一个工作面（区别于 Cursor/Windsurf 的 editor-first：在编辑器上加 AI 侧栏）。

**两个 surface：**
- **Editor View**：类 VS Code 常规 IDE + agent 侧栏，人想下场微调时用（同步协作）。
- **Agent Manager View**：多 agent 控制中心 / mission control，编排多 agent 跨 workspace 并行异步执行（委派后离开、回来 review）。

**Artifacts（关键创新，"Trust Layer"）：** agent 每个动作产出可验证交付物——task list / implementation plan / walkthrough / screenshots / browser recordings / logs / test results——而非裸 tool call。动机：agent 越自主产出越多，人无法逐行 review，于是用更高抽象的人类可读验证物替代逐行审查。"验证逻辑而不必读每行代码。"

**工具面：** 直接访问 editor + terminal + 集成 browser；有 local memory。Browser 用于视觉验证——UI 测试、视觉回归、交互调试、截图、会话录制（agent 真打开浏览器跑一遍并录下当证据）。

**异步：** 委派后异步 review 为主（"asynchronous, verifiable coding workflows"）。

**技术底座：** VS Code 重度 fork，由原 Windsurf 团队打造（2025-11 Google 收购）。

**模型：** Gemini 3 Pro/Flash 主力；开放多模型（Claude Sonnet/Opus 4.6、GPT-OSS-120B）。

---

## 2. OpenAI Codex（2025 新版）

**三种形态：** Cloud agent（ChatGPT 侧栏委派，每任务跑独立云沙箱，1–30 分钟，完成提 PR）；CLI（`@openai/codex`）；IDE extension；后追加 Codex App（macOS 2026-02、多 agent command center，git worktree 隔离）；Slack 集成、SDK、GitHub Action。全部以 ChatGPT 账户为连接层，session 跨形态互通。

**范式：** 委派 → 独立云沙箱（默认断网，预装 repo）执行 → 可验证证据（citations / terminal logs / test results）→ 提 PR review。从第一天就并行多任务。强调"agent 是额外的 reviewer，不替代人审"。

**模型：** GPT-5-Codex（codex-1 后继）。单一自家模型生态。

**安全底座：** 默认沙箱 + 断网，危险动作请求许可，云端可信域名白名单。

---

## 3. 范式要素对比

| 维度 | Antigravity | Codex |
|---|---|---|
| agent-first 程度 | 高（Agent Manager 为中心） | 高（云端委派起家，App 后才有桌面指挥中心） |
| 多 agent 编排 | workspace 并行 + Manager dashboard | 云沙箱并行 + worktree 隔离 |
| artifact 验证 | 视觉工件（截图/录屏/walkthrough）押注 | 代码证据（PR diff/logs/citations/tests）押注 |
| 跨 surface | editor+terminal+browser 三面 | 云沙箱为主，browser 非核心 |
| 异步自主 | 委派后异步 review | 委派后云端跑、提 PR |
| 技术底座 | VS Code fork（Windsurf 团队） | 非 fork：CLI+IDE 插件+云+App+SDK，账户连接 |
| 模型 | 多模型（含 Claude、开源） | 单一自家 GPT-5-Codex |

**同：** 都 agent-first、委派+异步并行+可验证证据；都把"多 agent 指挥中心"作为新主界面。
**异：** ①底座哲学——Antigravity 改造 IDE，Codex 绕开 IDE。②验证物——视觉工件 vs 代码证据。③浏览器——一等面 vs 默认断网。④模型开放度——多模型 vs 锁自家。

---

## 4. 信源

- [Antigravity 官方站](https://antigravity.google/)
- [Wikipedia: Google Antigravity](https://en.wikipedia.org/wiki/Google_Antigravity)
- [datastudios: Antigravity with Gemini 3 全launch概览](https://www.datastudios.org/post/google-antigravity-with-gemini-3-tools-agents-and-full-launch-overview)
- [datacamp: Claude Code vs Antigravity（Windsurf 团队收购 + 视觉验证浏览器）](https://www.datacamp.com/blog/claude-code-vs-antigravity)
- [aifire: Antigravity Agent Manager（Artifacts = Trust Layer）](https://www.aifire.co/p/mastering-the-antigravity-agent-manager-2026-guide-part-1)
- [smartscope: Antigravity Architecture Deep Dive](http://smartscope.blog/en/generative-ai/google-gemini/antigravity-architecture-deep-dive/)
- [augmentcode: Antigravity vs Windsurf](https://www.augmentcode.com/tools/antigravity-vs-windsurf-comparison)
- [nimbalyst: Cursor vs Windsurf vs Antigravity](https://nimbalyst.com/blog/cursor-vs-windsurf-vs-antigravity-vs-nimbalyst/)
- [OpenAI: Introducing Codex](https://openai.com/index/introducing-codex/)
- [OpenAI: Codex now generally available](https://openai.com/index/codex-now-generally-available/)
- [OpenAI: Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [OpenAI: Introducing upgrades to Codex](https://openai.com/index/introducing-upgrades-to-codex/)

> 注：以下 §1-§3 写于早期，基线停在 **Antigravity 1.0（2025-11）**。2026-06-09 已核实最新版本，补在 §5——以 §5 为准，§1-§3 作演进对比保留。

---

## 5. 最新版本核实（2026-06-09，官方源）

> 校正：本报告 §1-§3 的 Antigravity 部分停在 1.0，过期约 6 个月。以下为一手源核实，区分「官方坐实」与「官方但 aspirational（营销措辞）」。

### 5.1 Google Antigravity 2.0（2026-05-19 Google I/O 发布）

| 项 | 事实 | 来源性质 |
|---|---|---|
| 形态剧变 | 1.0 是「带 Agent Manager 的 VSCode fork IDE」；**2.0 是独立桌面 App（mac/Linux/Win，不依赖任何 IDE）+ Go CLI + SDK + Managed Agents API**，并吞并 Gemini CLI / Code Assist 个人用户 | 官方坐实（TechCrunch、Google Cloud blog） |
| 三 surface 共享 | CLI 与桌面共享 auth / context / skills / configuration | 官方坐实 |
| 默认模型 | **Gemini 3.5 Flash**（co-developed using Antigravity），非 3 Pro | 官方坐实 |
| **Skill Registry** | 公开预览：中心化目录，跨用户/团队复用打包领域逻辑 + 可移植 `SKILL.md`/`AGENTS.md`（`github.com/google/skills`） | 官方但部分 aspirational（"intended to"） |
| Memory / 学习 | **无**。Managed Agents 每次 fork 全新沙箱、每跑从零开始；"session memory" 仅企业治理特性，非个人学习 | 官方坐实（ai.google.dev custom-agents 文档） |
| 新增 | 语音命令、定时后台任务、AI Ultra 付费档（$100/$200） | 官方坐实 |

### 5.2 OpenAI Codex 最新（0.138.0，2026-06-08）

| 项 | 事实 |
|---|---|
| 形态 | CLI + IDE 扩展 + cloud(Codex Web) + **桌面 App（macOS 2026-02 发布）**，Rust，Apache-2.0 |
| 定位 | 官方称「a command center for agentic coding」，内置 worktree + cloud 环境，多 agent 并行（每 agent 独立 git worktree 坐实） |
| Computer use | 坐实：多 agent 在你 Mac 上各自看/点/打字并行 |
| 模型 | GPT-5.3-Codex 旗舰 + GPT-5.3-Codex-Spark |
| Memory / 学习 | **无**，只有 "project recall"（浮现过往项目），无跨会话学习/个性化 |
| 审查 | **人审**（diff + action cards），无 agent-to-agent 决策审查 |

### 5.3 三个差异化判断（诚实版，2026-06-09 最新版核实后仍成立）

| 差异化 | 状态 | 依据 |
|---|---|---|
| ① **agent 为用户私人化进化/学习** | ✅ **成立** | 两家最新版都仍是「冻结模型 + 工件/diff 验证 + 人审」。Codex 只有 project recall，Antigravity 2.0 无个人学习机制。没有任何一家有「agent 随用户积累而适应」 |
| ② **多 agent 对抗审查（认知治理，非多 worker）** | ✅ **最干净的差异化** | 两家都有多 worker 并行（subagent/worktree），但那是我们**不主张**的。两家审查/批准环节**都是人**，无 agent 挑战另一 agent 决策 |
| ③ **经验/能力跨用户共享** | ⚠️ **收紧措辞** | 「分享技能包」Antigravity 2.0 **Skill Registry 已发布**——若卖点是这个，是追赶不是差异化。差异化必须钉死在「分享 agent **学到/进化出的经验**」，而非「写好的技能/配置」——后者没人做 |

### 5.4 对 T8 形态的结论

**目标形态对标 2.0，不是 1.0。** 1.0 的 VSCode fork + editor-first 不是我们要的；2.0 的「独立桌面 App + CLI + SDK 共享一个 runtime」才是。**天枢的优势：2.0 三件套天枢已有两件——`rivet` CLI、`rivet serve` server 都在，桌面是要补的那块。** 形态与 2.0 同构是底线；差异不在形态，在那台会私人化进化、能多 agent 对抗审查的活体大脑（§5.3 ①②）。

### 5.5 信源（最新版）

- [TechCrunch: Google launches Antigravity 2.0 (desktop + CLI, I/O 2026)](https://techcrunch.com/2026/05/19/google-launches-antigravity-2-0-with-an-updated-desktop-app-and-cli-tool-at-io-2026/)
- [Google Cloud blog: I/O26 news for agent developers](https://cloud.google.com/blog/topics/developers-practitioners/io26-news-for-agent-developers-on-google-cloud)
- [The Next Web: Antigravity 2 desktop/CLI/SDK](https://thenextweb.com/news/google-antigravity-2-desktop-cli-sdk-io-2026)
- [Gemini API custom-agents docs（fork fresh sandbox, no memory）](https://ai.google.dev/gemini-api/docs/custom-agents)
- [openai/codex repo（0.138.0, 2026-06-08）](https://github.com/openai/codex)
- [OpenAI: Codex for (almost) everything（computer use）](https://openai.com/index/codex-for-almost-everything/)
- [masonailab: Google Antigravity 2 deep-dive](https://masonailab.com/insights/google-antigravity-2-coding-agent/)
