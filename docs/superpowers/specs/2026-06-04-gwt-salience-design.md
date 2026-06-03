# GWT 全局工作空间竞争 — 架构设计

> 日期：2026-06-04
> 实现：`aae8cd3`
> 来源：联动 #4 全局工作空间竞争（跨系统联动创意文档 §4）
> 状态：Step 1 已实现（salience 评分 + Top-K 预算），Step 2 待推进

---

## 1. 问题

context-update 是每轮注入 LLM 的动态上下文块，包含 star-domain、git-status、tool-history、decisions 等十余种子块。随着子系统增多，子块总量膨胀，token 预算压力持续上升。

之前策略：固定顺序全量输出。没有预算控制，没有优先级排序。

## 2. 设计：Global Workspace Theory (GWT) Top-K 选择

将 context-update 显式建模为"全局工作空间"——有限资源（token 预算），多信息源竞争进入。

### 2.1 Salience 评分

每个子块根据 XML 标签名获得一个显著性分数 `∈ [0.3, 1.0]`：

| 标签 | salience | 理由 |
|------|----------|------|
| `<star-domain>` | 1.0 | 身份锚定，最高优先级 |
| `<repair-hint>` | 0.8 | 直接可执行的修复指令 |
| `<historical-lessons>` | 0.8 | 历史教训，直接影响行为 |
| `<task-progress>` | 0.7 | 任务状态，工作记忆核心 |
| `<decisions>` | 0.7 | 决策记录，保持一致性 |
| `<worktree-warning>` | 0.7 | 异常告警 |
| `<git-status>` | 0.6 | 环境感知 |
| `<recent-commits>` | 0.6 | 上下文背景 |
| `<tool-history>` | 0.5 | 操作日志 |
| `<session-state>` | 0.4 | 会话元数据 |
| `<cross-session>` | 0.4 | 跨会话事件 |
| `<read-file-dedup-hint>` | 0.3 | 去重提示，最低信息密度 |

**评分规则**：基于标签前缀的硬编码映射。Step 2 会引入动态 salience（基于 goal-alignment × staleness）。

### 2.2 Top-K 选择算法

```
selectTopKBlocks(blocks, maxChars):
  sorted ← blocks 按 salience 降序排列
  selected ← []
  used ← 0
  for block in sorted:
    overhead ← (selected.length > 0) ? 2 : 0  // '\n\n' 分隔符
    if used + overhead + block.length > maxChars AND selected.length > 0:
      continue  // 跳过超预算块，但至少保留最高优先级的
    selected.push(block)
    used += overhead + block.length
  return selected
```

**保底机制**：即使预算极小，最高 salience 的块也必定入选（`selected.length > 0` 门控）。

### 2.3 与现有架构的接口

```
buildDynamicAppendix(ctx, maxChars?) → string
```

- `maxChars` 未传（默认）：全量输出，向后兼容
- `maxChars` 传入：启用 GWT Top-K 选择

调用方：`src/prompt/engine.ts` 中 `buildDynamicAppendix(activeCtx)` 和 `buildDynamicAppendix(dynamicCtx)` 两个调用点。**当前均未传 maxChars**——Step 2 需要从 engine 层传入预算值。

### 2.4 Prefix Cache 安全

GWT 选择仅影响 `<context-update>` 块（每轮动态重渲染）。frozen block（`buildVolatileBlockInternal`）和 stable block（`buildStableVolatileBlock`）不受影响。Top-K 丢弃某些块不会破坏 prefix cache——frozen prefix 字节完全不变。

---

## 3. 已实现的导出接口

| 函数 | 位置 | 用途 |
|------|------|------|
| `assignSalience(blockContent)` | `volatile.ts` | 给子块评分 |
| `selectTopKBlocks(blocks, maxChars)` | `volatile.ts` | 预算内 Top-K 选择 |
| `buildDynamicAppendix(ctx, maxChars?)` | `volatile.ts` | 带 GWT 的动态上下文渲染 |
| `SalientBlock` 接口 | `volatile.ts` | `{ content: string, salience: number }` |

---

## 4. 测试覆盖

⚠️ **当前缺失**：`assignSalience` 和 `selectTopKBlocks` 没有单元测试。

待补：
- assignSalience 对每种标签的评分正确性
- selectTopKBlocks 在预算不足时的裁剪行为
- 保底机制（至少保留一个块）
- 空输入边界条件

---

## 5. Step 2 路线图

| 改动 | 描述 | 复杂度 |
|------|------|--------|
| Engine 层接入 maxChars | 从 config 或 context window 计算 maxChars 传给 buildDynamicAppendix | 低 |
| 动态 salience | salience = base × goal_alignment × freshness - staleness | 中 |
| Attention Schema | 维护"上一轮注意了什么"的简化模型，检测偏差 | 高 |
| Activator-Inhibitor 斑点 | spreading activation 在 context 空间形成高内聚注意力岛 | 高 |

---

## 6. 设计决策记录

1. **硬编码 salience 而非动态计算**：Step 1 最小化实现，验证 pipeline 正确后再引入动态因素。
2. **maxChars 可选参数**：向后兼容——所有现有调用点不传 maxChars，行为不变。
3. **按标签前缀匹配**：避免解析完整 XML，用 `startsWith()` 做快速分类。
4. **不修改 frozen block**：GWT 仅作用于 dynamic appendix，确保 prefix cache 稳定。
