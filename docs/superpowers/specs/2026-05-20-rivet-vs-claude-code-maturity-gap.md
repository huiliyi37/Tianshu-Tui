# 天枢 vs Claude Code 关键技术成熟度差距分析

> 日期：2026-05-20
> 方法：Deep Brainstorm (4 scout + 3 轮演化)
> 调研范围：Claude Code 代码库 (`claude-code-haha`) + Rivet 代码库 + 行业 UX 模式
> 核心洞察：差距不是"全面落后"，而是**结构性错位**——Rivet 在 agent 内核领先，在用户侧控制面落后。补法不是照搬 Claude Code，而是走"自调节即安全"路径。

---

## 差距总表

| 维度 | Claude Code | Rivet 当前 | 差距 | 优先级 |
|------|------------|-----------|------|--------|
| Sandbox | OS 级 (Seatbelt/seccomp) | ❌ 无 | **大** | P0 |
| 权限模式 | 7 种 + 投机分类器 | 3 种审批 + risk assessment | **中** | P1 |
| 会话管理 | 三层压缩 + compact boundary | 5 级压力 + smart compact + snapshot | **小** (Rivet 部分领先) | P2 |
| 渐进式披露 | Trust dialog → Plan → auto | 极简 onboarding + fluency-policy | **中** | P1 |
| Hook 系统 | 19 事件 + 用户可配 | 9+ runtime hooks, 5 phases (内部) | **中** | P2 |
| 上下文获取 | LSP (go-to-definition, find-references) | grep + repo_map 文本匹配 | **中** | P2 |
| Agent 内核 | 简单 queryLoop | sensorium 3D + vigor + prediction error + doom loop | **Rivet 领先** | — |
| 多 agent | sub-agent + 远程隔离 | DelegationCoordinator + WorkOrderQueue + worktree 隔离 | **小** (无远程隔离 + 无用户可见任务面板) | P3 |

---

## 调研发现

### Claude Code 架构 (Scout 1)

**权限系统 (~800 行)**
- 7 种模式：`default` / `acceptEdits` / `bypassPermissions` / `dontAsk` / `plan` / `auto` / `bubble`
- 5 级规则优先级：policy → user → project → local → session
- 投机式分类器：等待用户响应时异步运行分类器，决定是否需要人工审批
- 权限冒泡：子 Agent 可将决策向上传递

**上下文管理 (~1800 行)**
- 三层压缩：micro（tool result 预算裁剪）→ snip（历史片段摘除）→ full（LLM 全量摘要）
- 关键阈值：`AUTOCOMPACT_BUFFER_TOKENS=13K`，`POST_COMPACT_TOKEN_BUDGET=50K`
- Compact boundary：压缩后插入边界标记，后续只读边界后内容
- State 机器带熔断器：`maxOutputTokensRecoveryCount` 连续失败 3 次触发熔断

**渐进式交互 (~300 行)**
- Trust Dialog 首次运行确认
- Plan Mode 默认启用（只读）
- Auto Mode 逐步解锁（opt-in）
- 权限拒绝时触发教育 hook

**Agent Loop (~2000 行)**
- `queryLoop()` 主循环：stream → collect → run tools → auto compact → check terminal
- 并行工具执行
- 多重错误恢复：max output tokens (3次) + prompt too long (reactive compact)
- Stop hooks：终止前清理和摘要

**Hook 系统 (~500 行)**
- 19 种事件（session/tool/permission/compact/subagent/task/config/file/instructions）
- 沙箱隔离：每个 hook 在独立子进程运行
- 用户可配：settings.json `hooks` 字段，支持 JSON 输出和流式响应
- 5 级配置来源（含远程管理策略）

### Rivet 当前状态 (Scout 2)

**审批系统 (✅ 已实现，sandbox ❌)**
- 3 级 `ApprovalMode`：`auto-accept` / `auto-safe` / `manual`
- `assessToolRisk()` 4 级风险评估：doom loop、路径穿越、破坏性命令、管道注入
- `PermissionConfig` 支持 allowlist 规则
- 用户可在审批时编辑工具参数
- Cerebellar gate：prediction error 升高时强制 read-before-edit
- **无进程隔离**——bash 直接执行宿主机命令

**会话管理 (✅ 较完整)**
- `SessionPersist`：JSONL + 校验和 + 原子写入 + 损坏检测
- `loadRecoverableMessages()`：检测 incomplete compact，自动回滚到 snapshot
- `runResumePreflight()`：自动插入 synthetic tool_result 修复 orphan tool_use
- 三层压缩：policy（5 级压力分级）+ PressureMonitor（thrashing 检测）+ smartCompact（LLM 摘要）
- 跨会话 durable claims（confidence 衰减 0.9）
- 50 session LRU 驱逐

**渐进式交互 (⚠️ 部分实现)**
- 极简 onboarding（sentinel file + dismiss）
- `fluency-policy`：根据压力/静默/输出率动态切换 normal/quiet/inspect/stress 四种可见性
- `onIntentPreview`：tool 执行前意图预览
- **无新手/专家模式分层**，所有功能一次性暴露

**Agent Loop (✅ 架构复杂)**
- 多控制器管线：Stream → Perception → Intent → Tool → Compaction → Completion
- 12 种错误类型 + confidence + retryable 标记
- RepairPipeline（fourHorsemen + semantic + ctclSanitizer）
- Prediction error 小脑环：连续失败升高 intervention level → gate/escalate
- Doom loop 防护：TraceStore + getDoomLoopLevel()

**Hook 系统 (✅ 双层架构)**
- Runtime hooks：5 phases × 9+ named hooks（signal-consumer, perception, vigor, theta, kick, stigmergy, playbook-reflect, dream, telemetry-flush + dispatcher-hook 等新增），effects 接口丰富
- Hook registry：PreToolUse/PostToolUse/Notification/SubagentStop/UserPromptSubmit/PreCompact，PreToolUse 可修改/阻止工具调用
- **内部编排为主**，无用户可配的 hook API

**多 Agent (✅ 已实现并发调度)**
- DelegationCoordinator + WorkOrderQueue（优先级、依赖排序、并发上限）
- HandsSession（worktree 隔离写入 worker）+ WorkerSession（多轮执行 + repair 重试）
- 完整 worker 生命周期管理
- **缺失**：无远程隔离、无用户可见任务面板

### 行业 UX 模式 (Scout 3)

- OS 级 sandbox 是行业共识：Codex 用 Seatbelt/Landlock，三种模式
- 权限疲劳是核心 UX 陷阱：频繁询问 → 用户无脑确认
- 渐进授权有效：750 次会话后 >40% 实现全自动（Anthropic 数据）
- 子 agent 权限继承有放大效应：推荐 deny-all baseline + 逐 agent allowlist

### 反证发现 (Scout 4)

| 隐含前提 | 分类 | 如果不成立 |
|----------|------|-----------|
| 控制面与 agent 内核可独立演进 | 假设 | fluency-policy ↔ sensorium 深度耦合，拆分需重构管线 |
| Claude Code 的控制面对 Rivet 有参考价值 | 假设 | Claude Code 面向单一模型生态（Anthropic），Rivet 面向开放模型生态。分界线是模型生态而非用户群体 |
| DeepSeek 和 Claude 缓存约束相同 | **事实（反向）** | **hook 注入会破坏 prefix cache**，不能照搬 |
| Rivet 用户需要渐进式信任 | 假设 | 如果用户要全自动，控制面是过度工程 |
| Rivet agent 内核确实领先 | 假设 | Claude Code 有 SandboxManager + 远程隔离，安全层不弱 |
| ROI 基准是用户增长 | 假设 | 如果目标是能力导向，打磨内核 ROI 可能更高 |
| 开源项目控制面需要从零构建 | 假设 | 开源用户可自行扩展，核心团队应做不可替代的 |

---

## 三轮演化过程

### 第一轮：变异（4 方案）

| 方案 | 生态位 | 一句话 |
|------|--------|--------|
| V1 对标补齐 | 主流 | 逐项复制 Claude Code 的 7 种权限 + 5 级配置 + sandbox |
| V2 cache-native 安全 | 邻近 | 设计不碰 prefix cache 的安全层：进程隔离 + sensorium 驱动审批 |
| V3 自调节即控制面 | 空位 | 不做用户配置，把 sensorium 做到极致让 agent 自己判断 |
| V4 开放 harness 协议 | 突变 | 把 sensorium/hook 抽象成协议标准，让社区提供控制面 |

### 第二轮：选择

| 方案 | 因果 | 成本 | 共演化 | 落地性 | 判定 |
|------|------|------|--------|--------|------|
| V1 | **断裂**（hook 注入破坏 prefix cache） | 高（4-6 周） | 静态 | 可执行但代价大 | **灭绝** |
| V2 | 通过（全链路不碰 prefix cache） | 中（4 周） | 动态 | ✅ 第一步=bubblewrap wrapper | **存活（强）** |
| V3 | 通过但有弱点（依赖 LLM 自我意识） | 低（1 周） | 动态 | ✅ 第一步=confidence 阈值 | **存活（中）** |
| V4 | **断裂**（无消费者） | 极高 | — | ❌ | **灭绝** |

**回收特征：**
- V1 → settings.json 3 级配置（user/project/session），吸收到 V2
- V4 → 内部 hook 接口标准化，吸收到 V2

### 第三轮：适应

**收敛洞察：** V2 和 V3 收敛到同一点——**"自调节即安全"**。不是让用户配置权限，而是让 agent 自己判断什么时候需要用户确认。

**扩展适应：**
- sensorium.confidence → 审批阈值（confidence>0.8 + risk=low → auto-approve）
- fluency-policy inspect 模式 → 权限决策可观测性
- tool-pipeline assessToolRisk() → 分级 sandbox（high-risk 走隔离，low-risk 直接执行）

---

## 最终方案：prefix-cache-native 自调节安全模型

### 核心思路

不照搬 Claude Code 的控制面（prefix cache 不兼容），走 Rivet 独有的路径：
1. **Sandbox**：轻量进程隔离，仅 high-risk 命令走隔离
2. **权限**：sensorium confidence + risk assessment 驱动自适应审批（⚙️ GLM 执行中）
3. **可观测**：fluency inspect 模式展示决策理由
4. **配置**：3 级配置（user/project/session），暴露用户 hook API

### 实施路径

**Phase 1（2 周）：Sandbox + 自适应审批**
- bash tool 加轻量隔离：Linux 用 bubblewrap，macOS 用 sandbox-exec（已 deprecated，接受风险）或 Docker fallback
- 审批策略改为 **deny-all for bash write + whitelist auto-approve**，而非黑名单 always-ask（黑名单永远不完整：curl -X DELETE、psql TRUNCATE、docker rm -f 等无法穷举）
- approval-risk.ts 接入 sensorium.confidence 作为自动审批阈值（仅对白名单内的安全操作生效）
- 成功标准：`rm -rf /` 被进程隔离拦截；白名单内 confidence>0.8+risk=low 自动批准
- 退出条件：进程隔离兼容性问题多于 3 个终端环境

**Phase 2（2 周）：可观测性 + 用户配置层**
- fluency inspect 模式展示审批决策理由（"confidence=0.85, risk=low → auto-approved"）
- config/schema.ts 扩展 3 级配置（user/project/session）
- 暴露 PreToolUse/PostToolUse 用户 hook API
- 成功标准：用户能在配置中添加自定义 hook；inspect 模式显示决策理由
- 退出条件：配置系统与 prefix cache 产生冲突

**Phase 3（2 周）：渐进式披露 + 会话增强 + 上下文获取**
- 新手引导流程（首次运行检测 + 推荐审批等级 + 功能分层暴露）
- 分层记忆（短期 claims + 长期 patterns + episodic events）
- LSP 集成调研 + 原型（go-to-definition 替代 grep 盲搜，提升 tool call 信噪比）
- 成功标准：新用户首次运行有引导；claim 跨 session 衰减正确；LSP 原型能为至少 1 种语言提供 symbol 级跳转
- 退出条件：LSP server 启动延迟 >5s 影响交互体验

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| macOS sandbox-exec 已 deprecated (Catalina+) | **高** | **高** | macOS 优先用 Docker；sandbox-exec 作为 degraded fallback（接受行为不稳定）；长期跟踪 Apple 替代 API |
| bubblewrap 仅 Linux 可用 | 高 | 中 | Linux 用 bubblewrap，macOS 用 Docker/sandbox-exec fallback |
| sensorium confidence 误判导致自动批准危险操作 | 中 | 高 | **deny-all for bash write + whitelist auto-approve**（黑名单永远不完整：curl -X DELETE、psql TRUNCATE、docker rm -f 等无法穷举） |
| 用户 hook API 的 prefix cache 兼容性 | 中 | 高 | hook 输出只影响 tool dispatch 层，不注入 prompt/消息序列 |
| 配置层增加复杂度 | 低 | 中 | 默认零配置可用，配置是 opt-in |

---

## Rivet 独有优势（不应补齐而应放大）

### 不可替代壁垒（核心护城河）

| 能力 | 内容 | 放大方向 |
|------|------|---------|
| Sensorium 3D 自感知 | momentum/confidence/pressure 实时感知 agent 状态 | 驱动自适应审批 + 可观测仪表 |
| RuntimeHookPipeline 生命周期调节 | 5 phase × 9+ hooks，vigor/theta/kick/stigmergy 协同 | 唯一内置 self-regulation 闭环的 terminal agent |
| Prefix cache 原生优化 | anchor 保护 + volatile 非阻塞 + 稳定 prefix 不变性 | 开放模型上 token 效率的结构性优势 |
| 多模型认知协作 | Ice Mirror cache engine + 多 provider adapter | 开放模型生态独有——Claude Code 绑定单一模型 |

### 有优势但非壁垒

| 能力 | 领先幅度 | 说明 |
|------|---------|------|
| Repair pipeline | 中 | fourHorsemen + semantic + ctcl，可被其他 agent 模仿 |
| Doom loop 防护 | 中 | TraceStore + getDoomLoopLevel()，竞品可快速实现 |
| Session 恢复 | 小 | 校验和 + snapshot + orphan 修复，Claude Code 也有基础实现 |
| Fluency policy | 小 | 自适应 UI 密度，好的 UX 但不构成技术壁垒 |

---

## 遗漏维度补充：上下文获取效率（LSP）

| 维度 | Claude Code | Rivet |
|------|------------|-------|
| 符号级导航 | LSP go-to-definition, find-references | ❌ 无 |
| 上下文获取 | symbol-level 精确跳转 | grep + repo_map 文本匹配 |
| 信噪比影响 | 高精度上下文 → 更少 token 浪费 | 模糊匹配 → 可能引入无关代码 |

LSP 直接影响每次 tool call 的信噪比，进而影响 token 效率和任务准确率。建议列为 P2，与 Hook 系统用户化同优先级。
