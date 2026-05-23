# P3 优化 Scout 实现关联文档

> 关联设计文档：[P3 优化 Scout 设计文档](./specs/2026-05-24-p3-optimization-scout-design.md)
> 日期：2026-05-24

---

## 模块 A：语义级轨迹精简（三层渐进式精简）

### Layer 1：规则过滤（零成本）

**文件**：`src/compact/semantic-prune.ts`

实现内容：
- `pruneJunkDirs()` — 删除垃圾目录列表（__pycache__/, .git/, node_modules/ 等）
- `pruneTestOutput()` — 保留失败用例 + 最后一次运行摘要
- `deduplicateGrep()` — 同一 pattern 的多次 grep 只保留最新
- `summarizeEditEcho()` — edit_file 输出中与 read_file 重复的内容摘要

**测试**：`src/compact/__tests__/semantic-prune.test.ts`

---

### Layer 2：过期检测（AgentDiet 风格）

**文件**：`src/compact/staleness-detect.ts`

实现内容：
- `detectStaleness()` — 检测 tool result 是否过期
  - lag=3 步：只评估 3 步前的 tool result
  - 覆盖检测：后续步骤重新读取同一文件 → 旧版本标记过期
  - 引用追踪：tool result 从未被后续 assistant 消息引用 → 标记 useless
  - 阈值保护：只处理 >500 tokens 的 tool result

**测试**：`src/compact/__tests__/staleness-detect.test.ts`

---

### Layer 3：Flash 反射（可选，高压力时启用）

**文件**：`src/compact/heuristic-extractor.ts`

实现内容：
- `extractHeuristics()` — 用 DeepSeek Flash 评估 lag 窗口内的 tool results
- 触发条件：session >15 步 且 token 压力 >70%
- 成本：~$0.0007/次（可忽略）
- 回退：Flash 失败时用 Layer 1+2 的结果

---

## 模块 B：输出存储优化

**文件**：`src/tools/output-store.ts`

实现内容：
- `persistRawOutput()` — 持久化原始输出到 .rivet/outputs/ 目录
- `buildModelOutput()` — 构建给模型的精简输出
- `buildUiOutput()` — 构建给 UI 的完整输出（带截断）
- `extractErrorAwareLines()` — 错误感知的行提取（失败命令优先保留错误行）

**测试**：`src/tools/__tests__/output-store.test.ts`

---

## 模块 C：Doom Loop 检测增强

**文件**：`src/agent/trace-store.ts`

实现内容：
- `getDoomLoopLevel()` — 双策略 doom loop 检测
  - 策略 1：连续重复检测（3+ 连续相同调用 → blocked）
  - 策略 2：滑动窗口频率检测（6/8 窗口 → blocked）

**测试**：`src/agent/__tests__/trace-store.test.ts`

---

## 集成状态

| 模块 | 文件 | 状态 | 关联设计 |
|------|------|------|---------|
| Layer 1 | semantic-prune.ts | ✅ 已实现 | 模块 A |
| Layer 2 | staleness-detect.ts | ✅ 已实现 | 模块 A |
| Layer 3 | heuristic-extractor.ts | ✅ 已实现 | 模块 A |
| 输出存储 | output-store.ts | ✅ 已实现 | 模块 B |
| Doom Loop | trace-store.ts | ✅ 已增强 | 模块 C |
