# Session Handoff — 2026-05-25

## 本轮状态

**任务目标**: 用户要求对 immune 信号系统和 mistake history 进行优化，结合实际代码设计一个方案。

**实际进展**: ❌ 未能完成。文件读取工具在本次会话中遭遇严重障碍，多次被 `pruned` / `diet:redundant` / `diet:useless` 拦截。尝试了多种策略（offset/limit、bash cat、pipe、临时文件、python）均无法稳定获取文件全文。已确认下个会话会改进文件读取机制。

## 已确认掌握的信息

### Immune 系统架构（6个文件）

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/agent/immune-types.ts` | ~60 | 类型定义：DangerSignal(7种), ImmuneMemory, ImmuneResponse, ActivationDecision |
| `src/agent/immune-innate.ts` | ~71 | 先天免疫：实时危险信号检测器 |
| `src/agent/immune-adaptive.ts` | ~130 | 自适应免疫：记忆匹配、亲和力评分、response选择 |
| `src/agent/immune-apc.ts` | ~50 | APC聚合器：收集信号→决定是否激活免疫 |
| `src/agent/immune-hook.ts` | ~219 | 主钩子：串联Physarum + Immune层到agent loop |
| `src/agent/immune-types.ts` 中的信号种类 | — | compaction_fail, token_spike, tool_repeat, prediction_error, graph_anomaly, repair_exhaustion, sycophancy_detected |

### Mistake 系统（2个文件）

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/agent/mistake-detector.ts` | ~55 | 错误模式检测（含 failed→passed 转换检测） |
| `src/agent/mistake-notebook.ts` | ~87 | 错误笔记本：SHA指纹去重、持久化、上下文注入 |

### 关联文件

| 文件 | 角色 |
|------|------|
| `src/agent/tool-pipeline.ts` | 工具执行管线，第598行调用 `immuneHook.recordRepairSuccess` |
| `src/agent/p3-integration.ts` | P3集成层 |
| `src/repo/meridian-db.ts` | 经络数据库（Physarum边持久化） |
| `src/repo/physarum-engine.ts` | 黏菌引擎（immune信号引用） |

### 测试覆盖

- `src/agent/__tests__/immune-*.test.ts` — 6个测试文件
- `src/agent/__tests__/mistake-*.test.ts` — 3个测试文件

## 用户意图（重要）

用户明确表示：
1. **不在意是否能避免错误**，在意的是 agent 是否有**清醒的认知**
2. immune/mistake 这些功能是"补强"用的必要功能
3. **最在意的是 agent 不会回到训练模式**（sycophancy / 谄媚模式）
4. 想要给 agent "更多好东西"

## 优化方向（待下个会话深入代码后确定）

初步构思的方向（需要在读完全部代码后验证和细化）：

1. **信号质量而非数量**: 当前有7种信号，但是否都有消费者？是否需要信号去重/衰减？
2. **Mistake ↔ Immune 闭环**: mistake notebook 里的模式能否反馈为 immune memory？反之，immune 检测到的模式能否沉淀为 mistake entry？
3. **上下文注入策略**: mistake notebook 注入到 prompt 时，是否按相关性排序？是否做了长度控制？
4. **清醒认知的度量**: sycophancy_detected 信号触发了什么？是否有闭环？

## 需要下个会话做的事

1. **读完所有655行核心代码**（immune 5文件 + mistake 2文件 + tool-pipeline相关段）
2. 读完 tool-pipeline 中 immune/mistake 的接入点
3. 读完测试文件了解已验证的行为
4. 基于完整理解，设计一个具体的优化方案
5. 输出设计文档，获得用户确认后再实现

## 会话反思

这次会话暴露了工具层面的严重问题。file read 反复失败导致大量上下文浪费在重试上。用户说已在其他天枢复盘基础上改进了文件读取，期待下个会话验证。
