# 竞品差距分析待办清单

> 日期：2026-06-08
> 来源：天枢代码库全面审计 + 三份历史差距文档交叉比对
> 基线文档：
> - `docs/superpowers/specs/2026-05-26-claude-code-feature-gap-analysis.md` — CC 功能差异补强分析
> - `docs/research/2026-06-06-claude-code-workflow-comparison.md` — CC 工作流调研（任务拆解/审查/意图/引擎）
> - `docs/superpowers/specs/2026-05-20-rivet-vs-claude-code-maturity-gap.md` — 成熟度差距分析
> - `docs/superpowers/specs/2026-05-20-rivet-vs-opensource-agents-gap.md` — 开源竞品差距

---

## 一、已落地能力（gap 已关闭）

| 能力 | 对标竞品 | 落地提交/模块 | 状态 |
|------|---------|-------------|------|
| LSP 集成 (go-to-definition, find-references) | Claude Code | `src/lsp/` (2026-05-27) | ✅ 完成 |
| MCP 客户端 (stdio + SSE) | Claude Code | `src/mcp/` (2026-05-16 + 05-27) | ✅ 完成 |
| Plan Mode + plan_submit + plan-store | Claude Code | `src/agent/plan-store.ts`, `src/tools/plan_submit` | ✅ 完成 |
| Slash command 系统 | Claude Code | `src/tui/slash-commands.ts` | ✅ 完成 |
| 破坏性命令模式 | Claude Code `destructiveCommandWarning` | `src/tools/bash.ts` DANGEROUS_BASH_PATTERNS | ✅ 完成 |
| Agent 定义外部化 | Claude Code | `src/agent/profile-registry.ts` + `.rivet/agents/*.md` | ✅ 完成 |
| Team 多 wave 编排 | Claude Code AgentTool | `src/agent/team-orchestrator.ts`, `src/tools/team-orchestrate.ts` | ✅ 完成 |
| 对抗式独立 verifier | Claude Code verificationAgent | `src/agent/review-router.ts` + `profile-registry.ts:adversarial_verifier` | ✅ 完成 |
| Review Squadron (4 inspector) | Claude Code 多角色审查 | `review-coordinator-deps.ts` INSPECTORS | ✅ 完成 |
| Verification nudge | Claude Code TodoWrite nudge | `src/agent/aggregation.ts` detectVerificationGap | ✅ 完成 |
| Evidence fail-closed gate | CC verification avoidance | `src/agent/worker-evidence.ts` transcript-backed gating | ✅ 完成 |
| Auto review gate on final wave | CC reviewer 角色 | `team-orchestrate.ts` isLastWave + routeReviewWorkflow | ✅ 完成 |
| Objective review stance 内化 | CC 外部审查经验 | `src/agent/review-discipline.ts` OBJECTIVE_REVIEW_STANCE | ✅ 完成 |
| Cron 租约锁 (PID-based) | CC cronTasksLock | server 层已实现 (cron lock 相关 commits) | ✅ 完成 |
| Session 元数据 + Rollout | CC session tracking | `feat(session): add structured metadata` (2026-06) | ✅ 完成 |
| Domain knowledge store | — | `src/agent/hooks/domain-knowledge-*.ts` (P0-C) | ✅ 完成 |
| Web search 工具 | — | `src/tools/web-search*.ts` | ✅ 完成 |

---

## 二、记忆系统现状 vs 竞品

### 天枢记忆架构（已实现）

| 层级 | 模块 | 存储 | 生命周期 | 检索方式 |
|------|------|------|---------|---------|
| **Session claims** | `claim-store.ts` + `claims.ts` | `.rivet/sessions/{id}.claims.jsonl` + snapshot | 会话级 | recall 工具 substring match |
| **Project memory** | `project-memory-writer.ts` / `-loader.ts` | `.rivet/knowledge/memory.jsonl` | 跨会话持久 | Tier1 自动注入 prompt / Tier2 recall 工具 |
| **Dream 蒸馏** | `dream.ts` + `dream-hook.ts` | `.rivet/knowledge/project-memory.md` | 跨会话 | Markdown 入口，手动触发 |
| **Playbook** | `playbook.ts` + `playbook-store.ts` + `playbook-reflect-hook.ts` | 内存 + JSONL | 跨会话 | keyword overlap match + volatile 注入 |
| **Session memory extract** | `session-memory-extract.ts` | 临时 | 单会话 | 提取不持久化 |
| **Seed capsule** | `recall-capsule.ts` | `.rivet/knowledge/capsules/` | 永久 | 按星域名按需加载 |
| **Knowledge files** | `recall.ts` searchKnowledgeFiles | `.rivet/knowledge/*.md` | 永久 | keyword substring |

### Claude Code 记忆架构

| 层级 | 模块 | 存储 | 生命周期 | 检索方式 |
|------|------|------|---------|---------|
| **CLAUDE.md** | `memdir.ts` | `MEMORY.md` 入口 (25KB cap) | 永久 | 始终注入 system context |
| **分类记忆** | `memoryTypes.ts` | user/feedback/project/reference 四类 | 跨会话 | Sonnet 侧查询选择 (≤5 个) |
| **自动提取** | `extractMemories/` | 后台 agent 自动从对话提取 | 自动 | LLM 驱动 |
| **Session Memory** | `SessionMemory/` | 会话结束时提取 | 自动跨会话 | 与 compact 集成 |
| **Agentic Session Search** | `agenticSessionSearch.ts` | 跨会话语义搜索 | 永久 | 唯一 LLM 分析处 |

### 差距判断

| 维度 | CC | 天枢 | 差距 |
|------|---|------|------|
| 自动提取 | 后台 agent 自动从对话提取记忆 | `session-memory-extract.ts` 只提取不持久化；`dream.ts` 需手动触发 | **天枢缺自动持久化闭环** |
| 检索精度 | LLM 侧查询 (Sonnet) 选 top-5 | keyword substring match | **天枢缺语义检索** |
| 记忆分类 | 4 种类型各有 when_to_save/how_to_use/body_structure | 9 种 ContextClaimKind 但无使用指南 | **天枢有分类但缺消费指导** |
| 写入门槛 | 用户手动 + 自动提取双通道 | Dream 门槛高（需匹配 curated criteria）；`remember` 工具主动写入 | **天枢偏保守，可能遗漏信号** |
| 跨会话搜索 | `agenticSessionSearch` 语义搜索 | 无 | **天枢缺** |

---

## 三、待办：按优先级

### P0 — 核心缺失（影响基本可用性）

| # | 能力 | 竞品参考 | 预估工作量 | 现有基础设施 |
|---|------|---------|-----------|------------|
| **M1** | Session memory 自动持久化闭环 | CC SessionMemory + extractMemories | 3 天 | `session-memory-extract.ts` 已有提取逻辑，缺持久化到 `memory.jsonl` 的 hook |
| **M2** | Durable claims auto-surface | OpenClaw USER.md 自动注入 | 2 天 | `project-memory-loader.ts` Tier1 注入已有，缺 durable claims → Tier1 的桥梁 |
| **M3** | Dream 自动触发 | CC autoDream | 1 天 | `dream-hook.ts` 已存在，需从手动改为 session-end 自动触发 |

**M1 详细说明**：
- `session-memory-extract.ts` 的 `extractSessionMemories()` 已能从对话中提取 5 类记忆
- 缺少：session 结束时自动调用 → 写入 `memory.jsonl` 的 hook
- 落点：扩展 `dream-hook.ts` 或新建 `session-memory-persist-hook.ts`

**M2 详细说明**：
- `project-memory-loader.ts` 的 Tier1 过滤 `TIER1_KINDS = decision, project_rule, user_constraint`，confidence ≥ 0.9
- 但 `memory.jsonl` 的写入仅靠 `remember` 工具（主动调用）和 `dream.ts`（手动触发）
- durable claims（`claim-store.ts` status=durable）没有自动 bridge 到 `memory.jsonl`
- 需：session 结束时，将 durable claims 自动 append 到 `memory.jsonl`

**M3 详细说明**：
- `dream-hook.ts` 已在 runtime hook pipeline 中注册
- 当前触发条件不明（可能需要 vigor 变化或其他门控）
- 需改为：session 正常结束时无条件触发一次 Dream 蒸馏

### P1 — 重要差异（1-2 周内补齐）

| # | 能力 | 竞品参考 | 预估工作量 | 说明 |
|---|------|---------|-----------|------|
| **M4** | 语义检索升级 (FTS5) | Hermes FTS5 / Ruflo HNSW | 1 周 | `recall` 工具和 `playbook` 的 keyword match → SQLite FTS5 全文匹配 |
| **M5** | 记忆使用指导注入 | CC memoryTypes 的 how_to_use/body_structure | 2 天 | 每种 ContextClaimKind 附加 "何时保存/如何使用" 指导，注入 prompt |
| **M6** | Cost tracking (token usage) | CC cost-tracker | 3 天 | `src/context/types.ts` 已有 usage 类型，缺 UI 展示和 session 汇总 |
| **M7** | 权限冒泡 (delegate → parent) | CC permission bubble | 1 周 | 子 agent 的危险操作可冒泡到主 agent 审批 |
| **M8** | Skill 系统 (`.rivet/skills/*.md`) | CC skills | 1 周 | 用户自定义 skill，通过 `/skillname` 调用 |
| **M9** | 多模型成本路由 | Ruflo (75-85% 省) | 1 周 | Ice Mirror adapter 加 task complexity 评估 |
| **M10** | 破坏性命令警告 UI 化 | CC destructiveCommandWarning | 2 天 | `DANGEROUS_BASH_PATTERNS` 已有模式匹配，缺 TUI 展示 |

### P2 — 有价值但可推迟

| # | 能力 | 竞品参考 | 说明 |
|---|------|---------|------|
| **M11** | Agent 间通信 (mailbox) | CC SendMessageTool | 多 agent 实时消息传递 |
| **M12** | Team 文件持久化 | CC `.claude/teams/*.json` | team 配置可保存/复用 |
| **M13** | 用户可配 Hook API | CC hooks 19 事件 | PreToolUse/PostToolUse 用户 hook |
| **M14** | IDE 集成 | CC useDiffInIDE | VS Code 扩展 |
| **M15** | 跨会话语义搜索 | CC agenticSessionSearch | 唯一对历史做 LLM 分析的入口 |
| **M16** | Compact 8 段模板 + 熔断 | CC compact prompt | 升级压缩质量 |
| **M17** | Playbook export/import | OpenClaw Markdown | 用户可审阅/修改学到的知识 |

### P3 — 低优先级

| # | 能力 | 竞品参考 | 说明 |
|---|------|---------|------|
| **M18** | Remote Agent | CC teleport | worktree 已覆盖本地需求 |
| **M19** | Vim Mode | CC vim/ | 小众需求 |
| **M20** | Plugin 市场 | CC plugins | tool registry 已覆盖 |
| **M21** | Analytics/遥测 | CC analytics | 非核心 |

---

## 四、天枢独有优势（应放大，不应丢失）

| 能力 | 说明 | 竞品有否 |
|------|------|---------|
| Sensorium 3D 自感知 | momentum/confidence/pressure/vigor 实时感知 | ❌ 独有 |
| Immune 系统 | Innate + Adaptive + APC + Context + Hook 五层 | ❌ 独有 |
| Review Squadron 4 inspector | Security/Lifecycle/DataFlow/Silence 四维 | ❌ 独有 |
| Prediction Error 小脑环 | 连续失败 → intervention level → gate/escalate | ❌ 独有 |
| Dream NREM/REM 双相 | 模板提取 + 跨 session 模式检测 | ❌ 独有 |
| Prefix Cache 原生优化 | anchor 保护 + volatile 非阻塞 | CC 有类似但天枢更激进 |
| Star Domain Voice | 领域人格化 + 将星胶囊系统 | ❌ 独有 |
| Evidence fail-closed gate | transcript-backed, adversarial_verifier 无 run_tests → unverified | CC 有类似但天枢更严格 |

---

## 五、审查系统 vs CC 对照（已落地的详细对照）

| CC 能力 | CC 实现方式 | 天枢实现 | 差距 |
|---------|-----------|---------|------|
| 独立对抗 verifier | `verificationAgent.ts` (ant-only) | `adversarial_verifier` profile + `review-router.ts` | ✅ **已落地** — 天枢用 profile-registry 实现，剥夺写权限 (readonly_plus_test) |
| 剥夺写权限 | disallow Agent/ExitPlanMode/Edit/Write | `allowedTools: [...READ_ONLY_TOOLS, 'run_tests']` | ✅ 一致 |
| 强制对抗探针 | prompt 要求至少 1 个对抗探针 | expertisePrompt 要求 3 of 5 | ✅ 天枢更严格 |
| 证据必须含 command+output | PASS 必须附 "Command run + Output observed" | `worker-evidence.ts` 要求 transcript 含 `run_tests` | ✅ 天枢用 transcript 而非 prompt 约束 |
| L2/L3 分级 | 无明确分级 | `review-discipline.ts` classifyChangeScale → L1/L2/L3 | ✅ 天枢更结构化 |
| Review Squadron | 无（CC 只有单 verifier） | 4 inspector + blocking findings | ✅ 天枢独有 |
| Verification nudge | TodoWrite 注入提醒 | `aggregation.ts` detectVerificationGap | ✅ 一致 |
| fail-closed | 分类器不可用默认拒绝 | `worker-evidence.ts` 无 transcript → unverified | ✅ 一致 |
| patch→verify loop | 无（CC 单轮） | `review-router.ts` maxRounds=3 patch→verify | ✅ 天枢更强 |
| plan mode 人类审批 | ExitPlanModeV2 人批准 | `plan_submit` + plan-store | ✅ 已落地 |

---

## 六、实施建议

**建议分三批推进：**

**Batch 1（1 周）：记忆闭环**
- M1: session memory 自动持久化
- M2: durable claims auto-surface
- M3: Dream 自动触发
- 目标：天枢的每一段记忆都能「自动提取 → 持久化 → 下次自动注入」，形成完整闭环

**Batch 2（2 周）：检索+安全+成本**
- M4: FTS5 语义检索
- M6: Token usage 展示
- M7: 权限冒泡
- M10: 破坏性命令 UI 化

**Batch 3（2 周）：扩展能力**
- M5: 记忆使用指导
- M8: Skill 系统
- M9: 多模型成本路由
