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

> 注：Antigravity 2.0/CLI/SDK/桌面 App 形态的细粒度功能在二级博客间有出入，写进设计文档前建议以官方 changelog 再核。本报告只采纳与一手源一致的存在性结论。
