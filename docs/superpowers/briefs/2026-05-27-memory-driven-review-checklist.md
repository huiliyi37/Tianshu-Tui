# Memory-driven Review Checklist 契约

> **Status**: implemented / verified

## 目标

`.rivet/knowledge/project-memory.md` 中的 `review_principle` 条目可以在交付时反向生成检查清单，提醒 agent 注意与当前 owned files 相关的架构边界。

## 运行时边界

- checklist 由 `deliver_task` 展示；
- checklist 不改变 Delivery Gate GREEN/YELLOW/RED；
- checklist 只匹配当前 owned files 与 memory entry 的 `Evidence` path；
- project memory 仍不进入 prompt，访问路径保持 recall 和 deliver_task 按需读取。

## 实现细节

### 模块

- `src/agent/review-principle-checklist.ts` — 提取与匹配逻辑
- `src/agent/deliver-task.ts` — 集成到交付报告

### 提取规则

1. 只提取 `Kind` 字段包含 `review_principle` 的条目
2. 从标题行提取 principle title
3. 从 `Claim` 字段提取原则声明
4. 从 `Review rule` 字段提取审查规则（可选）
5. 从 `Evidence` 字段提取文件路径列表

### 匹配逻辑

- 将 changed files 与 evidence paths 进行路径匹配
- 路径规范化：移除 `./` 前缀
- 最多返回 5 条 checklist items（可通过 `maxItems` 参数调整）

## 示例

当 owned file 包含 `src/agent/loop.ts`，且 project memory 中存在 streaming dedup review principle，交付报告应出现：

```text
Review principle checklist:
  - Do not declare a streamed response duplicate in the middle of the stream.
    Source: Real-Time Systems Need Boundary Clarity Before Speed
    Reason: Changed file matches review-principle evidence path: src/agent/loop.ts
```

## 设计决策

### 为什么是非阻塞的？

checklist 是提示层，不是门禁层。它的价值在于：
- 在交付前提醒 agent 注意相关架构边界
- 不强制 agent 遵循（agent 可能有更好的判断）
- 不增加交付流程的复杂度

### 为什么不进入 prompt？

- project memory 按需检索（recall）比默认注入更高效
- 避免触发 prefix cache miss
- 保持 prompt 简洁，只在需要时加载上下文

## 测试覆盖

- `src/agent/__tests__/review-principle-checklist.test.ts` — 提取与匹配逻辑
- `src/agent/__tests__/deliver-task.test.ts` — 集成测试
