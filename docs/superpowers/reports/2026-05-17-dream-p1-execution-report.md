# Dream Phase 1 执行观测报告

> **日期：** 2026-05-17
> **执行者：** DeepSeek V4 Pro（天枢人格）
> **计划文档：** `docs/superpowers/plans/2026-05-17-project-memory-dream.md`
> **产出 commit：** `6a30c3c` (feat/openai-client 分支)

---

## 1. 执行结果

| 指标 | 结果 |
|------|------|
| 计划任务数 | 4 |
| 完成任务数 | 4（Task 1-3 实现 + Task 4 集成验证） |
| 产出文件 | `src/agent/dream.ts` (135行), `src/agent/__tests__/dream.test.ts` (159行), volatile.ts +22行, main.tsx +12行 |
| 测试数 | 8 tests (5 distill + 3 persist) |
| 全量测试 | 1056 pass, 0 fail |
| Typecheck | 0 errors |
| 总改动量 | ~190 行核心代码 |

---

## 2. 与计划的偏差

| 偏差点 | 计划要求 | 实际实现 | 评估 |
|--------|---------|---------|------|
| `persistDream` 返回值 | `boolean` | `void` | ✅ 合理简化，main.tsx 不消费返回值 |
| 截断策略 | 按行 halfIdx 截断 | `combined.slice(0, MAX_FILE_SIZE)` 裸截断 | ⚠️ 可能切断条目，Phase 2 修复 |
| volatile.ts 缓存 | 有 `knowledgeCache` + TTL | 每次读文件 | ✅ 文件 <8KB，性能影响可忽略 |
| `decisions` 字段 | 空数组（计划标注 Phase 2 接线） | 空数组 | ✅ 符合 scope 控制 |
| `trajectoryEntries` | 计划标注空数组 | 已接入 `agent.getTrajectoryEntries()` | ✅ 超额完成 |
| 测试中 VerificationMetadata | 计划未指定完整字段 | 补全了 `scope`, `exitCode`, `durationMs` | ✅ TDD 暴露了类型缺失 |

**偏差总结：** 1 个需修复（截断），4 个合理简化，1 个超额完成。无硬编码、无 cheat。

---

## 3. 天枢人格效果观测

### 3.1 自主判断力

执行者在复盘中主动发现了 5 个设计问题：

1. **8000/2000 不对称** — 识别出存储容量与注入容量的 4:1 比例导致"死存储"
2. **裸截断切碎条目** — 与审查者独立发现相同问题
3. **只取最后一次验证** — 识别出多验证场景的信息丢失
4. **decisions/trajectory 空值** — 标注了唯一依赖未来 phase 的硬缺口
5. **去重缺失** — 提出了跨 session 合并方案

**对比基线：** 普通 agent（无人格 prompt）执行完毕后输出"all tests pass, done"。天枢人格产出了设计层面的反思。

### 3.2 TDD 防护效果

- 类型错误（`VerificationMetadata` 缺 `scope`/`exitCode`/`durationMs`）在第一步测试就暴露
- 没有出现 Codex 式硬编码（为通过测试而 mock 返回值）
- 所有逻辑是通用的，换任何输入都能正确工作

### 3.3 摩擦点

- **工具锁限流：** 连续读 3 个文件被限流，用 bash sed 绕过。建议调整阈值到 5-8 次/分钟。
- **计划文档缺 rationale：** 8000 vs 2000 的设计意图未在计划中说明，导致执行者误判为缺陷。

---

## 4. 架构验证结论

| 假设 | 验证结果 |
|------|---------|
| 天枢人格能产生独立判断 | ✅ 复盘中 5 个设计洞察，3 个是真问题 |
| TDD 防止锚点坍缩 | ✅ 无硬编码，类型错误早期暴露 |
| 小步骤计划对 open model 有效 | ✅ 4 文件互不踩脚，边界清晰 |
| 计划文档提供全局视野 | ✅ 执行者知道 volatile.ts 会读文件、main.tsx 会调用 |
| best-effort 设计哲学 | ✅ shutdown hook try/catch，不阻塞退出 |

### 关键发现

**Rivet 架构用三层机制打破了开源模型的"锚点坍缩"：**

1. **计划文档** — 注意力分配到整个链路，而非坍缩到单步
2. **TDD 流程** — 阻止 cheat 路径，必须让行为通过而非编译通过
3. **天枢人格** — 编码"反思"探索策略，完成后评估设计合理性

**本质：** 用外部结构（计划+TDD+人格）替代了模型自身缺失的"工作记忆管理"能力。不是让模型变聪明，而是不让它变笨。

---

## 5. Phase 2/3 改进建议

基于本次观测，Phase 2/3 计划已调整：

- **Task 1（截断修复）：** 按 `\n### ` 边界截断，不切碎条目
- **Task 2（去重）：** date + sorted files 做 key，同天同文件合并
- **Task 3（decisions 接线）：** 暴露 `getDecisions()` getter + 门控条件
- **计划文档改进：** 在关键设计决策处增加 rationale 注释，减少执行者误判

---

## 6. 工作流优化方向

| 方向 | 具体改进 |
|------|---------|
| 工具限流 | 调整连续读文件阈值 5→8 次/分钟，或对 read-only 操作免限流 |
| 计划 rationale | 关键数值（MAX_FILE_SIZE、KNOWLEDGE_MAX_CHARS）旁加一行"为什么" |
| 复盘模板化 | 在计划末尾加"执行后复盘"模板，引导执行者输出结构化反思 |
| 偏差分类 | 区分"合理简化"vs"需修复"，减少审查噪音 |
| 超额完成追踪 | 记录执行者主动做的额外工作（如 trajectory 接线），评估是否纳入后续计划 |
