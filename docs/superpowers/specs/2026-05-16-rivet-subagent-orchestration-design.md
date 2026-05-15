# Rivet 主控模型子代理协同能力深度头脑风暴结果

## 背景

### 用户需求

用户希望讨论并设计 Rivet 的子代理协同能力，参考 oh-my-claudecode、everything-claude-code、ruflo 等生态项目。当前 Rivet 仍是单模型单循环：`AgentLoop` 绑定一个 `ApiClient`，整轮对话从思考、工具调用到结果处理都在同一个循环中完成；`recommendModelForTask()` 只是纯函数，没有接入运行时；`/model` 是用户手动切换；`compactClient` 是唯一多模型点，但只用于压缩，不参与任务执行。

本轮目标不是直接实现，而是先做设计：让主控模型能够把用户请求拆成子任务，选择合适协作者模型或 worker，分发执行，收集结果，再由主控会话统一汇总和验收。

### 当前项目上下文

Rivet 已有可复用地基：

- `AgentLoop`：负责模型 streaming、工具执行、approval、evidence 和 checkpoint callback。
- `SessionContext`：负责消息、token 估算、cache history 和文件/测试追踪。
- `ToolRegistry` / `Tool`：工具具备 `requiresApproval()`、`isConcurrencySafe()`、`isEnabled()` 接口。
- `EvidenceTracker` / `VerificationMetadata`：可记录读写文件和测试结果。
- `checkpoint v2`：记录 pre-existing dirty files、agent touched files、confirmation token，支持只回滚 agent-owned 文件。
- `ModelCapabilityCard` / `recommendModelForTask()`：已具备按任务类型推荐模型的纯函数能力。
- P2.3 Harness Cockpit 计划：准备把 trace、verification、approval risk、context/cache、safety/checkpoint、model capability 在 TUI 中显性化，但明确不做多 agent 编排。

因此，本设计应作为 P2.4/P3 方向，不塞进 P2.3。

### 调研发现摘要

#### Scout A：Rivet 运行时代码 seam

- `AgentCallbacks` 是 `AgentLoop` 与外界之间最窄的生命周期桥：text delta、tool use、approval、turn complete、abort、checkpoint 都通过这里流出。
- `Tool` 接口已暴露 `isConcurrencySafe()`，但当前运行时没有使用它；这是未来 coordinator 可以立刻消费的调度信号。
- `SessionContext` 是 mutable push 模型，没有 fork/snapshot/copy-on-write；多个 loop 不能共享同一个 session。
- `AgentLoop` 构造时接收一个 `ApiClient`，因此技术上可以创建多个独立 `AgentLoop` 实例，但必须给每个 worker 独立 session。
- prefix cache 依赖稳定 system prompt 与 tool definitions；worker 设计必须尽量复用相同 prompt prefix。

#### Scout B：开源协调器与 Claude Code 生态

- oh-my-claudecode 倾向把 skills/workflows/hooks/teams 分层：skills 是行为单元，team workflow 是多 agent 流水线，tmux/provider CLI 可作为 worker 执行面。
- everything-claude-code 的可借鉴点是：specialized subagents、verification-first workflow、hooks as runtime policy、可审计安装/配置和 dashboard/inspect。
- ruflo 提供 layered dispatcher：hooks 捕获任务、router 分配 agent/swarm、memory 学习闭环、MCP 暴露能力；但 swarm/federation/100+ agents 对 Rivet 当前阶段过重。
- 外部项目普遍强调三种隔离：fresh context、tool schema allowlist、filesystem isolation/worktree。
- 最可复用的轻量模式是 bounded worker pool + typed work orders + structured result packets，而不是完整 swarm。

#### Scout C：随机相邻领域机制

- Erlang OTP supervisor 的 `intensity/period` 失败预算：worker 在窗口内失败过多时，不继续重试，而是向上升级策略。
- Kubernetes controller 的 deduplicating WorkQueue：同一个 key 多次变更只触发一次 reconcile，且每个 key 同时只有一个 worker 处理。
- Behavior tree 的 Selector/Sequence/Parallel：可把任务分解、fallback、并行阈值、RUNNING 状态建模为明确节点。
- 最有价值的随机机制是：失败预算耗尽后“升级到更高视角”，而不是局部无限重试。

#### Scout D：定向反证

初始假设：Rivet 最适合做 bounded local coordinator：主控会话拆 typed work orders，调度 read-only 或 isolated worker sessions，通过 queue/pool 发给不同模型，收到 structured result packets，最后只由主控会话应用或审批更改。

反证发现：

| 前提 | 分层 | 如果不成立，设计必须改变 |
|---|---|---|
| `AgentLoop` 可安全隔离 | 假设 | 必须先做 `SessionContext.fork()` 或独立 worker session，不能共享 primary session |
| read-only worker 可由工具 allowlist 强制 | 假设 | 需要 prompt 约束、schema 输出验证和工具层 allowlist 三重边界 |
| worker 会输出结构化 result packet | 假设 | 需要 zod schema、解析失败重试和 fallback summary |
| TUI 能展示并发会话 | 假设 | 初版 worker 必须 headless，只在 primary TUI 显示摘要/trace |
| `isConcurrencySafe()` 已有意义 | 现状 | 当前未接线；coordinator 必须把它变成实际调度约束 |
| prefix cache 能跨 worker 保持 | 假设 | worker 必须共享 system prompt/tool definitions，仅 user task 不同 |
| 任务分解很简单 | 假设 | 需要 explicit decomposition prompt、任务类型枚举和 budget gate |
| worker 数越多越快 | 假设 | 需要 cost/latency budget，小任务必须回落单 loop |
| checkpoint 可自然扩展到多 worker | 假设 | 需要 per-worker checkpoint 或 worktree isolation |
| approval gate 适合异步 worker | 假设 | 需要 multiplexed approval queue，显示 worker identity 和风险 |

最危险的 3 个前提：SessionContext 隔离、prefix cache 跨 worker 成本、共享文件系统并发安全。

可转化为优势的前提：prefix cache。若 worker 复用相同 system prompt 和 tool definitions，DeepSeek V4 的 system prefix cache 可以让多个 worker 只为 task-specific user message 付主要成本，子代理协同反而成为 cache-friendly 的能力扩展。

---

## 三轮思考过程

## 第一轮：变异

[VARIATION]

生态位：本地终端编码代理 / TypeScript + Ink TUI / DeepSeek V4 prefix cache / 单 repo 代码修改 / 用户希望主控模型调度协作者模型。

选择压力：

- 主控会话必须保持最终控制权。
- worker 不能破坏用户工作区或污染 primary session。
- 调度必须能在小任务上自动回落，不能让开销超过收益。
- 子代理结果必须可验证、可审计、可汇总。
- 不能引入超过当前项目阶段的分布式 swarm 复杂度。

已占据生态位：

- Claude Code/OMC 式外部编排：slash skill + tmux/agents/worktrees。
- ruflo 式 heavy swarm：router + memory + MCP + federation。
- OpenDev 式 schema-filtered subagent sessions。
- cc-manager 式 worktree pool + child process。

空位：

- Rivet 内置、cache-first、headless worker 的本地 coordinator。
- read-only scout 与 write-capable worker 分层，而不是所有 worker 都能改代码。
- 把 `isConcurrencySafe()`、checkpoint v2、verification metadata 接成真实调度约束。

调研发现：

- 代码 seam 最适合先接 `AgentCallbacks`、`AgentConfig.client` 和 `ToolRegistry`，而不是重构 `ApiClient.stream()`。
- 开源项目可借鉴 worktree pool、tool allowlist、fresh context、structured summary；应避免 full swarm、federated agents、复杂 memory learning。
- 相邻领域给出 WorkQueue dedupe、failure budget escalation、parallel threshold policy、idempotent reconcile。
- 反证指出必须先解决 session fork、schema result、worker approval、prefix cache 与 filesystem isolation。

方案：

### V1（主流）：外置 CLI worker 编排

这个方案选择让主控会话在需要协作时启动外部 worker 进程或 provider CLI，在独立目录/终端里完成调研或实现，然后把文本总结交回 primary。

人/场/动/果：用户在大型任务中要求并行时，Rivet 主控生成 worker prompt，启动外部 CLI worker，worker 在独立进程完成任务，用户得到多路结果摘要。

核心形态：

- `WorkerProcess` 使用 `child_process.spawn()`。
- 每个 worker 可映射到 provider CLI 或本项目自己的 `rivet --worker` 模式。
- 结果通过 stdout/SSE/file drop 回传。
- 写任务默认用 git worktree 隔离。

### V2（邻近）：内置 Headless AgentLoop worker pool

这个方案选择让主控会话创建多个 headless `AgentLoop`，每个 loop 拥有独立 `SessionContext`、tool allowlist 和 model card，执行 typed work order 后返回 structured result packet。

人/场/动/果：主控模型判断当前请求可拆分时，把“查代码”“查文档”“写测试”“验证构建”等子任务发给 headless workers，workers 只返回 schema-validated result packet，primary 决定下一步。

核心形态：

- `Coordinator` 管理 `WorkOrderQueue`。
- `WorkerSession` 内含独立 `SessionContext` + `AgentLoop` + selected `ApiClient`。
- worker 默认 headless，不直接操作 TUI。
- primary TUI 只显示 worker trace summary。
- 初版写任务可禁用，先做 read-only scout 与 verification worker。

### V3（空位）：工具化 delegation，不创建真正 worker loop

这个方案选择把“分发任务”实现成一个普通工具：主模型调用 `delegate_task`，工具内部用固定 prompts 调用模型 API 或本地分析函数，返回结构化结果；没有完整 AgentLoop，也没有 worker 工具调用能力。

人/场/动/果：主控模型在需要第二意见或并行调研时调用 `delegate_task` 工具，工具发起一次无工具 LLM 调用或只读代码扫描，返回一个限定 schema 的研究结果，用户得到低风险辅助判断。

核心形态：

- 新增 `delegate_task` tool。
- worker 不拥有 tool registry，也不执行写操作。
- 支持 `research`、`review`、`summarize`、`plan` 等无写任务。
- 成本低、实现快，但能力上限低。

### V4（突变）：黑板式多 worker 自组织

这个方案选择让主控模型只定义目标和约束，多个 worker 围绕 shared blackboard 抢任务、写发现、互相衍生子任务，直到满足完成条件。

人/场/动/果：用户提出大型目标后，Rivet 启动多个 worker，它们从共享 blackboard 认领任务、写 evidence、创建后续任务，最终主控读取 blackboard 合成结果。

核心形态：

- `Blackboard` 存储 tasks/findings/artifacts/evidence。
- worker 可动态创建子任务。
- 使用 behavior-tree/selector/parallel 策略控制收敛。
- 需要冲突合并、权限治理、停止条件和摘要压缩。

创始假设：

1. 用户说“Pro 安排 Flash 协同”，隐含假设是多模型并行一定比单模型更好；实际需要 budget gate。
2. 用户说“分发任务”，隐含假设是任务可自动拆解；实际要先限制可拆任务类型。
3. 用户说“子代理”，隐含假设是子代理能写代码；初版可能应该先允许 read-only scout 和 verifier。
4. 参考 ruflo/OMC，隐含假设是 swarm/teams 值得复制；Rivet 当前阶段更适合轻量内置 coordinator。
5. “主控模型安排子代理”隐含主控仍应拥有最终 write authority；这个假设是正确且应保留的安全边界。

适应度函数：

- 硬约束：独立 `SessionContext`；不共享 mutable message history；worker 输出 schema-valid；写操作必须串行或隔离；primary 保持最终控制权；不破坏 P2.3 cockpit 和现有 slash commands。
- 加分：复用 prefix cache；复用 verification/evidence/checkpoint/model capability；支持 read-only 并行；TUI 可观察；失败可升级；实现能分阶段验收。
- 减分：需要大规模重构；引入外部 daemon/MCP/federation；worker 可直接修改 primary working tree；结果只能靠自由文本；调度成本对小任务过高。

### 第一轮结构化碎片

```json
{
  "phase": "diverge",
  "fragments": [
    {
      "text": "SessionContext 是 mutable push 模型，worker 不能共享 primary session",
      "fragmentType": "risk",
      "source": "agent",
      "tags": ["session", "isolation", "runtime"]
    },
    {
      "text": "Tool.isConcurrencySafe 已存在但未接线，可作为调度约束的扩展适应点",
      "fragmentType": "mechanism",
      "source": "agent",
      "tags": ["tool", "scheduler", "latent-signal"]
    },
    {
      "text": "Deduplicating WorkQueue 可以避免同一文件或同一问题被多个 worker 重复处理",
      "fragmentType": "mechanism",
      "source": "external",
      "tags": ["queue", "dedupe", "kubernetes"]
    },
    {
      "text": "failure budget 耗尽时升级到主控或更强模型，而不是在 worker 内无限重试",
      "fragmentType": "mechanism",
      "source": "external",
      "tags": ["supervision", "failure", "escalation"]
    },
    {
      "text": "prefix cache 可把多 worker 从成本风险转为能力优势，只要 worker 共享 system prompt/tool definitions",
      "fragmentType": "contradiction",
      "source": "agent",
      "tags": ["cache", "cost", "deepseek"]
    }
  ],
  "candidates": [
    {
      "id": "V1",
      "niche": "外置 CLI worker 编排",
      "oneLiner": "主控启动外部 worker 进程，在独立环境执行任务后回传摘要",
      "fragmentRefs": ["worktree pool", "tmux provider"]
    },
    {
      "id": "V2",
      "niche": "内置 Headless AgentLoop worker pool",
      "oneLiner": "主控创建独立 headless sessions 执行 typed work orders 并收结构化结果",
      "fragmentRefs": ["AgentLoop instances", "structured result"]
    },
    {
      "id": "V3",
      "niche": "工具化 delegation",
      "oneLiner": "主控调用 delegate_task 工具发起低风险模型辅助调用并返回结构化研究结果",
      "fragmentRefs": ["tool seam", "schema validation"]
    },
    {
      "id": "V4",
      "niche": "黑板式自组织 worker",
      "oneLiner": "多个 worker 围绕 shared blackboard 认领任务、写发现并收敛到最终结果",
      "fragmentRefs": ["behavior tree", "blackboard"]
    }
  ]
}
```

---

## 第二轮：选择

[SELECTION]

### 2.1 目标重注入

重新注入用户原始目标：用户要的是 Rivet 主控模型自动安排子代理执行任务的能力，具体缺失任务分解器、子代理调度器、子代理通信、并行执行、`recommendModelForTask()` 运行时接线。用户明确要求“先做设计，然后这个任务用与 Rivet 独立完成，我们验收”。

目标偏移：

- V1 仍回应目标，但更偏外部进程编排，可能不像 Rivet 内置能力。
- V2 正面回应目标：任务分解、调度、通信、并行、model routing 都在内置运行时。
- V3 回应一部分目标，但不是真正子代理执行任务，只是 delegation tool。
- V4 回应“大型协作愿景”，但超出当前阶段，容易滑向 ruflo 式 full swarm。

### 2.2 因果压力测试

| 方案 | 因果链 | 结果 |
|---|---|---|
| V1 | 用户任务 → 主控生成 prompt → 外部 worker 执行 → stdout/file 回传 → 主控汇总 | 通过，但依赖外部 CLI 和进程协议 |
| V2 | 用户任务 → 主控 decomposer 产出 typed work orders → coordinator 选模型/tool allowlist/session → headless worker 执行 → structured packet → primary synthesize/apply | 通过，链路直接对应缺失组件 |
| V3 | 用户任务 → 主控调用 delegate tool → 单次模型/只读分析 → 结构化研究结果 → 主控使用 | 部分通过，但缺少多轮 worker 工具执行和真正并行实现能力 |
| V4 | 用户目标 → blackboard 自动扩散任务 → workers 自组织 → 主控读最终状态 | 因果链断裂：停止条件、冲突治理、权限边界都未定义 |

灭绝候选：V4。它把“主控安排子代理”变成“worker 自组织”，削弱主控权威。

### 2.2.5 证据分层

| 证据 | 分类 | 处理方式 |
|---|---|---|
| `SessionContext` 当前是 mutable shared state | 现状 | 可通过 fork/new session 改变，是设计前置 |
| `Tool.isConcurrencySafe()` 未被使用 | 现状 | 可接入 scheduler，不是阻塞 |
| DeepSeek prefix cache 依赖稳定 prefix | 事实 | 作为硬约束：worker 必须共享稳定 system prompt/tool schemas |
| TUI 当前只有单 streaming 区域 | 现状 | 初版 worker headless，只显示 summary/trace |
| 参考项目使用大量 skills/agents/swarms | 惯例 | 可借鉴分层，不应照搬复杂度 |
| 子代理必须能写代码才算有价值 | 假设 | 可质疑；read-only scout/verifier 初版就能产生价值 |
| 多 worker 一定更快 | 假设 | 需要 budget gate 和小任务回落 |
| 工作区并发写可以靠 prompt 避免 | 假设 | 不可信；必须用工具层/工作区层隔离 |

### 2.3 成本-收益压力测试

| 方案 | 开发成本 | 机会成本 | 维护成本 | 风险成本 | 适应度 |
|---|---:|---:|---:|---:|---|
| V1 外置 CLI | 中高：进程协议、worktree、跨 provider | 推迟内置 runtime 能力 | 中：进程/CLI 兼容 | 中：worker 输出不稳定 | 中 |
| V2 内置 Headless pool | 中：session fork、queue、schema、callbacks | 推迟 full swarm | 中：运行时内聚 | 中：并发与 approval 需严格边界 | 高 |
| V3 delegation tool | 低：一个工具 + API call + schema | 推迟真正子代理 | 低 | 低 | 中高，适合作为 Phase 1 |
| V4 blackboard swarm | 高：blackboard、locking、stop condition、conflict | 吞掉 P2.3/P2.4 资源 | 高 | 高 | 低 |

### 2.4 共演化检测

- V1：技术选择偏外置，业务目标会演化为“Rivet 管别的 CLI”，与 Rivet 内置能力目标弱共演化。
- V2：技术结构与业务目标强共演化。worker result、cockpit trace、model capability routing、verification 可以互相增强。
- V3：技术结构与短期目标共演化。它能快速验证“主控分发有价值”，但长期会遇到无工具 worker 上限。
- V4：技术结构强烈驱动业务目标漂移到 swarm platform，不适合当前阶段。

### 2.5 局部最优陷阱检测

- V3 是最安全的局部最优：实现快、低风险，但容易停留在“高级工具调用”，不能形成真正 worker runtime。
- V1 是生态惯例局部最优：用 tmux/worktree/CLI 很快看起来像 team，但对 Rivet 自身 runtime 能力提升有限。
- V2 需要先支付 session isolation 和 result schema 成本，但抵达的远程高峰是：Rivet 内置 cache-friendly coordinator。
- V4 是远程高峰假象：看似强大，实际对当前阶段是范围爆炸。

### 2.6 落地性测试

| 方案 | 第一步具体动作 | 前置条件数量 | 指标 | 结果 |
|---|---|---:|---|---|
| V1 | 新增 `WorkerProcess`，spawn 一个 read-only external worker 并读取结果文件 | 3：CLI 协议、环境检测、输出协议 | 1 个外部 worker 返回 summary | 可执行但依赖外部生态 |
| V2 | 新增 `WorkerSession`，用独立 `SessionContext` 跑一个无写工具的 headless `AgentLoop` | 3：session fork、新 registry allowlist、result schema | 1 个 read-only worker 返回 schema packet | 可执行且贴目标 |
| V3 | 新增 `delegate_task` 工具，用 zod 验证一次模型调用输出 | 2：API client、schema parser | 一次 delegation 输出 valid JSON | 可执行，但不是完整子代理 |
| V4 | 新增 blackboard 和 worker 自组织循环 | 超过 5：locking、queue、stop、schema、merge、approval | 多 worker 收敛率 | 高概念寄生，灭绝 |

### 2.7 灭绝与留存

灭绝：

- V4 — 原因：它把主控模型的责任让渡给 blackboard 自组织，停止条件、权限、冲突和审计都过重，无法用一个实施计划稳定覆盖。
- V1（降级为非主线）— 原因：它优先复制外部 CLI/team 生态，但用户目标是增强 Rivet 运行时自身；可作为后续 worktree/process isolation 层，而不是第一主线。

存活：

- V2 — 优势：直接覆盖任务分解器、调度器、通信、并行执行、model routing 接线；能复用已有 `AgentLoop`、`ApiClient`、`ModelCapabilityCard`、verification/evidence/checkpoint。
- V3 — 优势：实现成本低，适合作为 V2 的 Phase 1 “无工具/只读 delegation”验证层；可以回收为 V2 的 bootstrap mechanism。

最强竞争者：V2 + 吸收 V3 的低风险入口。

理由：V2 是最终形态，V3 是最小验证路径。组合后既不滑向 swarm，也不止步于工具化伪代理。

新发现：真正设计核心不是“并发”，而是“主控权威 + 隔离 session + schema packet + budget gate + evidence merge”。并发只是这些边界成立后的一个调度策略。

### 2.7.1 discarded_trait 特征回收

```json
{
  "phase": "select",
  "extinctions": [
    {
      "candidateId": "V4",
      "reason": "shared blackboard 自组织削弱主控权威，且停止条件、冲突治理、权限边界超出当前阶段",
      "salvagedTraits": [
        {
          "trait": "blackboard 的 findings/artifacts/evidence 分栏",
          "transferableTo": ["V2"]
        },
        {
          "trait": "behavior tree 的 Parallel threshold policy",
          "transferableTo": ["V2"]
        },
        {
          "trait": "RUNNING 状态可让 worker 不必一次性完成，可分 tick 汇报",
          "transferableTo": ["V2"]
        }
      ]
    },
    {
      "candidateId": "V1",
      "reason": "外置 CLI/process 优先会让 Rivet 变成别的 harness 的壳，而不是增强自身 runtime",
      "salvagedTraits": [
        {
          "trait": "worktree pool 的 filesystem isolation",
          "transferableTo": ["V2"]
        },
        {
          "trait": "spawn 后清理环境变量，避免递归 agent 嵌套",
          "transferableTo": ["V2"]
        },
        {
          "trait": "stdout/SSE event relay 作为低成本观察通道",
          "transferableTo": ["V2"]
        }
      ]
    }
  ],
  "survivors": [
    {
      "candidateId": "V2",
      "advantage": "覆盖全部缺失组件并复用 Rivet 既有运行时地基",
      "rank": 1
    },
    {
      "candidateId": "V3",
      "advantage": "最小成本验证 delegation schema 和主控汇总体验",
      "rank": 2
    }
  ]
}
```

---

## 第三轮：适应

[ADAPTATION]

### 3.1 套路清除

清除的套路：

1. “多 agent 就应该 swarm” — 对 Rivet 当前阶段过重；本设计使用 bounded local coordinator。
2. “子代理必须能改代码” — 初版先做 read-only scout、reviewer、verifier；写 worker 必须 worktree/serial gate。
3. “并行越多越好” — 引入 budget gate、max workers、per-key dedupe 和 failure budget。
4. “主控模型口头安排就够了” — 必须用 `WorkOrder` schema、`WorkerResult` schema 和 zod validation。
5. “TUI 要显示所有 worker 流” — 初版 worker headless，TUI 只显示 coordinator rail / event summaries。
6. “model routing 函数接上就完成了” — `recommendModelForTask()` 只是 selection signal，仍需要 decomposer、scheduler、worker session、result aggregation。

### 3.2 扩展适应

已有资源的新用途：

1. `ModelCapabilityCard`：从静态测试对象扩展为 scheduler 的 model selection table。
2. `VerificationMetadata`：从 test tool metadata 扩展为 `WorkerResult.verification` 的统一字段。
3. `EvidenceTracker`：从单 run 证据扩展为 coordinator 汇总多个 worker facts 的 ledger。
4. `Tool.isConcurrencySafe()`：从未用接口扩展为 scheduler 对 write/read/verification 任务的并发约束。
5. `checkpoint v2` 的 `agentTouchedFiles`：从 rollback 安全扩展为 worker write scope 边界。
6. P2.3 Cockpit 的 trace/safety/context/model panels：从单 loop 观测扩展为 coordinator event rail。
7. DeepSeek prefix cache：从长会话成本优化扩展为 multi-worker 成本优化理由。

吸收 discarded traits：

- 从 V3 吸收 `delegate_task` 的低风险 schema 验证路径：作为 Phase 1 的 “planner/scout worker” 验证层。
- 从 V1 吸收 worktree pool：作为 Phase 3 write-capable workers 的文件系统隔离层。
- 从 V4 吸收 findings/artifacts/evidence 分栏：作为 `WorkerResult` 的结构，而不是 shared blackboard。
- 从 behavior tree 吸收 threshold policy：`all_required`、`first_success`、`majority` 三种 aggregation mode。
- 从 Kubernetes 吸收 dedupe key：同一 file/path/concern 同时只允许一个 mutating worker。
- 从 Erlang OTP 吸收 failure budget：worker 连续失败后升级给 primary 或更强模型。

### 3.3 具体化替换

人：

- 主控模型：当前 primary `AgentLoop`，负责判断是否拆任务、生成 `WorkOrder[]`、审批/汇总结果、对用户说最终结论。
- 协作者模型：headless `WorkerSession`，每个 worker 有独立 `SessionContext`、tool allowlist、model card、budget 和 result schema。
- 用户：在 TUI 中看到 coordinator rail、worker 状态、approval risk 和最终 evidence；只对风险操作或结果应用做确认。

场：

- 场景 1：用户问“这个 bug 怎么修”，primary 分发一个 read-only code scout 和一个 test scout，自己保留决策权。
- 场景 2：用户要实现跨文件功能，primary 分发 planner/reviewer/verifier，写操作仍由 primary 或 isolated write worker 完成。
- 场景 3：用户要快速调研外部方案，primary 启动多个 research workers，并以 `first_success` 或 `all_required` 聚合。
- 场景 4：worker 失败两次，coordinator 停止本地重试，升级到 stronger model 或询问用户。

动：

第一步：primary 在 run 开始前或某个 tool-use 前调用 decomposer，产出 typed `WorkOrder[]`。

第二步：scheduler 根据 task kind、scope、model capability、tool allowlist、budget 和 dependency 选择执行方式：inline、single worker、parallel workers、defer。

第三步：每个 `WorkerSession` 创建独立 `SessionContext`，复用相同 system prompt/tool definitions，附加 task-specific user prompt。

第四步：worker 执行工具或模型调用，输出 `WorkerResult`，必须通过 zod schema 验证；失败则重试一次 schema repair，再失败标记 blocked。

第五步：aggregator 按 policy 汇总结果，写入 `CoordinatorState`，并只把压缩后的 result packet 注入 primary session。

第六步：primary 综合结果后决定是否继续工具调用、应用修改、运行 verification 或向用户报告。

果：

- 用户可以看到 “2 workers running / 1 passed / 1 blocked / verification missing” 的状态。
- 对可并行调研任务，首个可用结果时间下降。
- 对跨文件实现任务，主控不会盲改，而是拿到 scoped findings 和 verification suggestions。
- 对失败任务，系统不会无限循环，而是按 failure budget 升级。
- 对成本，worker 使用同样 prompt prefix，保持 DeepSeek cache 友好。

可衡量指标：

- `worker_result_schema_valid_rate >= 95%`。
- read-only worker 不触发 write tool 的比例为 100%。
- 同一 `dedupeKey` 的 mutating work 同时 in-flight 数量为 0 或 1。
- worker 失败超过 `maxFailuresPerWindow` 后必须升级，不允许继续本地 retry。
- 小任务 budget gate 回落单 loop 的比例可观察。
- primary session 中注入的 worker summary 平均小于原 worker transcript 的 10%。

### 3.4 收敛演化验证

收敛点：

- V1、V2、V3 都收敛到“fresh context + constrained tools + structured summary”是子代理协同的核心真相。
- V1 和 V2 收敛到“写任务必须隔离或串行”。
- V2 和 V3 收敛到“schema result 比自由文本更重要”。
- V2 和 V4 收敛到“需要 facts/evidence/artifacts 分栏”，但 V2 保留主控权威，V4 失控。
- 外部调研和代码反证都收敛到“不是先做 swarm，而是先做 bounded local coordinator”。

核心真相：Rivet 的子代理协同应从“可验证的 typed work order/result packet”开始，而不是从“更多并发执行单元”开始。

### 3.5 实施路径设计

#### Phase 1：Delegation Contract + Read-only Scout MVP

动作：

- 新增 `src/agent/work-order.ts`：定义 `WorkOrderKind`、`WorkOrder`、`WorkerResult`、`AggregationPolicy`、`WorkerBudget`。
- 新增 `src/agent/coordinator.ts`：只支持 `research` / `code_search` / `review` 三类 read-only work order。
- 新增 `createWorkerSession()`：创建独立 `SessionContext` 和 read-only `ToolRegistry` allowlist。
- 新增 `parseWorkerResult()`：用 zod 验证 worker JSON；失败时做一次 schema repair。
- primary 不自动写代码，只把 worker packet 压缩注入当前会话。

预期产出：

- 主控可以把一个请求拆成 1-3 个 read-only workers。
- worker 只可用 `read_file`、`grep`、`glob`、`diff`、`inspect_project`、`repo_map`、`related_tests` 等只读工具。
- `recommendModelForTask()` 首次进入运行时，用于选择 worker model。

成功标准：

- 单测覆盖：work order schema、result parsing、tool allowlist、session isolation、budget gate。
- 手动验收：用户提出跨文件问题，Rivet 显示 2 个 headless scout 运行，并汇总 findings。
- read-only worker 无法调用 write/edit/bash mutation 工具。

退出条件：

- 如果 schema valid rate 低于 80%，先暂停多 worker，强化 result contract。
- 如果 worker 成本明显高于单 loop，收紧 budget gate，只在显式 `/delegate` 或复杂任务触发。

#### Phase 2：Coordinator Queue + Cockpit Visibility

动作：

- 新增 `WorkOrderQueue`：支持 priority、dependencies、dedupeKey、per-key in-flight guard。
- 新增 `CoordinatorState`：workers、events、results、budgets、failures。
- 把 worker lifecycle 通过 P2.3 Cockpit trace/safety/model panels 展示。
- 接入 failure budget：N 次失败后升级到 primary 或 stronger model。
- 增加 aggregation policies：`all_required`、`first_success`、`majority`、`primary_decides`。

预期产出：

- 用户能看到 worker 状态，不需要看完整 worker transcript。
- 同一文件/同一 concern 的重复任务被 dedupe。
- worker 失败不会无限重试。

成功标准：

- 同一 dedupeKey 并发 mutating worker 为 0。
- failure budget 单测验证：超限后不再 retry，而是 `escalated`。
- Cockpit 显示：queued/running/passed/failed/blocked/escalated。

退出条件：

- 如果 TUI 噪音过高，默认只显示 summary rail，详细 worker panel 通过 `/cockpit workers` 打开。

#### Phase 3：Isolated Write Workers + Verification Aggregation

动作：

- 引入 optional worktree isolation：write-capable worker 必须在 isolated worktree 或受 serial mutation lock 保护。
- `WorkerResult` 增加 `patchSummary`、`changedFiles`、`verification`、`risk` 字段。
- primary 不直接信任 worker 修改；先读取 diff/verification，再决定 apply/merge。
- 将 checkpoint v2 扩展为 per-worker checkpoint 或 worktree branch metadata。
- approval queue 支持 worker identity、tool name、targets、risk reason。

预期产出：

- worker 可以独立实现小 patch，但不会直接污染 primary 工作区。
- primary 可以对 worker diff 做 review，并运行 full/targeted verification。

成功标准：

- worker 写失败不会删除用户 pre-existing dirty files。
- worker patch 可丢弃、可应用、可重新验证。
- evidence badge 显示各 worker 的 verification status 和未验证风险。

退出条件：

- 如果 worktree merge 复杂度高，保留 read-only worker + primary writes 模式，推迟 write workers。

#### Phase 4：Adaptive Routing + Learning-lite

动作：

- 根据 `ModelCapabilityCard`、历史 worker pass/fail、schema validity、latency/cost 更新 routing score。
- 支持 task kind 到 worker profile 的配置：`planner`、`code_scout`、`reviewer`、`verifier`、`doc_researcher`。
- 只保存轻量统计，不做 vector memory / federated swarm。

预期产出：

- 主控能稳定选择更适合的 model/profile。
- 用户可通过 `/workers` 或 cockpit 查看各 profile 的表现。

成功标准：

- routing policy 可解释：为什么选这个 model/profile。
- 学习统计可关闭、可清空、不会泄漏敏感内容。

退出条件：

- 如果统计引入错误偏置，默认关闭 adaptive learning，仅保留手动配置。

### 3.6 最终综合

最终方案：**Cache-first Bounded Coordinator**。

Rivet 不复制 ruflo 的 full swarm，也不先做外部 tmux team，而是在本地运行时新增一个 bounded coordinator。主控模型先通过 decomposition prompt 产出 typed `WorkOrder[]`；scheduler 根据 task kind、budget、dedupeKey、model capability 和 tool allowlist 决定是否派发；worker 是 headless `AgentLoop` 或低风险 delegation call，拥有独立 `SessionContext`，复用相同 system prompt/tool definitions 保持 DeepSeek prefix cache；worker 输出必须是 schema-valid `WorkerResult`；aggregator 只把压缩后的 result packet 注入 primary session；写操作在初版禁止，后续必须通过 worktree isolation 或 serial mutation lock；P2.3 Cockpit 负责显示 worker lifecycle、failure budget、risk、verification 和 model choice。

最强适应点：

- 它把 Rivet 已有但分散的能力接成闭环：`ModelCapabilityCard` 选人，`Tool.isConcurrencySafe()` 控并发，`SessionContext` fork 隔离上下文，`VerificationMetadata` 汇总验收，`checkpoint v2` 保护写入，Cockpit 显示过程。
- 它利用 DeepSeek V4 prefix cache 的优势：多个 worker 共享稳定 system prompt 和 tool definitions，分歧只发生在 task-specific user message。
- 它把“子代理协同”从大而全 swarm 降维成可验收的本地 runtime feature。

脆弱点与应对：

| 脆弱点 | 失效方式 | 应对 |
|---|---|---|
| Session isolation 不完整 | worker 污染 primary history | Phase 1 必须先做 independent `SessionContext`，禁止共享 mutable messages |
| Worker result 不结构化 | primary 无法可靠汇总 | zod schema + repair retry + blocked fallback |
| 写 worker 破坏工作区 | 并发 edit/write 冲突 | 初版禁止写 worker；Phase 3 才引入 worktree/serial mutation lock |
| TUI 噪音过高 | 用户被 worker 输出淹没 | worker headless，默认只显示 summary/cockpit rail |
| 小任务调度成本过高 | 比单 loop 更慢更贵 | budget gate：低复杂度任务 inline，不 dispatch |
| prefix cache 被破坏 | 多 worker 成本上升 | worker 共享 prompt engine system/tool prefix，禁止每个 worker 拼接不同 system prompt |
| approval 无法归属 | 用户不知道哪个 worker 请求权限 | multiplexed approval queue，卡片显示 worker id/task/target/risk |
| decomposition 错误 | worker 做错任务 | typed work order + primary review + max worker count + user-visible plan |

### 第三轮结构化适应输出

```json
{
  "phase": "adapt",
  "finalCandidate": {
    "id": "V2+V3",
    "name": "Cache-first Bounded Coordinator",
    "concretization": {
      "who": "primary AgentLoop 生成 typed work orders，headless WorkerSession 执行受限任务，用户只审批风险操作和最终应用",
      "where": "Rivet 本地 TypeScript/Ink CLI，在单 repo 工作区中处理复杂调研、审查、验证和后续隔离写入",
      "action": "主控按 budget gate 分解任务，scheduler 选 model/profile/tool allowlist，worker 独立执行并返回 schema-valid packet，primary 汇总和验收",
      "outcome": "用户获得可观察、可验证、可回滚的多 worker 协同，而 primary session 不被污染"
    }
  },
  "integratedTraits": [
    {
      "fromExtinct": "V3",
      "trait": "delegate_task 的低风险 schema 验证",
      "integratedAs": "Phase 1 read-only scout MVP"
    },
    {
      "fromExtinct": "V1",
      "trait": "worktree pool filesystem isolation",
      "integratedAs": "Phase 3 write-capable worker isolation"
    },
    {
      "fromExtinct": "V4",
      "trait": "findings/artifacts/evidence 分栏",
      "integratedAs": "WorkerResult 结构字段"
    }
  ],
  "convergenceInsight": "子代理协同的核心不是更多并发，而是 typed work order/result packet 加主控验收边界",
  "implementationPhases": [
    {
      "phase": 1,
      "action": "实现 work order/result schema、read-only WorkerSession 和 budget gate",
      "successCriteria": "worker session 隔离、只读工具 allowlist、schema-valid result 单测通过",
      "exitCondition": "schema valid rate 低或成本过高时回落 single-loop"
    },
    {
      "phase": 2,
      "action": "实现 WorkOrderQueue、dedupeKey、failure budget 和 Cockpit worker visibility",
      "successCriteria": "worker 状态可见、重复任务 dedupe、失败超限升级",
      "exitCondition": "TUI 噪音过高时收缩到 summary rail"
    },
    {
      "phase": 3,
      "action": "实现 isolated write workers、patch review、verification aggregation",
      "successCriteria": "worker patch 可丢弃/应用/验证且不破坏用户 dirty files",
      "exitCondition": "worktree merge 复杂度高时维持 primary-only writes"
    }
  ]
}
```

---

## 最终方案

### 方案名称

**Cache-first Bounded Coordinator**

### 设计原则

1. **主控权威不可让渡**：worker 只能产出 evidence、finding、patch proposal 或 verification，最终用户可见结论由 primary 生成。
2. **隔离先于并行**：没有 independent session 和 write boundary，就不允许并行执行。
3. **结构化先于智能化**：先让 `WorkOrder` / `WorkerResult` 可靠，再追求自动拆复杂任务。
4. **只读先于写入**：Phase 1 只做 read-only scouts/reviewers/verifiers；write workers 后置。
5. **cache-first**：worker 共享 primary 的 system prompt/tool definitions，避免每个 worker 生成不同 system prompt。
6. **可观测默认打开**：每个 worker 都产生 lifecycle event，进入 Cockpit 而不是刷屏。
7. **小任务不分发**：budget gate 明确拒绝过度编排。

### 核心数据结构

```typescript
export type WorkOrderKind =
  | 'code_search'
  | 'doc_research'
  | 'plan'
  | 'review'
  | 'verify'
  | 'patch_proposal'

export type WorkerProfile =
  | 'code_scout'
  | 'doc_scout'
  | 'planner'
  | 'reviewer'
  | 'verifier'
  | 'patcher'

export interface WorkOrder {
  id: string
  parentTurnId: string
  kind: WorkOrderKind
  profile: WorkerProfile
  objective: string
  scope: {
    files?: string[]
    symbols?: string[]
    commands?: string[]
    externalUrls?: string[]
  }
  constraints: string[]
  allowedTools: string[]
  disallowedTools: string[]
  dedupeKey: string
  dependencies: string[]
  aggregationPolicy: 'all_required' | 'first_success' | 'majority' | 'primary_decides'
  budget: {
    maxTurns: number
    maxTokens: number
    timeoutMs: number
    maxRetries: number
  }
}

export interface WorkerResult {
  workOrderId: string
  status: 'passed' | 'failed' | 'blocked' | 'escalated'
  summary: string
  findings: Array<{
    claim: string
    evidence: string
    confidence: 'low' | 'medium' | 'high'
  }>
  artifacts: Array<{
    kind: 'note' | 'patch' | 'test_command' | 'risk' | 'question'
    title: string
    content: string
  }>
  verification?: VerificationMetadata
  changedFiles: string[]
  risks: string[]
  nextActions: string[]
}
```

### Runtime 组件

```text
Primary AgentLoop
  ├─ Decomposer
  │    user request + code context → WorkOrder[]
  ├─ Coordinator
  │    budget gate + queue + routing + worker lifecycle
  ├─ Scheduler
  │    ModelCapabilityCard + allowedTools + isConcurrencySafe + dedupeKey
  ├─ WorkerSession
  │    independent SessionContext + headless AgentLoop + tool allowlist
  ├─ Aggregator
  │    WorkerResult[] → compressed packet → primary session
  └─ Cockpit Adapter
       events → trace/worker/safety/model panels
```

### Worker 类型

| Profile | 初版工具 | 写权限 | 典型任务 |
|---|---|---|---|
| `code_scout` | read/glob/grep/diff/inspect/repo_map/related_tests | 无 | 查代码 seam、定位影响面 |
| `doc_scout` | web/doc fetch 或无工具模型调用 | 无 | 查外部设计、API 文档 |
| `planner` | read-only + model reasoning | 无 | 生成实施拆分与风险 |
| `reviewer` | read/diff/test metadata | 无 | 独立 code review |
| `verifier` | run_tests/typecheck/build 受控命令 | 无源码写 | 运行验证并返回 metadata |
| `patcher` | edit/write/bash 受限 | 有，但必须隔离 | Phase 3 小 patch proposal |

### 调度规则

1. **Budget gate**
   - 如果任务可在 1-2 次工具调用内完成，不 dispatch。
   - 如果任务涉及 3+ 独立探索面，dispatch read-only scouts。
   - 如果任务涉及写文件，Phase 1/2 仍由 primary 写，workers 只给建议。

2. **Tool allowlist**
   - worker 工具 schema 只暴露 allowed tools。
   - read-only profile 看不到 write/edit/bash mutation。
   - `verifier` 只能运行白名单验证命令。

3. **Dedupe key**
   - `kind:fileOrConcern` 作为默认 key。
   - 同一 key 的 mutating task 同时最多 1 个 in-flight。
   - 重复 read-only task 合并或复用结果。

4. **Failure budget**
   - worker schema parse failed：repair 一次。
   - worker task failed：重试一次或换 stronger model。
   - 同一 work order 在窗口内失败超过预算：`escalated`，primary 接管。

5. **Aggregation policy**
   - `all_required`：所有 worker 结果都必须返回，适合 review+verify。
   - `first_success`：第一个高置信结果即可，适合外部资料查找。
   - `majority`：多个 reviewer 判定风险时使用。
   - `primary_decides`：默认模式，primary 综合冲突结果。

### 与 P2.3 Harness Cockpit 的关系

P2.3 做单 loop cockpit；本设计依赖它作为可观测层，但不要求 P2.3 实现多 agent。P2.4/P3 增加：

- `/cockpit workers`
- worker lifecycle trace
- worker risk / approval queue
- worker model selection reason
- worker verification aggregation
- failure budget escalation event

---

## 风险与应对

| 风险 | 级别 | 应对 |
|---|---|---|
| session isolation 做错导致 primary history 污染 | 高 | Phase 1 第一项测试：worker messages 不进入 primary，只有 compressed packet 进入 |
| worker 输出 JSON 不稳定 | 高 | zod schema、repair prompt、blocked fallback、schema-valid-rate 指标 |
| 并发写冲突 | 高 | Phase 1/2 禁止 write worker；Phase 3 worktree 或 serial mutation lock |
| 成本膨胀 | 中 | budget gate、maxWorkers 默认 2、共享 prompt prefix、显式用户 opt-in |
| TUI 噪音 | 中 | headless worker，默认 summary rail，详细面板按需打开 |
| 模型能力卡评分不准 | 中 | 初版使用保守默认；routing reason 可见；用户可覆盖 |
| approval 归属不清 | 中 | approval card 展示 worker id、profile、work order、tool、target、risk |
| 外部参考项目复杂度诱惑 | 中 | 明确非目标：无 federation、无 full swarm、无 distributed memory、无 agent 自组织写入 |
| verification false confidence | 高 | worker result 不等于 verified；只有 `VerificationMetadata.scope='full' && status='passed'` 才可声明 full verified |

---

## 下一步

第一步不是写完整 coordinator，而是创建 **P2.4 Subagent Coordination Contract** 的实施计划，首个可执行任务为：

1. 定义 `WorkOrder` / `WorkerResult` schema 和测试。
2. 实现 independent `WorkerSession`，证明 worker message 不污染 primary `SessionContext`。
3. 实现 read-only tool allowlist，证明 worker 无法调用 write/edit/bash mutation。
4. 实现一个 headless `code_scout` worker，返回 schema-valid findings。
5. 在 primary session 注入 compressed worker packet，并由 evidence/cockpit 记录。

建议文档路径：

`docs/superpowers/plans/2026-05-16-rivet-subagent-orchestration-implementation.md`

---

## 规格自检

- 占位符扫描：本文没有保留未填章节，也没有使用 TODO 占位。
- 内部一致性：三轮均收敛到 bounded local coordinator；非目标、风险和实施路径一致。
- 范围检查：Phase 1 可由一个实施计划覆盖；write workers 和 adaptive learning 已后置。
- 模糊性检查：worker、primary、WorkOrder、WorkerResult、budget gate、aggregation policy 都有明确含义。

设计文档已保存后，请审查。如果在继续之前你想调整方向，我建议优先讨论这三个决策：

1. Phase 1 是否只允许 read-only workers。
2. 初版 worker 是否必须复用完整 system prompt/tool definitions 来保护 prefix cache。
3. 写入型 worker 是优先用 worktree isolation，还是先长期保持 primary-only writes。
