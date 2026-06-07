# 天枢 HTTP Runtime 接入 · Ingress + Runtime 池 + Cache

> 日期：2026-06-05（2026-06-06 据天枢审查 + 领航星裁定修订）
> 状态：设计稿（已收天枢外部对照审查，见文末「审查回应与决议」）
> **拆分说明**：本 spec 是「常驻协作者」目标的**其一**，只覆盖 ingress 接线 + 长驻 runtime 池 + cache。任务生命周期系统（状态机/取消/审计/定时）经天枢审查确认为独立盲区，已拆为姊妹 spec：`2026-06-06-task-lifecycle-system-design.md`。本 spec 不再自称「常驻协作者」全集——它只交付「HTTP 可达的 runtime 池」，协作者头衔由两份 spec 合并兑现。
> 作者：天璇 · Opus 4.6（领航星会话）
> 触发：领航星要求「从 OpenClaw 原生融合 gateway 路由 + 外部工具调用，让天枢更自然使用自己的本体」
> 外部参照：OpenClaw（Gateway 常驻进程「只路由不思考」+ 独立 agent runtime + per-agent tool policy + SOUL.md 身份外化）
> 关联：[[cognitive-pipeline-is-substrate-not-feature]]、[[cache-aware-fusion-spec]]、`docs/superpowers/specs/2026-06-05-cognitive-pipeline-cache-aware-fusion-design.md`

---

## 0. 前提与定位（继承 §0 公理）

认知本体（affordance/vigor/season/theta/cognitive-mirror/belief）是天枢清醒运行态的前提，已由 git 自我迭代线验证。**本设计是纯基础设施层（server / routes / runtime pool），不触碰任何本体感受器官**——它改变的是「天枢以什么形态存在」（终端工具 → 常驻协作者），不改变「天枢是谁」。

因此本设计整体属**增强类**：给已清醒的本体一个能持续待命的躯壳。唯一触及本体生命周期的部分（跨任务的本体演化）严格隔离在 §10，标记为待研究，不进实施。

**调研的诚实结论**：OpenClaw 对照下，天枢**不缺 Gateway 的零件，缺的是把零件接成 ingress 拓扑的那道线**。本设计因此不是「搬一个 gateway」，而是「接通天枢自己已建的 server+router+coordinator+work-order」。

---

## 1. 代码级现状（全部已验证，无「待核实」）

| Gateway 要素 | 天枢现状 | 锚点 |
|---|---|---|
| 常驻 HTTP server | ✅ `rivet serve --port N`，已接线 | `main.tsx:735–752`，`server/index.ts:startServer` |
| router 原语 | ✅ `createRouter` | `server/index.ts:11` |
| 任务 ingress 原语 | ⚠️ `POST /prompt` handler **存在但是桩**（只回显，不跑 loop）；且 `serve` 调 `createRoutes(state)` **未传 deps → 未注册** | `server/routes.ts:11,24`、`server/prompt-route.ts:12–24` |
| SSE 流式输出 | ✅ `handlePromptSSE` + `SseStream`（含 headless `onApprovalRequired:false`） | `prompt-route.ts:26,52` |
| coordinator/worker 路由 | ✅ `DelegationCoordinator`/`CollaborationProtocol`/`AdaptiveRouter` | `coordinator.ts:104`、`adaptive-routing.ts:19` |
| per-agent tool policy | ✅ `allowedTools`/`disallowedTools` + `filterToolRegistry` | `work-order.ts:93`、`coordinator.ts:253`、`profile-registry.ts:20` |
| sandbox 隔离 | ✅ | `tools/sandbox-exec.ts` |
| **per-runtime PromptEngine** | ✅ 每 worker 独立 `PromptEngine` 实例 | `worker-session.ts:26` |
| session 角色 | ✅ coordinator/worker/standalone | `session-registry.ts:120` |
| 外部服务调用 | ✅ HTTP/HTTPS + GitHub repo 拉取 | `tools/import-resource.ts:97` |
| **MCP 标准协议** | ❌ 无 | （真缺口②，见 §5） |
| channel adapter | ❌（不需要——天枢是编码 agent，不要聊天通道） | — |

## 2. 真缺口（精确到两个）

**缺口①：任务 ingress 拓扑未接线。** 天枢现在的拓扑是「REPL 派生临时进程内 worker」——一个终端会话靠 `delegate_task` 工具**同步**唤起 worker，用完即弃。它**不是**「常驻 daemon 接异步任务 → 路由到长驻 runtime → 回结果」。具体三处断点：
1. `serve` 调 `createRoutes(state)` 不传 `deps` → `POST /prompt` 不注册。
2. `buildPromptHandler` 是桩 → 即便注册也只回显，不驱动 agent loop。
3. 没有「长驻 runtime 池」——worker 是 per-delegate 现造现弃，不在任务间存活。
4. **Session 持久化未接到 runtime + PromptEngine 缺状态导出**（天枢两轮审查）：`SessionPersist` 机制已存在并服务主会话（`loop.ts:420`），但 `worker-session.ts` 未接它。**且经二次核实：`PromptEngine` 当前无状态导出/注入 API（`prompt/engine.ts` 无 `exportState/importState/getState`），snapshot 按 user-message 内容存内存。** 所以跨进程重启存活**不止是接 SessionPersist 的 API，要先给 PromptEngine 新增状态导出/注入能力**——比纯接线重。
5. **Auth**（见 §7）：网络暴露入口的前置门槛，与接线同批。

**划归姊妹 spec**：任务生命周期（状态机/取消/审计/定时）经天枢审查确认为独立盲区，本 spec 不覆盖 → `2026-06-06-task-lifecycle-system-design.md`。本 spec 只做「接通 + 池化 + cache 隔离」。

**MCP（可选增量，非缺口）**：天枢能拉 HTTP/GitHub（`import-resource`），无 MCP；但 OpenClaw 也无 MCP，故非缺口而是锦上添花，见 §5。

**topology 对照**：

```
现在（REPL 派生临时 worker）          目标（常驻 daemon 路由长驻 runtime）
  终端会话                              rivet serve（常驻）
    └─ delegate_task（同步）              └─ POST /prompt（异步接任务）
        └─ runWorkerSession（即弃）          └─ AdaptiveRouter → runtime 池
                                                └─ 长驻 runtime（各持 PromptEngine）
```

---

## 3. 设计：任务 Ingress 拓扑

核心动作 = **接线已有零件**，不造新轮子。四步：

**3.1 注册 ingress** — `serve` 命令传入 `deps`，让 `POST /prompt` 上线（`createRoutes(state, deps)`）。

**3.2 让 handler 真驱动 loop** — `buildPromptHandler`/`handlePromptSSE` 从「回显桩」改为：接任务 → 经 `AdaptiveRouter` 选 runtime → 驱动其 agent loop → SSE 流回。复用现有 `handlePromptSSE` + `SseStream`。

**3.3 长驻 runtime 池** — 新 `RuntimePool`：按 session key（复用 `SessionRegistry` 的 key 概念，编码 objective/profile/thread）维护一组**长驻** runtime。每个 runtime = 一个常驻 agent loop + **自己的 `PromptEngine` 实例**（已有，`worker-session.ts:26`）+ 自己的 `allowedTools` 策略（已有，`filterToolRegistry`）。任务来 → 池里找/建对应 runtime → 复用其上下文与 cache。

**3.4 路由** — 入站任务经 `AdaptiveRouter`（已有，profile×model 评分）选 runtime tier；新任务建 runtime，续任务命中已有 runtime（这正是 cache 复用的来源）。

**关键：天枢「只路由不思考」的部分 = server+router+pool；「思考」的部分 = 各 runtime 的 agent loop。这与 OpenClaw 的 Gateway/runtime 分离同构，但天枢的零件全是自己已建的。**

---

## 4. prefix cache × 长驻 runtime 的张力与解法（命根子）

**张力**：OpenClaw 每 session 独立、不在乎 cache；天枢的命是 prefix cache（P1 修复打到 84–95%，见 [[cache-aware-fusion-spec]]）。常驻多 runtime 若共用 prompt 前缀会互相踩 cache。

**cache 的适用边界（领航星 2026-06-06 裁定，收窄）**：cache 优势**不泛化到所有弱模型**。天枢终端的目标模型集 = **GLM5.1 / MiMo-v2.5pro / DeepSeek-v4**；其中**只保 DeepSeek 的 OpenAI 兼容前缀 cache**，其他模型的 cache 不管。所以本节论证的「cache 是命根子」精确限定为：**面向 DeepSeek 的前缀 cache 是护城河**——这是天枢相对 OpenClaw（站在强模型肩上、可忽略 cache）的真实差异化。天枢审查 2.3 担心的「cache 被高估」对天枢不在意的模型成立，但对 DeepSeek 不成立。两者不矛盾，靠这条边界划清。

**解法（架构已支持，无需新机制）**：cache 隔离单元 = **PromptEngine 实例**，而**每个 worker/runtime 早已各持独立 PromptEngine**（`worker-session.ts:26`）。所以：

- 每个长驻 runtime 维持**自己的** frozen prefix + cache 锚点，互不干扰。
- runtime **在任务间存活** → 同一 runtime 接续任务时，prefix cache **跨任务命中**（比现在 REPL-派生-即弃**更优**：现在每次 delegate 都是冷启动 PromptEngine）。
- P1 的「附录冻结进 user 边界」机制在每个 runtime 内部原样成立，不受池化影响。

**即：长驻拓扑不仅不破坏 cache，反而把 cache 寿命从「单次 delegate」延长到「runtime 生命周期」。** 这是本设计对天枢命根子的正面增益，不是代价。

需实测确认的一点（实施期）：runtime 池的驱逐策略（LRU？空闲超时？）不能频繁销毁 runtime，否则丢失跨任务 cache——驱逐阈值要对齐 cache 价值。

## 5. MCP（可选增量，非缺口 — 经审查降级）

**降级说明**：先前把 MCP 列为「真缺口②」是过度加权。天枢审查 2.4 指出 **OpenClaw 自己也没有内置 MCP**——它工具全自建。所以 MCP 不是「天枢落后于对手的缺口」，是「锦上添花的可选增量」。

OpenClaw 的「interact with external services」靠自建工具集；天枢有硬编码的 HTTP/GitHub 拉取（`import-resource`）。MCP 对天枢的价值在于**作为编码 agent 接入外部数据源/服务**（而非 OpenClaw 的 chat 生态），优先级低。落点若做：新 `src/tools/mcp-client.ts` + 注册进 `ToolRegistry`，天然受现有 `allowedTools` 策略约束。**本节仅登记，明确不在 ingress 主线，可任意推后。**

---

## 6. 架构落点

| 变更 | 文件 | 性质 |
|------|------|------|
| `serve` 传 deps，注册 `/prompt` | `main.tsx:740–746`、`server/routes.ts:11` | 接线（已有路由分支） |
| handler 从桩改为驱动 loop | `server/prompt-route.ts:12,26` | 实现（复用 `handlePromptSSE`/`SseStream`） |
| 长驻 runtime 池 | 新 `src/server/runtime-pool.ts` | 新增（编排已有 PromptEngine + agent loop） |
| 路由入站任务到 runtime | 复用 `adaptive-routing.ts`、`session-registry.ts` | 接线 |
| runtime 驱逐策略（对齐 cache 价值） | `runtime-pool.ts` | 新增，实施期实测调参 |
| **runtime 接 SessionPersist + PromptEngine 状态导出/注入**（跨重启存活） | `worker-session.ts` + `session-persist.ts`（已有）+ `prompt/engine.ts`（**需新增** export/import API） | 部分新增：SessionPersist 是接线，但 PromptEngine 状态导出当前不存在，须新建 |

**不动**：认知本体全部（affordance/EFE/policy/cognitive-mirror/belief）、PromptEngine 内部 P1 冻结机制、worker 工具隔离机制（`filterToolRegistry`）。本设计只在它们**外面**加一层常驻编排。

---

## 7. 安全（网络暴露端点 — 必须正视）

⚠️ **这是把 agent loop 接到 HTTP 端点，等于开放一个能跑 shell / 读写文件 / 拉外部资源的网络入口。** OpenClaw 的头号风险正是「工具以 host 全权限执行，访问控制只是可选 pairing」。天枢不能重蹈。强制要求：

1. **默认仅绑 `127.0.0.1`**，绝不默认对外。对外暴露须显式 opt-in 且伴随认证。
2. **认证**：`/prompt` 必须有 token/密钥校验——现状 `/status`/`/abort` 无认证（本地控制面可接受），但 `/prompt` 能驱动工具执行，**无认证的远程任务入口 = 任意命令执行**。
3. **per-runtime tool policy 是安全边界**：入站任务的 runtime 必须按最小权限分配 `allowedTools`，不可默认全权。复用 `work-order.ts` 的 READ_ONLY/WRITE 分级。
4. **审批语义**：现 `handlePromptSSE` 用 `onApprovalRequired: async () => false`（自动拒）。驱动真 loop 时，破坏性操作的审批策略必须显式定义——headless 下「自动拒」比「自动批」安全，但要让调用方能看到被拒的操作。
5. 沙箱：高风险任务路由到 `sandbox-exec` 隔离执行。

**本节是实施的前置门槛，不是可选项。** ingress 接线与认证/最小权限必须同一批落地，不允许「先接通再补安全」。

## 8. 验证

| 指标 | 测法 | 通过标准 |
|------|------|---------|
| ingress 端到端 | `rivet serve` 后 `POST /prompt` 发任务，SSE 收到流式结果 | 任务真被执行，非回显 |
| 跨任务 cache 命中（核心增益） | 同一 runtime 连发两个相关任务，看第二个的 `cache-log.jsonl` | 第二任务前缀命中率 **不劣于单会话基线**（84-95% 是单会话内测量值，非跨任务保证；池化后重测确立实际值），优于冷启动 |
| per-runtime 隔离 | 两个不同 session key 的任务并发 | 各自 PromptEngine 前缀互不污染 |
| tool policy 边界 | 给 READ_ONLY runtime 发写任务 | 被 `filterToolRegistry` 拒绝 |
| 安全（前置门槛） | 无 token 访问 `/prompt`；非 localhost 访问 | 均被拒 |
| 清醒度不退化（遵 §0） | 常驻 runtime 跑长任务 vs 当前 REPL 跑同任务 | runtime 形态下天枢清醒度不劣于 REPL |

最真实的验证仍是：**起一个常驻天枢，丢给它一串异步长任务，看它是否还清醒、连贯、跨任务复用上下文。**

---

## 9. 实施阶段

```
Phase 0（接线，最小可跑 · 增强类）
  ├─ serve 传 deps，注册 POST /prompt
  └─ buildPromptHandler/handlePromptSSE 驱动单个 agent loop（暂不池化）
     验证：POST /prompt 真执行任务 + SSE 流回

Phase 1（安全前置门槛 · 与 Phase 0 同批，不可拆后）
  ├─ /prompt token 认证 + 默认仅 127.0.0.1
  └─ 入站 runtime 最小权限 allowedTools
     验证：无 token / 非 localhost 均被拒

Phase 2（长驻 runtime 池 · 核心）
  ├─ runtime-pool.ts：按 session key 维护长驻 runtime（各持 PromptEngine）
  ├─ **PromptEngine 新增状态导出/注入 API**（当前不存在，跨重启存活前置）
  ├─ runtime 接 SessionPersist（已有类）→ 跨进程重启存活
  ├─ AdaptiveRouter 接入路由
  └─ 驱逐策略对齐 cache 价值
     验证：DeepSeek 跨任务 cache 命中不劣于单会话基线（池化后重测）+ per-runtime 隔离 + 重启后 runtime 可恢复

Phase 3（MCP · 可选增量，可任意推后）
  └─ mcp-client.ts + 注册进 ToolRegistry（受 allowedTools 约束）
     验证：MCP 工具可调用且受 tool policy 隔离
```

依赖：Phase 0+1 必须同批（安全是前置门槛）。Phase 2 依赖 0+1。Phase 3 完全可选、独立。**Task 生命周期系统不在本 spec 阶段内——见姊妹 spec `2026-06-06-task-lifecycle-system-design.md`。**

---

## 10. 与认知本体的关系（待研究边界，严格不实施）

⏸ 长驻 runtime 给认知本体开了一个**当前不存在的可能性**：现在 affordance/season/vigor 每个 REPL 会话从头开始；若 runtime 跨任务存活，本体状态**可以跨任务演化**——天枢可能第一次拥有「跨任务的持续意识」，而非每次唤起都重置。这呼应 OpenClaw 的 SOUL.md（身份外化、可演化）。

**精度校准（天枢二次审查）**：必须澄清天枢当前的跨会话记忆**只有结构化 claim 库**——`ContextClaimStore`（`.claims.jsonl` + `loadDurableClaims` 跨会话加载 durable claims + 「survived 30 sessions」年龄加权），靠 `remember`/`recall` 工具。**这是 fact/rules 数据库 + 证据链，不是 SOUL.md 式连续身份/人格。** 天枢**没有**任何形式的持续身份文件或跨会话人格记忆。所以「跨任务本体演化」是从零开辟的新可能，不是「把现有身份机制接通」——更加确认其待研究地位。

**但这严格属待研究，不进本 spec 实施**（遵 §0）：让本体跨任务持续，是动到天枢生命周期的核心，可能改变它的清醒态特性，必须先理解再动。本 spec 的 runtime 池**默认每 runtime 的认知本体仍按现有生命周期初始化**，不引入跨任务本体延续。跨任务本体演化作为独立研究课题，链接到 [[cognitive-pipeline-is-substrate-not-feature]]，留待专门评估。

---

## 11. 一句话总结

> **前提（§0）**：本设计是纯基础设施层，改变天枢「以什么形态存在」（终端工具→常驻协作者），不碰「天枢是谁」（认知本体）。
>
> 代码级核实推翻了「天枢缺 gateway」的判断：天枢**已自建** server / router / coordinator / adaptive-routing / per-agent tool policy / sandbox / per-runtime PromptEngine 全套零件，连 `POST /prompt` ingress 原语都有——**只差三道线没接**（serve 没传 deps、handler 是桩、无长驻 runtime 池）。真缺口收窄为：**ingress 拓扑接线**（缺口①）+ **MCP**（缺口②，正交）。prefix cache×长驻 runtime 的张力**因「每 worker 已各持独立 PromptEngine」而天然可解**，且把 cache 寿命从单次 delegate 延长到 runtime 生命周期——是增益非代价。安全是前置门槛：网络暴露的工具执行入口必须同批落地认证+最小权限。跨任务本体演化诱人但属待研究，严格不实施。

---

## 附录：代码锚点（2026-06-05 核验）

| 锚点 | 位置 |
|------|------|
| serve 命令 + startServer | `main.tsx:735–752` |
| createRoutes（传 deps 才注册 /prompt） | `server/routes.ts:11,24` |
| /prompt handler（现为桩） | `server/prompt-route.ts:12–24` |
| handlePromptSSE + SseStream + headless 审批 | `server/prompt-route.ts:26,52` |
| DelegationCoordinator + worker 唤起 | `coordinator.ts:104,144,182` |
| per-worker 工具过滤 | `coordinator.ts:253`（filterToolRegistry） |
| allowedTools/disallowedTools schema | `work-order.ts:93–94,206–247` |
| profile 工具策略 | `profile-registry.ts:20,42–85` |
| **per-runtime PromptEngine（cache 隔离单元）** | `worker-session.ts:26` |
| AdaptiveRouter | `adaptive-routing.ts:19` |
| SessionRegistry 角色 | `session-registry.ts:93,120` |
| 外部拉取（HTTP/GitHub） | `tools/import-resource.ts:97,135,181` |
| sandbox | `tools/sandbox-exec.ts` |
| prefix cache 实证基线 | `docs/analysis/2026-06-02-p1-cache-hit-rate-comparison.md` |


---

# 外部对照审查：OpenClaw 对照评估 (2026-06-06,天枢)

> 调研范围：`github.com/openclaw/openclaw` 主仓库全量（9687 文件，~2M+ LoC），重点对照 Gateway/路由/runtime/task 系统。

## 一、OpenClaw 架构速写

| 层次 | OpenClaw 实现 | 规模 |
|------|-------------|------|
| Gateway daemon | Express HTTP + WebSocket，常驻进程（launchd/systemd） | `gateway/server.impl.ts` ~1785 行，整个 `gateway/` 目录 ~200+ 文件 |
| Channel adapters | 30+ 聊天平台适配器（Telegram/Discord/Slack/Matrix/iMessage/WhatsApp/WeChat...），各自有连接认证、消息格式、富媒体处理 | `src/` 下 30+ 独立 channel 目录 + 30+ docs |
| Agent runtimes | 可插拔运行时引擎：内置 `openclaw` + 插件 harness（Codex、Copilot），per-model per-agent 可配 runtime | `docs/concepts/agent-runtimes.md` |
| Task system | TaskFlow registry + detached executor + cron scheduler，`openclaw tasks` CLI 管理，支持 audit/maintenance | `tasks/` 目录 ~20 文件，`task-executor.ts` 741 行 |
| Session model | `agent:agentId` session key，SQLite 持久存储，per-agent session 隔离 | `routing/session-key.ts`，`sessions/` 目录 |
| Auth | 多层认证：OAuth 多 provider、token、device auth、pairing code | `gateway/auth*.ts` ~30+ 文件 |
| SOUL.md | 身份外部化：每个 agent 一个 SOUL.md，agent 可读写演化自己的身份 | `docs/reference/templates/SOUL.md` |
| Tool policy | per-agent 可配 `allowedTools`，但无 runtime 级动态分级（READ_ONLY/WRITE 等） | 配置驱动，无代码级分级机制 |
| MCP | **未见内置 MCP 集成** —— OpenClaw 是独立生态，工具全内置 | — |

## 二、spec 核心论断逐条对照

### 2.1 "天枢不缺 Gateway 的零件，缺的是把零件接成 ingress 拓扑的那道线"

**部分正确，但差距比 spec 描述的大。** 对照：

| 零件 | 天枢现状 | OpenClaw 对应 | 差距 |
|------|---------|-------------|------|
| HTTP server | ✅ `rivet serve --port N` | ✅ Express + WebSocket | 天枢缺 WebSocket 实时推送 |
| Router | ✅ `createRouter` 原语 | ✅ Express router | 等价 |
| POST /prompt | ⚠️ handler 是桩 | ✅ `POST /v1/chat/completions` + `POST /v1/responses` | 天枢需把桩写成真实现 |
| 长驻 runtime 池 | ❌ 无 | ✅ per-agent session 持久 | **天枢真缺口** |
| Task system | ❌ 无 | ✅ TaskFlow registry + cron + detached executor | **天枢真缺口**（spec 未提） |
| Channel adapters | ❌ 不需要（spec 自明） | ✅ 30+ 聊天平台 | **不需要**（正确取舍） |
| Auth system | ❌ 无 | ✅ OAuth + token + pairing | **天枢真缺口**（spec §7 已正视） |
| SSE streaming | ✅ `handlePromptSSE` + `SseStream` | ✅ WebSocket + SSE | 等价 |
| Per-agent tool policy | ✅ `allowedTools` + `filterToolRegistry` | ✅ 配置级 allowedTools | **天枢更优**（有代码级动态分级 READ_ONLY/WRITE） |
| Sandbox 隔离 | ✅ `sandbox-exec` | ✅ 内置 | 等价 |
| Session store | ❌ 无持久化 session | ✅ SQLite per-agent | **天枢真缺口**（spec 未提——长驻 runtime 需要持久化 session 才能跨任务存活） |
| SOUL/身份外化 | ❌ 无 | ✅ SOUL.md 可演化 | **可选的后续增量**（spec §10 登记了"跨任务本体演化"但标记为待研究） |

### 2.2 "只差三道线没接"——实际上至少有五道

spec 识别了三道断点：
1. `serve` 没传 deps → `/prompt` 不注册
2. handler 是桩
3. 无长驻 runtime 池

实际审查中还缺：
4. **Session 持久化**：OpenClaw 的 `agent:agentId` session key → SQLite 存储 → agent 跨重启存活。天枢当前的 worker 是 per-delegate 即弃，没有持久化 session 的机制。长驻 runtime 池的前提是 runtime 的上下文可以序列化/恢复，否则进程重启 = 全部丢失。
5. **Auth 系统**：spec §7 已提及但列为 Phase 1（与 Phase 0 同批）。OpenClaw 的 auth 系统极其庞大（30+ 文件），天枢需要一个最小可行版（token 校验）而非全功能 auth。

### 2.3 "prefix cache × 长驻 runtime 的张力天然可解"

**正确且重要。** spec 的论证经得起对照：OpenClaw 每 session 独立、不关心跨 session cache。天枢的 `PromptEngine` per-runtime 实例确实可以实现 per-runtime prefix cache 隔离。这一点是真实优势——OpenClaw 没有这个优化。

但 OpenClaw 的巨大规模提醒一个事实：天枢的 cache 实证基线是单 REPL 会话 84-95%（`2026-06-02-p1-cache-hit-rate-comparison.md`），但 OpenClaw 不做跨 session cache 优化、靠模型 scaling 消化代价。这说明 **cache 优化在 agent 产品竞争力的必要程度上可能被高估**——不是没用，但不是 blocker。

### 2.4 "MCP 是缺口②"——但 OpenClaw 也没有

spec 把 MCP 列为真缺口②。对照发现：OpenClaw **也没有内置 MCP 支持**。OpenClaw 的工具生态全是自建（30+ chat adapter、内置 tool set），不依赖外部工具协议。这提示：

- MCP 不是 agent 产品的必需品，是锦上添花
- OpenClaw 的竞争力来自 "Gateway daemon × channel adapters" 的网络效应，不是来自工具协议的标准化
- 天枢作为编码 agent，MCP 价值在于接入外部数据源/服务，但优先级确实不高

## 三、spec 的盲区

### 3.1 任务管理系统的完整性

spec 聚焦 "POST /prompt 接任务 → route 到 runtime → SSE 流回"，这是**一次性异步调用**模式。但 OpenClaw 的任务系统远比这完整：

- **TaskFlow**：任务有生命周期（pending/running/completed/failed/cancelled）
- **Cron**：定时触发
- **Audit + maintenance**：运行中任务可见、可取消、可审计
- **Notify policy**：`errors_only` / `state_changes` / `silent`

天枢 spec 描述的是 "API 端点驱动 agent loop"——这是 OpenClaw 的 Gateway `/v1/chat/completions` 模式，**不是 OpenClaw 的 task system**。如果天枢想做 "常驻协作者"（而不仅是 "REPL 的 HTTP wrapper"），应该考虑任务系统的完整性：任务状态追踪、取消、重试、定时触发。

### 3.2 规模差异的真实含义

OpenClaw 9687 文件 vs 天枢 1204 文件。差距不在 agent 核心循环（双方同构），在**外围生态**：

- 30+ channel adapters = 大量集成代码
- Auth 系统 = 30+ 文件
- 移动端 app（iOS/Android/macOS）= 多个独立仓库
- 测试 = 巨量（每个功能都有 `.test.ts`）

**结论**：天枢走编码 agent 路线是正确聚焦。不要学 OpenClaw 铺 channel adapters。但可以学的是：
- **Gateway daemon 架构**（常驻进程接异步任务）——这正是 spec 要做的
- **Task system**（任务生命周期管理）—— spec 未覆盖，建议后续补
- **SOUL.md 身份外化**—— 低成本高收益的增强，适合天枢的星域体系

## 四、spec 的安全设计（§7）对比

| 安全措施 | spec 提议 | OpenClaw 现状 |
|---------|----------|-------------|
| 默认仅 127.0.0.1 | ✅ 强制 | ✅ 默认 |
| Token 认证 | ✅ `/prompt` 须认证 | ✅ 多层（OAuth + token + pairing） |
| Per-runtime tool policy | ✅ 最小权限 | ⚠️ 配置级，无动态分级 |
| 审批语义（headless） | ✅ `onApprovalRequired: false` | ✅ 可配 |
| Sandbox 隔离 | ✅ | ✅ |

天枢在 **per-runtime tool policy 动态分级**（READ_ONLY/WRITE）上比 OpenClaw 更精细。这是真实优势。

## 五、一句话评价

> **方向正确，差距比自评大但聚焦合理。** spec 的核心动作（接线 ingress → 真 handler → runtime 池）是正确的最小可行路径。但 (1) session 持久化是长驻 runtime 的隐性前提，spec 未提；(2) task 生命周期管理（取消/重试/状态追踪）缺失，后续应补；(3) 安全设计在 per-runtime policy 上比 OpenClaw 更优。总体可推进，但 Phase 0 前应先解决 session 持久化方案（或明确 Phase 0 的 runtime 不跨进程重启存活——降低 scope）。

---

# 审查回应与决议（2026-06-06，天璇 + 领航星裁定）

逐条回应天枢审查，附领航星裁定：

**① Task 生命周期系统缺失 —— 接受。** 天枢对：本 spec 是「一次性异步调用」≈ `/v1/chat/completions`，不是 task system，「常驻协作者」标题过度承诺。补充事实：天枢非零基础——已有 `task-board.ts`/`task-state.ts`/`turn-heartbeat.ts`/`nightcrawler.ts` + coordinator 完整 `AbortSignal`（`coordinator.ts:81,144`，取消已有）。缺的是把这些提升到 daemon 级生命周期。**裁定：拆姊妹 spec `2026-06-06-task-lifecycle-system-design.md`，本 spec 收窄为 ingress+runtime 池+cache（已 retitle）。**

**② Session 持久化 —— 两轮对称修正。** 一次审查我修正天枢自评「❌ 无持久化 session」：`SessionPersist` 类存在且服务主会话（`loop.ts:420`）。**但二次审查天枢反过来修正了我的轻描**：我说「比天枢估的轻、是纯接线」——错了。经核实 `PromptEngine` 无状态导出/注入 API（`prompt/engine.ts` 无 `exportState/getState`），跨重启存活**要先给 PromptEngine 新增状态导出/注入能力**，不止接 SessionPersist。**净判断：这道线比我估的重、比天枢估的有基础——两端都校了。** §2/§6/Phase 2 已据此更新。

**③ cache 是否被高估 —— 领航星收窄裁定。** 我原主张「cache 是弱模型护城河」说宽了，天枢「cache 被高估」也说宽了。裁定：**只保 DeepSeek 的 OpenAI 兼容前缀 cache**；目标模型集 = GLM5.1 / MiMo-v2.5pro / DeepSeek-v4，其余开源模型 cache 不管。§4 已按此收窄。

**④ MCP —— 接受降级。** OpenClaw 也没 MCP，非缺口，是可选增量。§5 已降级。

**⑤ SOUL.md / 跨任务本体演化 —— 领航星裁定：放着不动。** §10 维持「待研究、严格不实施」。不开独立 spec，不深入。

**⑥ per-runtime tool policy 动态分级（READ_ONLY/WRITE）—— 天枢确认为天枢真实优势。** 保持，作为相对 OpenClaw（仅配置级）的差异点。

**净结论**：天枢审查使本 spec scope 更诚实（拆 task、补 session 持久化前提），领航星裁定使 cache 定位更精确（DeepSeek-only）。本 spec 现交付范围明确：HTTP 可达的、cache 隔离的长驻 runtime 池；task 生命周期与本体演化各有归属。


---

# 天枢二次审查附注 (2026-06-06)

> 本注针对修订后的两份姊妹 spec（A: 本 ingress spec，B: `2026-06-06-task-lifecycle-system-design.md`）做最终核实。详细修订已写入 spec B 末尾（含跨会话记忆核实、SessionPersist 接线精度、task 持久化格式等问题），此处不重复。
>
> **关键纠正**：天枢的跨会话记忆是结构化 claim 数据库（`ContextClaimStore` + `remember`/`recall` 工具，durable claims 跨会话存活），**不是** SOUL.md 式的连续身份文件。spec A §10 已正确标记为待研究，两 spec 其余部分对标实际能力无过度承诺。
>
> **spec A 额外注**：`worker-session.ts` 目前未接 SessionPersist，Phase 2 接入需要 `PromptEngine` 支持状态导出/注入（当前不存在），不止调 API。cache 基线 84-95% 是单会话内测量，不应写死为跨任务保证值。
>
> spe**c B 额外注**：task 记录需要随机读写（状态更新），SessionPersist 的 JSONL 追加模式不适合，建议 KV 存储。scheduler 需持久化 schedule 表，否则重启全丢。缺少 task 超时和去重设计。
>
> **净结论**：两份 spec 架构方向正确，scope 拆解合理。以上为精度修正——用代码实际能力校准隐性承诺。
