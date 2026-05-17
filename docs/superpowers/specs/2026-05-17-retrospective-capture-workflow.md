# 复盘沉淀工作流 · 设计

> 目标：把 agent 在开发过程中自然产生的复盘分析（设计洞察、根因诊断、过程摩擦、架构决策）从"偶然行为"变成"系统化知识资产"。

## 现状盘点

| 已有资产 | 捕获内容 | 存储 | 可联动 |
|----------|---------|------|--------|
| Dream 蒸馏 | session WHAT：文件变更、测试结果、决策 | `.rivet/knowledge/project-memory.md` | ✅ |
| Claim Store | 事件级事实：file_observation、failure_pattern、project_fact、decision | `~/.rivet/sessions/<id>.jsonl` | ✅ |
| Recall 工具 | 关键词搜索 claims | — | ✅ |
| 手动复盘文档 | 深度分析：设计取舍、根因、过程摩擦 | `docs/analysis/*-retrospective.md` | ❌ 不联动 |

**缺口**：Dream 知道"改了什么"，Claim Store 知道"发生了什么"，但都不回答"**为什么这样做**"和"**下次应该怎么避免**"。

## 核心思路

不是新建一个独立系统。而是在 Dream 蒸馏的流程上，加一个**复盘层**——

```
Dream 蒸馏（自动）
  → .rivet/knowledge/project-memory.md    [WHAT]

复盘沉淀（触发式）
  → .rivet/retrospectives/<date>-<topic>.md  [WHY]
  → 关键洞察 promote 为 claim（project_rule / decision）
```

## 触发条件

| 触发方式 | 条件 |
|----------|------|
| **自动** | session 结束 + delivery_status = verified（有实质产出） |
| **手动** | `/retrospect` 命令，带可选 topic |
| **讨论驱动** | agent 与用户在对话中对设计问题做了深入讨论后，用户说"记下来" |

Phase 1 只做手动触发（零风险，不污染自动流程）。

## 复盘模板

```markdown
# 复盘：<topic> · <date>

## 背景
<一句话：这个 session 做了什么>

## 设计决策
### <决策 1>
- **选择**：<做了什么选择>
- **替代方案**：<考虑过但不选的方案 + 为什么>
- **影响**：<对后续开发的影响>

## 发现的问题
### <问题 1>
- **现象**：<观察到的症状>
- **根因**：<诊断结论>
- **修复**：<已采取的措施，或建议>
- **预防**：<如何避免同类问题>

## 过程摩擦
### <摩擦 1>
- **场景**：<触发条件>
- **影响**：<对开发节奏的影响>
- **改进方向**：<建议>

## 可复用模式
- **模式**：<trigger + diagnosis + fix 三元组>
- **适用场景**：<什么情况下可以用>

## 联动标记
- [ ] promote 到 project-memory
- [ ] promote 为 claim（project_rule）
```

## 与已有系统的联动路径

```
┌──────────────────────────────────────────┐
│  复盘文档 (.rivet/retrospectives/)         │
│                                              │
│  ├─ 设计决策 ──→ promote → claim(decision)  │
│  ├─ 可复用模式 ─→ promote → claim(project_rule)
│  ├─ 根因分析 ──→ 下次 Dream 蒸馏引用         │
│  └─ 过程摩擦 ──→ 反馈给 activity-status 优化 │
└──────────────────────────────────────────┘
```

### 联动 1：复盘 → Dream

Dream 下一次 session 蒸馏时，在知识条目末尾附加相关复盘标签：

```markdown
### 2026-05-17 — session abc12345
**Modified** (3): src/agent/dream.ts, src/main.tsx, src/prompt/volatile.ts
...
> 📝 Retrospectives: dream-phase1-容量不对称, trajectory-空值修复
```

实现：`distillSession()` 里新增一个可选参数 `retrospectiveRefs?: string[]`，从 `.rivet/retrospectives/` 目录扫描匹配当前 session 涉及文件的复盘文档。

### 联动 2：复盘 → Claim Store

复盘中的关键条目自动 propose 为 claim：

| 复盘字段 | Claim kind | scope |
|----------|-----------|-------|
| 设计决策 | `decision` | `project` |
| 可复用模式 | `project_rule` | `project` |
| 根因诊断 | `failure_pattern` | `project` |

这些 claim 跨 session 持久化（scope=project 不随 session evict 删除），可被 recall 工具搜索。

### 联动 3：复盘 → 过程优化

复盘中的"过程摩擦"条目是 activity-status-layer 和 tool rate limiter 的直接需求输入。

## 实现阶段

| Phase | 内容 | 改动 |
|-------|------|------|
| **Phase 1** | `/retrospect` 命令 + 模板生成 + 文件写入 | `src/tui/slash-commands.ts` + 新建 `src/agent/retrospect.ts` (~80 行) |
| **Phase 2** | 复盘→Claim 自动 promote（设计决策、可复用模式） | `src/agent/retrospect.ts` + `claim-store` (~50 行) |
| **Phase 3** | Dream 蒸馏引用复盘标签 | `src/agent/dream.ts` (~20 行) |
| **Phase 4** | 自动触发（session end + verified） | `main.tsx` shutdown hook (~15 行) |

## Phase 1 交付物

- `src/agent/retrospect.ts` — `generateRetrospectTemplate(sessionSummary, topic?)` + `persistRetrospect()`
- `src/tui/slash-commands.ts` — `/retrospect [topic]` 命令
- 测试：模板生成正确性、文件写入

## 为什么不是全自动

自动生成的复盘容易变成"AI 自说自话"——在没有用户参与的情况下，agent 很难判断哪些设计决策值得记录、哪些摩擦是偶发的。保留手动触发（+ 用户确认）让复盘保持**高信号**。

Phase 4 的自动触发也只做"提示"——session 结束时 agent 问"这个 session 有什么值得复盘的吗？"，用户选择是否触发。
