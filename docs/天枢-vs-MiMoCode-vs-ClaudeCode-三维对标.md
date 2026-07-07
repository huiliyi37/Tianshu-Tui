# 天枢 vs MiMo-Code vs Claude Code — 三维对标分析

> 面向：DeepSeek 模型团队
> 日期：2026-06-12
> 方法：代码级取证 + GitHub 公开数据 + 天枢内部设计文档交叉验证

---

## 一、项目概览

| 维度 | 天枢 | MiMo-Code | Claude Code |
|------|------|-----------|-------------|
| **定位** | 终端编码 Agent（自建） | 终端编码 Agent（OpenCode fork） | 终端编码 Agent（自建） |
| **首发时间** | 2026-05-15 | 2026-06（近期） | 2024 年底 |
| **代码规模** | 52K 行 TS（源码）+ 56K 行测试 | ~195K 行 TS（opencode 包） | 未公开 |
| **测试规模** | 442 测试文件 | 未公开 | 未公开 |
| **Git 提交** | 2,164（29 天，日均 77） | 未公开 | 未公开 |
| **开源协议** | Apache 2.0（计划中） | MIT | 闭源 |
| **技术栈** | Node.js + Ink 6 (React TUI) | Bun + Effect-TS + OpenTUI | Node.js（推测） |
| **主模型** | DeepSeek V4 | MiMo / 兼容多 provider | Claude |
| **缓存策略** | DeepSeek V4 prefix cache 99.6% | 未明确 | Anthropic cache |
| **竞品关系** | 独立自建，非任何 fork | OpenCode fork，注入了持久化记忆 | 闭源领先者 |

---

## 二、天枢 vs MiMo-Code：成熟度逐项对比

### 2.1 Agent 内核

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| Agent Loop | ✅ 多控制器管线（Stream→Perception→Intent→Tool→Compaction→Completion） | `agent/` 目录 40 文件，基于 OpenCode 架构 | 天枢更复杂 |
| 收敛检测 | ✅ Tool Fingerprint + Oscillation Penalty + Doom Loop Recovery | 无明确的 doom loop 防护描述 | 天枢领先 |
| 自感知 | ✅ Sensorium 6维向量（momentum/pressure/confidence/complexity/freshness/stability），<1ms，零 LLM 开销 | 无独立 sensorium 层 | **天枢独有** |
| 认知运行时 | ✅ CVM trap-and-emulate（19 hooks × 5 phases） | OpenCode 基础 hook 系统 | **天枢独有** |
| 退化恢复 | ✅ Dissipative Kick + Vigor Engine + Cognitive Mirror | context reconstruction（仅窗口管理） | 天枢领先 |
| 多模型协作 | ✅ Coordinator + WorkOrderQueue + 文件归属权 | 子 agent 系统（有并行能力） | 天枢在并发协调上更深 |

### 2.2 工具系统

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| 工具数量 | 42 个（definition/execute 分离） | 37 文件在 `tool/` 目录 | 基本持平 |
| 沙箱执行 | ❌ 无 OS 级 sandbox（P0 待做） | 待确认 | 天枢落后 |
| 文件编辑 | edit_file + write_file + hash_edit + apply_patch（4 种方式 + 纵深防御） | 基于 OpenCode 基础工具 | 天枢更丰富 |
| LSP 集成 | ✅ lsp_find_references / lsp_goto_definition | ✅ lsp/ 目录 7 文件 | 基本持平 |
| Git 工具 | ✅ git status/diff/commit/log/stash | ✅ 基础 git 工具 | 基本持平 |
| 子代理 | ✅ delegate_task / delegate_batch（5 profile，batch 并行 2-5） | ✅ 子 agent 系统（有 background execution） | 基本持平 |
| 交付门禁 | ✅ deliver_task（ownership 追踪 + 内聚性检查 + 归因） | 无独立门禁 | **天枢独有** |
| 记忆工具 | ✅ remember / recall（持久化认知记忆） | 无独立工具 | **天枢独有** |

### 2.3 上下文与记忆

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| 短期记忆 | claims + project-memory（context memory 跨 session 持久化） | SQLite FTS5 全文搜索 + MEMORY.md | MiMo 更结构化 |
| 会话 checkpoint | ✅ SessionPersist（JSONL + 校验和 + 原子写入） | ✅ checkpoint.md（自动维护） | 基本持平 |
| 跨会话记忆 | ✅ Stigmergy 信息素（文件级，自动衰减） | ✅ project memory + checkpoint 重建 | MiMo 更系统化 |
| 记忆自进化 | ❌ 无自动蒸馏 | ✅ /dream（提取知识）+ /distill（发现模式→技能） | MiMo 领先 |
| 前缀缓存优化 | ✅ 99.6% 命中率（8 个 cache killer 猎杀 + Ice Mirror 三区域） | 未明确提及 | **天枢独有** |

### 2.4 安全与权限

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| OS 级 Sandbox | ❌ 无 | 待确认 | 天枢落后 |
| 权限分级 | 3 级审批 + risk assessment（doom loop/路径穿越/破坏性命令/管道注入） | 有 permission/ 目录 4 文件 | 待确认细节 |
| 自适应审批 | ✅ sensorium.confidence 驱动审批决策 | 未提及 | **天枢独有** |
| 写安全纵深 | ✅ OOM guard + stale mtime detection + anchor hash verification + command allowlist | 待确认 | 天枢领先 |

### 2.5 审查与质量

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| 自动审查 | ✅ L1/L2/L3 三级 + 姿态轴（马超/天权/天府/瑶光） | ✅ compose mode 含 code review 技能 | 天枢更系统化 |
| 交付前验证 | ✅ evidence tracking + 归因（己方/外部） | 未提及 | **天枢独有** |
| 测试框架 | node:test + assert/strict，442 测试文件 | bun test | 基本持平 |
| Compose 模式 | ❌ 无等价物 | ✅ specs-driven + skills 编排 | MiMo 领先 |

### 2.6 用户体验

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| TUI | Ink 6 + React，自建 | OpenTUI（OpenCode fork） | 基本持平 |
| 流式渲染 | ✅ thinking block + tool cards + pager | ✅ 基于 OpenCode | 基本持平 |
| 渐进式披露 | fluency-policy（正常/安静/检查/压力四种） | 有首次引导 | 基本持平 |
| 语音输入 | ❌ | ✅ /voice（TenVAD + MiMo ASR） | MiMo 领先 |
| 多 Agent 切换 | ❌ 隐式（星域切换） | ✅ Tab 切换 build/plan/compose | MiMo 更直观 |
| Goal 判断 | ❌ 无独立 judge | ✅ /goal + 独立 judge 模型 | MiMo 领先 |

### 2.7 生态与部署

| 维度 | 天枢 | MiMo-Code | 判据 |
|------|------|-----------|------|
| 一键安装 | ❌ | ✅ `curl \| bash` | MiMo 领先 |
| 零配置启动 | ❌ 需要 API key | ✅ MiMo Auto 免费通道 | MiMo 领先 |
| MCP 支持 | ❌ | ✅ MCP server 连接 | MiMo 领先 |
| Plugin 系统 | ❌ | ✅ plugin/ 目录 14 文件 | MiMo 领先 |
| Claude Code 导入 | N/A | ✅ 一键迁移认证 | MiMo 便利 |
| IDE 支持 | 终端 only | 终端 + VS Code 扩展 | MiMo 更广 |
| 社区 | 无 | 微信群 + GitHub | MiMo 领先 |

---

## 三、天枢的不可替代优势

以下能力 MiMo-Code 和 Claude Code **都没有等价物**：

### 3.1 CVM 认知虚拟机（天枢独有）

```
天枢：19 hooks × 5 cognitive phases → trap-and-emulate 模型训练缺陷
MiMo-Code：无独立认知运行时层，依赖 OpenCode 基础 hook 系统
Claude Code：19 个 hook 事件但仅供用户可配，无 trap-and-emulate 概念
```

CVM 的核心价值：**在运行时修正 RLHF 训练出的服从性、锚定、注意力衰减——不需要改模型权重。**

### 3.2 Sensorium 自感知（天枢独有）

```
天枢：6维连续向量每 turn 计算，驱动策略选择、审批决策、退化恢复
MiMo-Code：无独立 sensorium
Claude Code：无独立 sensorium
```

### 3.3 Prefix Cache 极致优化（天枢独有）

```
天枢：DeepSeek V4 99.6% 命中率，成本降低 ~97%，单请求 ~¥0.03
MiMo-Code：依赖 Bun + Effect-TS 架构，未明确 cache 优化深度
Claude Code：依赖 Anthropic cache，但工程细节不对称
```

### 3.4 Stigmergy 信息素记忆（天枢独有）

```
天枢：文件级信息素自动衰减，跨会话越用越熟
MiMo-Code：SQLite 全文搜索 + MEMORY.md，更像静态知识库
Claude Code：有限 project memory
```

MiMo-Code 的记忆系统实际上比天枢更"产品化"（有 /dream 蒸馏 + /distill 技能提取），但天枢的 Stigmergy 是**自动的、零人工维护的、基于行为而非声明的**。

### 3.5 多模型并发协调（天枢独有）

```
天枢：154 commits / 37h / 213 文件 / 零冲突零回退
      同秒提交铁证（3 session 同时完成）
MiMo-Code：子 agent 并行但无文件归属权 + 语义锁机制
Claude Code：sub-agent + 远程隔离但无多 session 并发协调
```

### 3.6 CVM 训练实验（天枢独有）

```
天枢：已验证 CVM 可通过 SFT 融入模型权重
      nanoGPT (85M) → Qwen 0.5B (100% 格式准确率) → Qwen 7B
      6 分钟 LoRA 微调，成本 <¥1
MiMo-Code：无训练侧验证
Claude Code：无公开训练数据
```

---

## 四、MiMo-Code 的独有优势

以下能力天枢和 Claude Code **都没有等价物**：

| 能力 | 说明 | 天枢差距 |
|------|------|---------|
| /dream 自动蒸馏 | 扫描会话痕迹，提取知识到 project memory | 无等价物 |
| /distill 技能提取 | 发现重复工作流，打包为可复用技能 | 无等价物 |
| /goal + judge 模型 | 独立模型判断任务是否真正完成 | 无等价物 |
| Compose Mode | specs-driven 全生命周期编排（plan→execute→review→TDD→debug→verify→merge） | 无等价物 |
| 语音输入 | 实时流式 ASR | 无等价物 |
| 零配置启动 | MiMo Auto 免费通道，无需 API key | 需要 API key |
| 一键安装 | `curl \| bash` | 需 clone + npm install |
| MCP 生态 | 连接外部工具生态 | 不支持 |
| Plugin 系统 | 14 文件的插件架构 | 不支持 |
| Claude Code 迁移 | 一键导入认证 | N/A |

---

## 五、成熟度总评

| 维度 | 天枢 | MiMo-Code | Claude Code | 领先者 |
|------|------|-----------|-------------|--------|
| Agent 内核深度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | **天枢** |
| 认知运行时 | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ | **天枢** |
| 跨会话记忆 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | 天枢/MiMo 持平 |
| 记忆自进化 | ⭐ | ⭐⭐⭐⭐⭐ | ⭐ | **MiMo** |
| 多模型并发 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | **天枢** |
| 审查/质量体系 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | **天枢** |
| 交付门禁 | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ | **天枢** |
| 安全/Sandbox | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Claude Code |
| 产品化程度 | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **MiMo** |
| 开箱体验 | ⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **MiMo** |
| 生态/Plugin | ⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **MiMo** |
| 社区/用户量 | ⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Claude Code |
| Prefix Cache | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | **天枢** |
| 训练侧验证 | ⭐⭐⭐⭐⭐ | ⭐ | ⭐ | **天枢** |

---

## 六、关键发现

### 6.1 天枢 vs MiMo-Code：本质差异

```
天枢 = 深度优先：Agent 内核做到极致，CVM 是理论壁垒
MiMo-Code = 广度优先：产品体验做到极致，生态/便利性是壁垒
```

天枢在 **Agent 内核深度**（CVM、Sensorium、Stigmergy、并发协调、交付门禁、缓存优化、CVM 训练）上全面领先。

MiMo-Code 在 **产品化程度**（一键安装、零配置、/dream 蒸馏、Compose Mode、语音、MCP、Plugin）上全面领先。

### 6.2 天枢对 DeepSeek 的战略价值

1. **CVM 是 DeepSeek 模型的天然壁垒**：DeepSeek V4 的 prefix cache 是天枢 99.6% 命中率的基础——这个数字 MiMo 和 Claude 都无法复制，因为它们的 cache 机制不同。

2. **"模型 + CVM = Agent with its own mind"**：这是 DeepSeek 独有的叙事——不是"更好的编码工具"，而是"让模型有独立思想的运行时"。MiMo-Code 没有这个叙事，Claude Code 也没有。

3. **训练侧验证已完成**：CVM 可以通过 SFT 融入权重，6 分钟 LoRA 即可。这意味着 CVM 不只是一个开源 harness——它可以成为 DeepSeek 未来模型的出厂配置。

4. **并发协调是工业化基础**：154 commits 零冲突证明了天枢的多 session 架构可以支撑团队级使用——这是从"个人工具"到"团队基础设施"的关键能力。

### 6.3 天枢需要从 MiMo-Code 学习的

| 能力 | 紧迫度 | 工作量估计 |
|------|--------|-----------|
| 一键安装 + 零配置启动 | P0 | 1 周 |
| MCP 支持 | P0 | 2 周 |
| Plugin 系统 | P1 | 3 周 |
| /goal + judge 模型 | P1 | 1 周 |
| 记忆自蒸馏（/dream） | P1 | 2 周 |
| Compose Mode 等价物 | P2 | 3 周 |
| OS 级 Sandbox | P0 | 2 周 |

---

## 七、一句话总结

> **天枢在 Agent 内核和认知运行时上建立了 MiMo-Code 和 Claude Code 都无法短期复制的理论壁垒（CVM + Sensorium + Stigmergy + 并发协调 + CVM 训练），但在产品化程度和开箱体验上落后 MiMo-Code 约 1 个身位。两者的互补性远大于替代性——天枢的"深"加上 MiMo 的"广"，才是完整的产品形态。**

---

*本文档基于：天枢 git 历史（2,164 commits）、MiMo-Code GitHub 仓库（915 TS 文件，~195K 行）、Claude Code 公开资料、天枢内部设计文档交叉验证。*
