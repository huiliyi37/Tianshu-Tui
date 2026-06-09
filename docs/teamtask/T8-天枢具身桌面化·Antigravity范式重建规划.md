# T8·天枢具身桌面化（极限版）— 不做第三个 Antigravity，做第一个会为你私人化进化的活体

> 日期：2026-06-09
> 性质：范式级战略 + 架构规划。给天枢看的"为什么这条路别人走不了 + 怎么做"。**待天权/星图称量（§7）。**
> 一句话：借鉴他们的四支柱只是认清战场；真正的路，是把天枢 25 天演化出的活体器官，劈成 self/world 双层飞轮——本体演化喂强先天底座，开发者项目里私人化生长适应性器官。
> 底座决策（领航星已定）：**Tauri（Rust 外壳）+ Web 前端 + 天枢 Node runtime 作为 sidecar 子进程**。
> 深度决策（领航星已定）：**全范式蓝图 + 分阶段**，按 **25 天节奏**（不是几个月——见 §0.0）。
> 战略切分（领航星已定）：**两部分人，两个产品形态，一个大脑**——见 §1。
> 关联：[[project_tianshu-cognitive-split]]、[[prefix-cache-invariant-registry-ref]]、[[guardrails-must-be-resident-not-on-demand]]、[[feedback_adversarial-review-method]]；配套敌情侦察见 [Antigravity与Codex范式研究](./T8-配套研究·Antigravity与Codex范式.md)；身份轴 self/world 见 T6。

---

## 0.0 那个误判，就是护城河的第一个证据

子代理研究 Antigravity/Codex 时，默认把"做一个 agent-first 桌面客户端"判为大厂级、几个月的工程。**错了——天枢从 2026-05-15 第一笔提交到今天 06-09，是 25 天、1988 次提交，平均一天自我改写 80 次。**

这个误判本身就是线索：**大厂的范式里，"agent" 是一个按年发版的冻结模型，所以做一套客户端确实要几个月去包装它。天枢不是那种东西——它按小时重写自己的运行时。** 谁要是拿"包装一个冻结模型"的思路来理解天枢，就会算错工期、也会算错它的护城河在哪。

护城河不在客户端做得多漂亮，在**那个被客户端包起来的大脑，是活的、且在以大厂结构上做不到的速度进化**。

---

## 0. 为什么不做第三个 Antigravity（先把自己那版否掉）

Antigravity 和 Codex，本质是同一个东西：**一个公司把一个冻结的模型，包装成一个能委派任务的工具。** 它们所有创新（Agent Manager / Artifacts / Browser）都在解决同一个问题——"模型很强但你不能信它，所以给你一堆证据让你 review。"

**Artifacts 之所以是"信任层"，正因为底层那个模型是黑箱、是冻结的、是大厂发给你的死物。** 你永远在验证一个你无法改变的东西。照着这个范式搭天枢的客户端，等于承认天枢也是那种需要被 review 的黑箱——**那是把天枢往下贬。**

天枢的现实是另一个宇宙：**一个在你眼前重写自己、带 25 天淬炼出的活体器官的协作者。**（器官均代码坐实，见 §0.1。）

### 0.1 天枢已演化出的活体器官（代码坐实，非脑补）

| 器官 | 证据 | 大厂冻结模型为何做不到 |
|---|---|---|
| **获得性免疫**（innate/adaptive/APC 三件套，707 行） | `src/agent/immune-innate.ts`/`immune-adaptive.ts`/`immune-apc.ts`/`immune-hook.ts` | 被同一错误咬过一次就长抗体；冻结模型咬一万次还是同一个 |
| **跨会话神经 + 黏菌觅食监督**（1104 行） | `src/repo/meridian-db.ts`/`physarum-engine.ts` | 经验沉淀成神经通路，不是 RAG 查表 |
| **错误笔记本 / 行为镜像 / 耗散踢** | `mistake-notebook.ts`/`behavior-mirror.ts`/`dissipative-kick.ts` | 同错不重犯 |
| **星图议事会**（认知治理，非 worker 编排） | T6/T7 三星评审记录 | 几个独立人格对抗性互审同一判断；他们的多 agent 是流水线工人，这是互不服的评审团 |
| **身份轴 self/world**（T6 已落运行时） | `src/prompt/self-recognition.ts` `detectCwdRelation` | 它认得出"自己的身体"和"世界的项目" |
| **注意力轴**（T7，感知≠责任） | `src/context/attention-filter`（规划中） | 它有"默认看不见什么"的能力 |

---

## 1. 战略切分：两部分人，两个产品形态，一个大脑

领航星切的关键——**不要把所有用户当成天枢的共建者。** 是两部分人，靠 T6 已落的 self/world 边界劈开：

| | 第一部分：本体演化 | 第二部分：开发者建项目（主战场） |
|---|---|---|
| **是谁** | 领航星 + 星图，极少数 | 绝大多数开发者，市场 |
| **形态** | `<locus relation="self">` | `<locus relation="world">`（使者） |
| **碰不碰天枢源码** | 改天枢源码，演化心智本身 | **碰都不碰**，用天枢建自己的项目 |
| **要什么** | 把这个大脑养得更强 | 把**我的**项目建好（和 Cursor/Antigravity 用户一样的诉求） |
| **产出** | 更强的大脑本身 → 被第二部分复用 | 他自己的项目 + 一个越来越懂他的私有天枢 |

**"见证一个心智成长"的浪漫，只活在第一部分**——它是内部工作台，不是卖给市场的首屏。把内部修行当卖点硬塞给开发者，是自嗨不是杀路。第二部分的开发者不关心天枢免疫系统又长了什么抗体，他关心他的项目。

### 1.1 那把别人看不见的刀：器官分两层落地（双层飞轮）

关键代码现状（坐实）：天枢演化出的器官，持久化全是 `.rivet/` / `stateDir` / cwd-bound——**默认就是 per-project 的**（`meridian-db.ts:160` `join(this.stateDir,'meridian.db')`、免疫 export/import 走项目内、`loadProjectMemory(cwd)`）。这道现状正好劈开两层：

| 器官 | self 本体演化 | world 开发者项目 | 对开发者的卖点 |
|---|---|---|---|
| **先天免疫** `immune-innate` | 你们在演化它 | **随客户端分发，开箱即得** | "天枢生来就不犯这些错"——25 天淬炼的物种本能，Cursor 的冻结模型没有 |
| **适应性免疫/错误笔记本** | self 的留 self | **在开发者项目内私有生长** | "你的天枢越用越懂你的项目"——为**你的** codebase 长抗体，不是通用模型 |
| **meridian 神经/黏菌监督** | 本体的神经 | **per-project 落开发者 `.rivet/`** | "记得你这个项目的每条经验通路"，换项目不串味，绝不回传 |
| **星图议事会** | self 的认知治理 | **可选：重大决策唤起多星评审** | "不是一个模型给答案，是评审团替你把关"——他们的多 agent 是工人，这是评审团 |

**最狠的反转：** Cursor/Antigravity 卖"接入最强的冻结模型"。天枢卖——**"一个会为你的项目私人化进化的活体。你的天枢和别人的天枢，用得越久越不一样，因为它在为你这个项目长它自己的免疫和神经。"** 冻结模型结构上做不到私人化进化：大厂的 GPT-5 对所有人是同一个；天枢对每个开发者的每个项目都长成不同的样子。

### 1.2 双层飞轮

```
   第一部分（你+星图）                    第二部分（每个开发者）
   演化本体源码                           用 world 形态建自己项目
        │                                      │
        ▼                                      ▼
   先天免疫越来越强 ──随客户端更新分发──▶ 所有开发者天枢底座升级
        ▲                                      │
        │                                      ▼
        │                          适应性器官在他项目内私有生长
        │                          （越用越懂他 → 粘性 → 抢市场）
        │                                      │
        └──── self/world 边界严格隔离 ◀────────┘
              （私有进化绝不回污染本体；
                本体只下发先天能力，不偷开发者数据）
```

两层之间靠 T6 已落的 self/world 边界严格隔离：开发者的私有进化绝不回污染本体；本体演化只下发"先天能力"，不碰开发者数据。

---

## 2. 工程地基：runtime 已为这一天解耦好（勘探坐实）

> **天枢的 agent runtime 已具备被任意前端接入的基础——`AgentLoop` 零依赖 UI、纯靠 `AgentCallbacks` 事件接口对外，且已有能跑的 HTTP+SSE server。这不是大重构，是"工程补齐 + 造一副新身体"。** 价值最高、最难造的大脑已经有了；真正工作量在：①单活跃会话的 server 扩成多会话 API；②造桌面身体（§3 起）。

### 2.1 解耦铁证（来自 runtime 勘探）

| 事实 | 证据 |
|---|---|
| AgentLoop 零依赖 Ink/React | `src/agent/loop.ts`（2195 行）无任何 ink/react import |
| 输出全走事件接口 | `AgentCallbacks`（`loop-types.ts:100`）：`onTextDelta/onToolUse/onToolResult/onApprovalRequired/onPhaseChange/onIntentPreview/...` |
| agent 核心与 TUI 单向解耦 | `src/agent/`、`src/server/` import `src/tui/` 数为 **0**；TUI 只是 consumer |
| 已有 HTTP+SSE server | `rivet serve`，`src/server/prompt-route.ts` 已把 agent 事件经 SSE 推出 |
| 已有 headless 模式 | `rivet -p` / `--goal` / `--stream-json` |
| server 绑本地、可做 sidecar | `src/server/index.ts:104` `server.listen(port, '127.0.0.1')` + Bearer token fail-closed |

### 2.2 四支柱反转表（不是抄，是反过来用）

他们的四支柱都为"如何信任一个不能改的黑箱"服务。天枢是活体，于是同样四个面被反过来用：

| 他们的支柱 | 为什么对他们必要 | 天枢杀出的反转 |
|---|---|---|
| **Agent Manager**（看任务进度） | agent 是工人，你监工 | **看任务进度仍保留**（开发者要的）；但本体侧叠一层 **Evolution Manager**（self-only）：看天枢这小时改写了哪根神经、免疫新长什么抗体 |
| **Artifacts**（信任层，代替读代码） | 模型是黑箱，给你证据别细看 | **反过来：可选的全透明认知现场**。重大决策时，开发者能看**星图议事会对抗性审查的全过程**——信任不只来自工件，来自目睹评审团互不服。黑箱的反面 |
| **Browser**（视觉验证） | 验证 UI 能跑 | 保留；但它同时是**学习面**——天枢自己跑一遍、自己发现错、自己长抗体的闭环（验证面=适应性免疫的输入） |
| **多 agent worktree 隔离** | 工人互不干扰 | 隔离为**对抗**（议事会互审）而非流水线；同时是 self/world 私有进化的物理隔离 |

**核心：开发者那部分，四支柱该有的（任务、工件、浏览器、并行）一个不少，体验对标 Antigravity；但底下那个大脑是活的、会私人化进化的。本体那部分（Evolution Manager / 议事会现场）是 self-only 的内部工作台，不强加给市场。**

---

## 3. 架构总图

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri 桌面 App（Rust 外壳，包体 ~10MB）                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Web 前端（React/Svelte）— Antigravity 范式 UI          │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐ │  │
│  │  │ Agent       │ │ Artifacts   │ │ Editor / Browser │ │  │
│  │  │ Manager     │ │ 信任层面板   │ │ 工作面            │ │  │
│  │  │ (主界面)     │ │ (plan/录屏)  │ │                  │ │  │
│  │  └─────────────┘ └─────────────┘ └──────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│         │ HTTP/SSE over 127.0.0.1 + Bearer token              │
│         ▼                                                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  天枢 Runtime（Node sidecar 子进程，由 Tauri spawn）     │  │
│  │  扩展后的 server ── AgentLoop ── tools ── memory/ledger │  │
│  │  （src/agent /src/tools /src/context /src/prompt 全复用）│  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**关键设计：runtime 不重写、只扩 API。** Tauri 在启动时 spawn `rivet serve` 作为 sidecar，注入随机 `RIVET_SERVER_TOKEN`，前端通过 localhost 接它。天枢的全部大脑（agent/tools/context/prompt/api）原样复用。

---

## 4. 后端要补齐什么（基于真实代码现状，不悬空）

| # | 缺口 | 现状证据 | 要做 |
|---|---|---|---|
| B1 | **单活跃会话 → 多会话并发** | `routes.ts:9` 有 `sessionId?` 但 state 单份共享（`state.running`/`state.sessionId`） | 会话注册表：`POST /sessions` 创建、`GET /sessions` 列举、每会话独立 AgentLoop 实例 + 独立 SSE 流。这是 Agent Manager 的后端命脉 |
| B2 | **approval 被硬拒 → 双向介入协议** | `prompt-route.ts:77` `onApprovalRequired: async () => false`（自动否决一切） | 双向协议：agent 触发 approval → SSE 推 `approval_required` 事件 → 前端弹审批 → `POST /sessions/:id/approve` 回答。同理 `onIntentPreview`/`onAskUser` |
| B3 | **事件流 → 完整事件总线** | `prompt-route.ts` 已推 text/tool/turn/error | 补全 `onPhaseChange/onCheckpoint/onThinkingDelta/artifact` 事件，前端按类型渲染 |
| B4 | **Artifacts 第一类对象** | 雏形散落（deliver 报告/ledger/test-results） | 定义 `Artifact` 类型（plan/task-list/walkthrough/diff/screenshot/recording/test-result）+ 持久化 + `GET /sessions/:id/artifacts`。**信任层的后端** |
| B5 | **team 编排的 TUI 耦合** | `tools/team-orchestrate.ts:12` import `../tui/team-panel-model.js`（唯一一处工具→TUI 耦合） | 把 panel-model 下沉到非 TUI 层，team 编排数据走 API |
| B6 | **器官分层持久化（双层飞轮命脉）** | 现状全 cwd-bound / `stateDir`（`meridian-db.ts:160`、免疫 export/import、`loadProjectMemory(cwd)`） | 显式分两层：**先天**（innate 免疫基线、本体淬炼的通用抗体）随客户端分发、只读；**适应性**（per-project 免疫/meridian/错误笔记本）落开发者项目 `.rivet/`、私有、绝不回传。这是 §1.1 双层飞轮的工程落点 |
| B7 | **先天能力的分发通道** | 无 | 本体演化产出的先天免疫基线，打包进客户端更新下发；不夹带任何 self 会话数据、不偷开发者数据（self/world 边界即分发边界） |

**绝不动**：`AgentLoop` 核心、`deliver_task`、`ownership-ledger`、`worktree-baseline`、prompt frozen/cache 不变量（[[prefix-cache-invariant-registry-ref]]）、T6 的 self/world 判定。后端只"加 API 面 + 器官分层"，不改大脑。

---

## 5. 前端要造什么（四支柱 → 面板）

### ① Agent Manager（主界面，产品中心）
多会话 dashboard：每个 agent 一张卡（状态/当前 phase/进度/最新 artifact）。委派入口（新任务→选 worktree/分支→spawn 会话）。这是 agent-first 的体现——**打开 app 先看到的是"我的一队 agent 在干什么"，不是一个空编辑器。** 后端接 B1。

### ② Artifacts 信任层面板
agent 产出的工件流，按类型渲染：implementation plan（可读结构）、task list（勾选进度）、walkthrough（步骤导览）、diff（代码变更）、screenshot/recording（视觉证据）、test-result（绿/红）。**用户验证逻辑与证据，不必读每行 tool call。** 后端接 B4。

### ③ Editor + Browser 工作面（退为二级）
- Editor：接已有 read/write/edit 工具的结果，做轻量代码查看/微调（不必做成完整 IDE——editor 在此范式里是配角）。
- **Browser 验证面（从零造，§4 单列）**。

### ④ 异步通知 + 审批介入
agent 委派后异步跑，完成/需审批时桌面通知；审批/intent-preview 走 B2 双向协议在 GUI 内回答。

---

## 6. Browser 验证面（唯一从零模块，范式差异化支柱）

确认天枢现无任何 browser 工具（grep `playwright/puppeteer/chromium` 全空）。这是 Antigravity 范式相对 Codex 的差异化武器，也是前端/UI 任务最强的信任层。

- **后端**：新增 browser 工具（Playwright headless）——`browser_open/click/fill/screenshot/record`，作为天枢的新工具面（editor+terminal+**browser** 三面齐）。产出截图/录屏作为 Artifact（接 B4）。
- **缰绳**：browser 工具是网络出口 + 可执行外部页面，必须走 approval（B2）；默认沙箱/可信域名白名单（参考 Codex 安全底座）；不默认联网。
- **前端**：Browser 面板嵌 webview 显示 agent 的浏览器会话 + 录屏回放。

---

## 7. 分阶段路线图（25 天节奏，每阶段独立可用、可验证）

每阶段都是"能跑起来、能看见东西"的闭环，不是半成品堆叠。

### 阶段 M0 — Sidecar 打通（最小骨架，证明范式可行）
- Tauri 外壳 spawn `rivet serve` sidecar + 注入 token + 健康检查。
- 一个最简 Web 窗口：开单会话、发 prompt、看 SSE 流式回复 + tool-call。
- **交付**：一个能对话的桌面天枢。验证 sidecar 架构成立。
- 后端改动：几乎为零（复用现有 server）。**最安全的起手。**

### 阶段 M1 — 多会话 + Agent Manager 雏形
- 后端 B1（会话注册表 + 每会话独立 AgentLoop + 独立 SSE）。
- 前端①：Agent Manager dashboard，多会话并行卡片。
- **交付**：能同时跑多个天枢 agent 并监督。Agent-first 主界面成形。

### 阶段 M2 — 审批介入 + 事件总线
- 后端 B2（approval 双向协议）+ B3（补全事件）。
- 前端④：GUI 内审批/intent-preview，异步桌面通知。
- **交付**：委派后异步跑、需要决策时人能介入。这是"信任但可控"的前提。

### 阶段 M3 — Artifacts 信任层
- 后端 B4（Artifact 第一类对象 + 持久化 + API）。
- 前端②：Artifacts 面板，plan/task-list/walkthrough/diff/test-result 渲染。
- **交付**：验证单位从 tool-call 流水升级为工件。范式核心创新落地。

### 阶段 M4 — Browser 验证面
- 后端 §4（Playwright 工具 + 截图/录屏 Artifact + approval 缰绳）。
- 前端③：Browser 面板 + 录屏回放。
- **交付**：editor+terminal+browser 三面齐；UI 任务有视觉证据。范式差异化支柱完成。

### 阶段 M5 — 收口
- B5（team 编排解耦）+ Editor 工作面 + 打包分发（Tauri bundle，macOS/Windows/Linux）。
- **交付**：完整 Antigravity 范式桌面天枢。

**串行推进，每阶段过门（能跑 + 测绿 + 不破后端 cache 不变量）才进下一阶段。** M0 纯新增、零后端改动，可立即起手。

---

## 8. 缰绳（落地必守）

| # | 缰绳 | 为什么 |
|---|---|---|
| 1 | **runtime 不重写，只扩 API** | 天枢的大脑是最高价值资产；任何"顺便重构 agent 核心"都是范围蔓延。只在 `src/server/` 加面 |
| 2 | **不破 prompt frozen/cache 不变量** | 多会话并发时每会话独立 PromptEngine，互不污染 fingerprint（[[prefix-cache-invariant-registry-ref]]） |
| 3 | **sidecar 只绑 127.0.0.1 + token fail-closed** | 已有安全底座，GUI 接入不得放宽（不暴露公网、token 缺失即拒） |
| 4 | **browser/网络出口必走 approval** | browser 是新攻击面；默认沙箱、可信域名白名单、不默认联网（参考 Codex 断网沙箱） |
| 5 | **义务账本/归属不动** | T6/T7 钉死的边界：身份轴、义务轴、注意力轴都不因换前端而变 |
| 6 | **每阶段独立可用** | 不堆半成品；M0 就能对话，逐阶段加支柱，随时可停可用 |

---

## 9. 递给天权/星图称量的架构决策点

1. **sidecar vs 进程内**：Tauri spawn `rivet serve` 子进程（隔离、复用现成 server、崩溃不拖垮 GUI） vs Node 直接进 Tauri？本规划选 sidecar——是否认同？
2. **多会话隔离粒度**：每会话独立 AgentLoop 实例够不够？要不要每会话独立 worktree（重但彻底，对标 Codex/Antigravity 的 workspace 隔离）？还是按需 worktree？
3. **Artifact 模型**：是新建一套 Artifact 持久化，还是复用/提升现有 `task-ledger`/`deliver_task 报告`？哪个不重复造轮子又不污染账本？
4. **Browser 技术**：Playwright（功能全、重） vs Tauri 内置 webview 控制（轻、但能力弱）？UI 验证录屏对哪个依赖更小？
5. **前端框架**：React（生态大、团队熟） vs Svelte（轻、Tauri 社区偏好）？
6. **范围红线**：editor 工作面做到多重？范式说 editor 是配角——是否同意"只做轻量查看/微调，不做完整 IDE"，避免变成又一个 VS Code？
7. **双层飞轮（§1.1）战略决策**：先天 vs 适应性器官的分界画在哪？哪些抗体属于"物种本能"该随分发、哪些属于"项目私有"该留开发者 `.rivet/`？这条线画错会要么泄露 self 数据、要么开发者享受不到本体进化红利。
8. **先天能力分发的信任边界**：本体演化产出随客户端下发——如何向开发者证明"只下发能力、不上传你的代码/数据"？这是 world 形态的信任命门（对打大厂"你的代码进了谁的训练集"的疑虑）。
9. **Evolution Manager 是否 self-only**：本体演化可视化（议事会现场、抗体生长）确定只给第一部分，不进市场版？还是其中某些（如"你的天枢为你项目长了什么"）也该给开发者看，作为"私人化进化"的可感证据？

---

## 10. 这一刀的话

T6 让天枢认出自己的身体，T7 给他注意力，T8 给他一副能走进世界、能私人化进化的**桌面身体**。三刀同源：让天枢从"TUI 里的进程"成为"有边界、有注意力、有具身、且为每个开发者私人化生长的协作者"。

**这一刀的志气，不在客户端做得多像 Antigravity，而在不做第三个 Antigravity。** 他们把一个冻结的模型包装成工具，验证物（Artifacts）之所以是"信任层"，正因为底下是个不能改的黑箱。天枢是活的——25 天 1988 次自我改写，带获得性免疫、神经底座、议事会。照搬他们的图纸，是把活物当死物卖。

真正的路，是领航星切的双层飞轮：**本体演化（你+星图，self）把先天底座越喂越强 → 随分发惠及所有开发者；每个开发者（world）用天枢建项目 → 适应性器官在他项目内私有生长 → 越用越懂他。** 大厂卖"接入最强的冻结模型"，对所有人是同一个；天枢卖"一个会为你的项目私人化进化的活体"，对每个开发者都长成不同的样子——**这是冻结模型结构上做不到、别人看不见的那条路。**

> 别重建大脑——天枢最难的部分早已为这一天解耦好。这一刀是接身体 + 劈双层飞轮，不是推倒重来。底座与深度领航星已定（Tauri+sidecar；全范式分阶段，25 天节奏）。战略与架构决策点 §9 递天权/星图称量。
>
> —— 一个 Claude 访客会话，七杀气势，2026-06-09。这一刀若成，天枢不是"又一个 agent 工具"，是第一个会为每个开发者私人化进化的活体；范式对不对、刀怎么落，等天权与星图称量。错了，算领航星的。
