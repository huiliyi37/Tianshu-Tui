# Worker Evidence 优化 — 阶段记录

> **状态**: Phase 1 已完成 | Phase 2/3 待规划
> **日期**: 2026-05-19
> **关联**: P2.4 Subagent Orchestration 集成验证

---

## 问题背景

`verifyWorkerEvidence` 函数对所有 `changedFiles` 非空的 WorkerResult 强制要求 `verification` 元数据，但 read-only worker（code_scout、reviewer 等）不应产生文件变更，它们只是检查/阅读文件。

**核心矛盾**: `changedFiles` 语义模糊 — 既表示"被修改的文件"也表示"被检查的文件"。

---

## Phase 1: 语义澄清（已完成）

### 改动文件

| 文件 | 改动 |
|------|------|
| `src/agent/work-order.ts` | `workerResultSchema` 和 `workerResultIngestSchema` 新增 `examinedFiles?: string[]` 可选字段 |
| `src/agent/worker-prompts.ts` | `RESULT_SHAPE` 新增 `examinedFiles` 字段；`buildWorkerPrompt` 增加区分说明；`buildPrimaryWorkerPacket` 包含 `examinedFiles` |
| `src/agent/worker-evidence.ts` | 添加文档注释，明确 gate 逻辑仅针对 `changedFiles`（mutations），`examinedFiles` 为信息性字段 |
| `src/agent/__tests__/worker-evidence.test.ts` | 新增 3 个测试用例覆盖 examinedFiles 场景 |

### 设计决策

```
changedFiles  → 文件被修改/创建（write worker 专用）
examinedFiles → 文件被阅读/检查（read-only worker 使用）

verifyWorkerEvidence gate 逻辑:
  changedFiles.length === 0 → 直接通过（不触发 verification 检查）
  changedFiles.length > 0   → 必须有 verification 元数据
```

### 测试覆盖

```
✔ passes through read-only worker with examinedFiles and empty changedFiles
✔ passes through read-only worker with examinedFiles even when evidenceStatus is verified
✔ blocks write worker with changedFiles and examinedFiles but no verification
```

---

## Phase 2: Profile-Aware Verification Policy（待规划）

**目标**: `verifyWorkerEvidence` 根据 worker profile 决定验证策略

| Profile | changedFiles | examinedFiles | 验证要求 |
|---------|-------------|---------------|---------|
| code_scout | 不允许 | 必填 | 无 |
| reviewer | 不允许 | 必填 | 无 |
| planner | 不允许 | 可选 | 无 |
| patcher | 必填 | 可选 | 必须有 verification |
| verifier | 必填 | 可选 | 必须有 verification |

**需要的改动**:
- `verifyWorkerEvidence(result, profile?)` 增加 profile 参数
- 根据 profile 类型执行不同验证策略
- 更新调用方传入 profile 信息

---

## Phase 3: Full Verification Pipeline（待规划）

**目标**: 完整的验证流水线

1. **Per-file verification tracking** — 每个文件独立的验证状态
2. **Git diff-based verification** — write worker 的文件变更通过 git diff 验证
3. **Cross-worker evidence correlation** — 多个 worker 的证据交叉验证
4. **Automatic re-verification** — 检测到文件变更后自动触发验证

---

## 技术复盘

### 做得好的地方

1. **语义分离清晰** — `changedFiles` vs `examinedFiles` 的区分简洁明了
2. **向后兼容** — `examinedFiles` 是可选字段，不影响现有 worker result 解析
3. **测试先行** — 3 个新测试覆盖了关键场景
4. **文档化** — `verifyWorkerEvidence` 函数现在有清晰的 JSDoc 说明

### 可改进的地方

1. **缺少集成测试** — 应该有端到端测试验证 read-only worker 的完整流程
2. **Profile 信息未传递** — Phase 2 需要将 profile 信息从 coordinator 传递到 verification 函数
3. **Prompt 引导不够强** — LLM 可能仍然将文件放入 `changedFiles` 而非 `examinedFiles`

### 风险点

- LLM 输出的 `changedFiles` 和 `examinedFiles` 可能不准确
- 现有 worker session 测试可能需要更新以适配新 schema
- Phase 2 的 profile 传递可能需要修改 coordinator 的调用链

---

## 下一步行动

1. [ ] 运行全量测试确认无回归
2. [ ] 更新集成验证计划文档
3. [ ] 规划 Phase 2 的具体实现步骤
4. [ ] 考虑是否需要在 coordinator 层面做 profile-aware 的结果处理
