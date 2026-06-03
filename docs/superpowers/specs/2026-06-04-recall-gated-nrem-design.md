# Recall-Gated NREM 记忆巩固 — 架构设计

> 日期：2026-06-04
> 实现：`0800c05`
> 来源：联动 #3 记忆巩固管道（跨系统联动创意文档 §3），NREM 阶段
> 状态：NREM recall-gate 已实现，REM 阶段待推进

---

## 1. 问题

Context Claim 有三级晋升管道：`active → durable_candidate → durable`。晋升条件包括消费者数量（3→5）和时间阈值（10 分钟）。但原始设计没有验证 claim 的证据文件是否仍然存在——如果 source file 被删除或重命名，claim 就变成了"僵尸知识"：无法被检索验证，但仍在影响行为。

## 2. 设计：Recall-Gated Consolidation

借鉴神经科学的 recall-gated plasticity（Lindsey 2024）：只有能被成功检索（recall）的信息才能被巩固（consolidate）。如果证据不可检索，巩固被阻断。

### 2.1 核心函数

```typescript
canRecallClaim(claim: ContextClaim, cwd?: string): boolean
```

逻辑：
1. 无 cwd → 返回 `true`（非阻塞降级，测试环境安全）
2. claim 无文件证据（`evidence.path === undefined`）→ 返回 `true`（无需检查）
3. 至少一个证据文件仍存在 → 返回 `true`
4. 所有证据文件都已消失 → 返回 `false`

### 2.2 与晋升管道的集成

```typescript
promoteEligibleClaims(now, cwd?):
  for claim in claims:
    next ← evaluatePromotion(claim, now)
    if !next: continue
    
    // Recall-gate: 检查证据可达性
    if !canRecallClaim(claim, cwd):
      updateClaimStatus(claim.id, 'stale', 'recall-gate: evidence files no longer exist')
      continue  // 阻断晋升，标记 stale
    
    updateClaimStatus(claim.id, next, 'promotion threshold met')
```

**关键决策**：recall-gate 失败的 claim 被标记为 `stale` 而非 `quarantined`。理由是证据消失是不可恢复的（文件不会自动回来），`stale` 是更准确的语义。

### 2.3 计数器扩展

`ClaimStatusCounts` 新增 `recallBlocked` 字段，用于 TUI cockpit 显示和诊断。

### 2.4 文件证据的提取方式

```typescript
claim.evidence
  .filter(e => e.path !== undefined)
  .map(e => e.path!)
```

只有 `file_observation` 和 `verification_fact` 类型的 claim 通常有文件证据。其他类型（如 `decision`）的证据通常是描述性文本，不触发 recall-gate。

---

## 3. 系统调用链

```
loop.ts → promoteEligibleClaims(now, cwd)
  → evaluatePromotion(claim, now)  // 原有晋升逻辑不变
  → canRecallClaim(claim, cwd)     // 新增 recall-gate
    → existsSync(join(cwd, path))  // 文件系统检查
  → updateClaimStatus(...)          // 晋升或标记 stale
```

`cwd` 参数在 `context-injection.ts` 中传入，来自 `session.cwd`。

---

## 4. Prefix Cache 影响

**无影响**。recall-gate 在 promotion 逻辑中运行，promotion 在 JSONL event stream 中操作，不触及 prompt 渲染层。`recallBlocked` 计数器仅在 cockpit 显示，不注入 LLM context。

---

## 5. 测试覆盖

已有测试：`src/context/__tests__/promotion.test.ts` 覆盖了 `evaluatePromotion` 的原有逻辑。

⚠️ **缺失**：`canRecallClaim` 没有独立单元测试。需要补充：
- 无 cwd 时返回 true
- 无文件证据时返回 true
- 一个证据存在时返回 true
- 全部证据消失时返回 false
- 证据路径包含 `undefined` 的边界条件

---

## 6. REM 阶段路线图

REM（playbook-reflect）阶段的目标：
1. 泛化重放：从具体 claim 提取通用模式
2. 抑制性过滤：只保留跨 session 重复出现的结构
3. 自我修复：检测并更新过时条目

实现位置：`src/agent/playbook-reflect.ts`（待创建或扩展）
