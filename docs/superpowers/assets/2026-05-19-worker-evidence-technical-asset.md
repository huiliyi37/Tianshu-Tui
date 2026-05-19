# Worker Evidence 优化 — 技术实现资产

> **资产类型**: 架构设计 + 实现模式
> **创建日期**: 2026-05-19
> **关联特性**: P2.4 Subagent Orchestration
> **状态**: Phase 1 完成 | 可复用模式

---

## 1. 问题定义

### 1.1 核心矛盾

`verifyWorkerEvidence` 函数对所有 `changedFiles` 非空的 WorkerResult 强制要求 `verification` 元数据，但 read-only worker（code_scout、reviewer 等）不应产生文件变更。

```
┌─────────────────────────────────────────────────────────────┐
│                    原始设计的问题                              │
├─────────────────────────────────────────────────────────────┤
│  changedFiles: ["src/auth.ts"]                             │
│       ↓                                                     │
│  verifyWorkerEvidence()                                     │
│       ↓                                                     │
│  evidenceStatus !== 'verified' → BLOCKED ❌                 │
│                                                             │
│  问题: read-only worker 只是读取了文件，不应该被 blocked       │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 语义模糊

`changedFiles` 字段承担了两种职责：
- **职责 A**: 记录被修改的文件（write worker 专用）
- **职责 B**: 记录被检查的文件（read-only worker 使用）

---

## 2. 解决方案架构

### 2.1 语义分离设计

```
┌─────────────────────────────────────────────────────────────┐
│                    新的字段语义                                │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  changedFiles: string[]    ← 文件被修改/创建（mutations）     │
│  examinedFiles: string[]   ← 文件被阅读/检查（inspections）   │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐                        │
│  │ Write Worker │    │ Read-Only   │                        │
│  │ (patcher)    │    │ Worker      │                        │
│  └──────┬──────┘    └──────┬──────┘                        │
│         │                  │                                │
│         ▼                  ▼                                │
│  changedFiles: [...]  examinedFiles: [...]                  │
│  + verification       changedFiles: []                      │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Gate 逻辑流程

```
                    ┌──────────────────┐
                    │ verifyWorker     │
                    │ Evidence(result) │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │ changedFiles     │
                    │ .length === 0?   │
                    └────────┬─────────┘
                             │
              ┌──────────────┴──────────────┐
              │ YES                         │ NO
              ▼                             ▼
     ┌────────────────┐           ┌────────────────┐
     │ 直接通过        │           │ 检查 evidence  │
     │ (examinedFiles │           │ Status         │
     │  不触发 gate)   │           └────────┬───────┘
     └────────────────┘                    │
                                  ┌────────┴────────┐
                                  │ verified?       │
                                  └────────┬────────┘
                                           │
                                  ┌────────┴────────┐
                                  │ NO → BLOCKED    │
                                  │ YES → 检查      │
                                  │   verification  │
                                  └─────────────────┘
```

---

## 3. 实现细节

### 3.1 Schema 变更 (work-order.ts)

```typescript
// workerResultSchema 新增字段
export const workerResultSchema = z.object({
  // ... existing fields ...
  changedFiles: z.array(z.string()),
  examinedFiles: z.array(z.string()).optional(),  // ← 新增
  // ...
})

// workerResultIngestSchema 同步更新
const workerResultIngestSchema = z.object({
  // ... existing fields ...
  changedFiles: z.array(z.string()).default([]),
  examinedFiles: z.array(z.string()).optional(),  // ← 新增
  // ...
})
```

**设计决策**: `examinedFiles` 是可选字段，保证向后兼容。

### 3.2 Worker Prompt 更新 (worker-prompts.ts)

```typescript
const RESULT_SHAPE = `{
  // ...
  "changedFiles": [],
  "examinedFiles": ["list files you read/inspected but did NOT modify"],
  // ...
}`

// buildWorkerPrompt 增加区分说明
'Use changedFiles ONLY for files you actually modified/created.',
'Use examinedFiles for files you read/inspected.',
```

### 3.3 Evidence Gate 更新 (worker-evidence.ts)

```typescript
/**
 * Verify worker evidence for mutation safety.
 *
 * Gate logic: only `changedFiles` (files actually mutated) triggers verification.
 * `examinedFiles` (files read/inspected) are informational and never trigger the gate.
 */
export function verifyWorkerEvidence(result: WorkerResult): WorkerResult {
  // Only gate on changedFiles (mutations). examinedFiles are informational.
  if (result.changedFiles.length === 0) return result
  // ... rest of verification logic unchanged ...
}
```

### 3.4 Primary Worker Packet 更新 (worker-prompts.ts)

```typescript
export function buildPrimaryWorkerPacket(results: WorkerResult[]): string {
  const compact = results.map(result => ({
    // ... existing fields ...
    changedFiles: result.changedFiles,
    examinedFiles: result.examinedFiles,  // ← 新增
    // ...
  }))
  // ...
}
```

---

## 4. 测试覆盖矩阵

| 场景 | changedFiles | examinedFiles | evidenceStatus | 预期结果 |
|------|-------------|---------------|----------------|---------|
| Read-only worker 正常 | `[]` | `['src/a.ts']` | `unverified` | ✅ passed |
| Read-only worker + verified | `[]` | `['src/a.ts']` | `verified` | ✅ passed |
| Write worker 无 verification | `['src/a.ts']` | `['src/b.ts']` | `verified` | ❌ blocked |
| Write worker 有 verification | `['src/a.ts']` | `[]` | `verified` + verification | ✅ passed |
| Write worker 未验证 | `['src/a.ts']` | `[]` | `unverified` | ❌ blocked |

---

## 5. 架构决策记录 (ADR)

### ADR-001: 使用可选字段而非联合类型

**决策**: `examinedFiles` 使用 `z.array(z.string()).optional()` 而非联合类型

**理由**:
- 向后兼容：现有的 worker result 解析不需要修改
- 简单性：不需要复杂的类型判断
- 渐进式：可以逐步迁移

**权衡**:
- LLM 可能不总是填充 `examinedFiles`
- 需要 prompt 引导

### ADR-002: Gate 逻辑不变

**决策**: 保持 `verifyWorkerEvidence` 的 gate 逻辑不变，只依赖 `changedFiles.length === 0`

**理由**:
- 最小化变更风险
- 逻辑清晰：有变更才需要验证
- 易于理解和维护

**权衡**:
- 如果 LLM 错误地将文件放入 `changedFiles`，仍然会被 blocked
- 需要 Phase 2 的 profile-aware 策略来进一步优化

---

## 6. 复用模式

### 6.1 语义分离模式

当一个字段承担多种职责时，引入新字段进行语义分离：

```typescript
// Before: 单一字段承担多种语义
interface Result {
  files: string[]  // 既表示修改的文件，也表示检查的文件
}

// After: 语义分离
interface Result {
  changedFiles: string[]   // 修改的文件（触发验证）
  examinedFiles: string[]  // 检查的文件（不触发验证）
}
```

### 6.2 渐进式 Gate 模式

验证逻辑应该分层，而不是一刀切：

```typescript
function verify(result: Result): Result {
  // Layer 1: 快速路径（无变更直接通过）
  if (result.changedFiles.length === 0) return result
  
  // Layer 2: 基础验证（evidence status）
  if (result.evidenceStatus !== 'verified') return block(result)
  
  // Layer 3: 深度验证（verification metadata）
  if (!result.verification) return block(result)
  
  return result
}
```

---

## 7. 后续演进路径

### Phase 2: Profile-Aware Verification

```typescript
function verifyWorkerEvidence(
  result: WorkerResult,
  profile?: WorkerProfile  // ← 新增参数
): WorkerResult {
  const isReadOnly = profile && ['code_scout', 'reviewer', 'planner'].includes(profile)
  
  if (isReadOnly) {
    // Read-only workers: 只检查 examinedFiles 是否存在
    if (result.examinedFiles?.length === 0) {
      return addRisk(result, 'read-only worker should document examined files')
    }
    return result
  }
  
  // Write workers: 完整验证流程
  // ... existing logic ...
}
```

### Phase 3: Per-File Verification Tracking

```typescript
interface FileVerification {
  path: string
  status: 'verified' | 'unverified' | 'failed'
  verifiedBy?: string  // command that verified this file
  verifiedAt?: number
}

interface WorkerResult {
  // ...
  fileVerifications: FileVerification[]  // ← 每个文件独立的验证状态
}
```

---

## 8. 关联资产

| 资产类型 | 路径 | 说明 |
|---------|------|------|
| 设计文档 | `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md` | 原始设计 |
| 实现代码 | `src/agent/work-order.ts` | Schema 定义 |
| 实现代码 | `src/agent/worker-evidence.ts` | Gate 逻辑 |
| 实现代码 | `src/agent/worker-prompts.ts` | Prompt 模板 |
| 测试代码 | `src/agent/__tests__/worker-evidence.test.ts` | 测试覆盖 |
| 状态文档 | `docs/superpowers/status/2026-05-19-worker-evidence-optimization.md` | 阶段记录 |

---

## 9. 指标与验证

- **TypeScript 编译**: ✅ 通过
- **单元测试**: ✅ 7/7 通过
- **向后兼容**: ✅ `examinedFiles` 是可选字段
- **文档完整性**: ✅ JSDoc + 状态文档 + 技术资产

---

*本文档作为项目核心资产留存，关联 P2.4 Subagent Orchestration 特性迭代。*
