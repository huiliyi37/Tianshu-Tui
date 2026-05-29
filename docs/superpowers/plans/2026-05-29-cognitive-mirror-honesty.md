# cognitive-mirror 诚实化 — confidence → verification_coverage

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复 cognitive-mirror 中 `confidence="1.00"` 在无证据时误导模型的问题——将属性重命名为 `verification_coverage` 以反映其真实语义，并新增 `files_modified` 属性让模型感知验证是否已启动。

**架构：** 不改 `computeConfidence()` 的返回值语义（保持所有下游 consumers 的行为不变），仅修改 `buildCognitiveMirror()` 的输出标签，使镜子真正"应而不藏"——如实反映状态，不伪装确定性。

**技术栈：** TypeScript strict / node:test + assert/strict

---

## 1. Scope check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/context/cognitive-ledger.ts` | ✅ 是 | `buildCognitiveMirror()` 标签修改 |
| `src/context/__tests__/cognitive-mirror.test.ts` | ✅ 是 | 断言中 `confidence` → `verification_coverage` |
| `src/agent/sensorium.ts` | ✅ 是 | 仅更新 JSDoc，不改逻辑 |
| `src/agent/__tests__/sensorium.test.ts` | ✅ 是 | 测试用例名称更新以反映语义 |
| `src/agent/approval-risk.ts` | ❌ 否 | 内部仍用 `sensorium.confidence`，值不变 |
| `src/agent/tool-pipeline.ts` | ❌ 否 | 同上 |
| `src/agent/vigor.ts` | ❌ 否 | 同上 |
| `src/agent/star-event.ts` | ❌ 否 | 同上 |
| `src/agent/dissipative-kick.ts` | ❌ 否 | 同上 |
| `src/agent/uncertainty-framing.ts` | ❌ 否 | 同上 |

此计划**仅修改 cognitive-mirror 的呈现层**，不触及 sensorium 计算逻辑或任何下游消费者。

---

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/context/cognitive-ledger.ts` | 修改 | `buildCognitiveMirror()`：`confidence` → `verification_coverage`，新增 `files_modified` |
| `src/context/__tests__/cognitive-mirror.test.ts` | 修改 | 更新所有断言中的属性名 |
| `src/agent/sensorium.ts` | 修改 | JSDoc 更新：明确 `confidence` 字段语义 = "verification coverage ratio" |
| `src/agent/__tests__/sensorium.test.ts` | 修改 | 测试用例名称："confidence" → "verification coverage" |

---

## 3. Research endorsement（调研背书）

### 3.1 `buildCognitiveMirror()` 的 confidence 属性

- **存在原因**：`buildCognitiveMirror()` 第 98 行 `parts.push('confidence="${formatDim(s.confidence)}"')` — 作为 cognitive-mirror XML 标签的第一个属性，始终存在
- **调用方**：仅 `buildCognitivePromptProjection()` (`cognitive-ledger.ts:150`)，后者仅被 `loop.ts:1309` 调用
- **消费者**：镜子内容作为不透明字符串注入 LLM prompt，无任何代码解析该标签（参见 worker 调研结论：零处 parse/regex/extract）
- **格式约定**：`confidence="X.XX"`（2 位小数），测试仅用 `includes('confidence="0.30"')` 断言，不验证完整属性集
- **风险**：修改属性名不影响任何程序行为，仅影响 LLM 对镜子的解读

### 3.2 `computeConfidence()` 的计算逻辑

- **定义**：`sensorium.ts:139-142` — 当 `filesModified <= 0` 返回 `1.0`，否则返回 `clamp(verifiedCount / filesModified)`
- **调用方**：仅 `computeSensorium()` (`sensorium.ts:240`)
- **语义**：实际计算的是"已验证改动比例"（verification coverage ratio），不是通用置信度
- **值域**：始终在 `[0, 1]` 范围内
- **不修改此函数**：保持 `1.0` 返回值（真空真：0 个改动中验证了 0 个 = 100%），仅修改呈现层的标签使语义透明

### 3.3 `sensorium.confidence` 的下游消费者（确认不需要修改）

| 消费者 | 文件:行 | 用法 | 为什么不受影响 |
|--------|---------|------|----------------|
| shouldEscalate | `sensorium.ts:273` | `s.confidence < 0.3` | 值不变，比较逻辑不变 |
| star-event 阶段判断 | `star-event.ts:107,122,132` | `s.confidence < 0.3` / `> 0.6` / `> 0.7` | 值不变 |
| approval risk | `approval-risk.ts:193` | `< escalateConfidence(0.3)` | 值不变 |
| auto-approve | `tool-pipeline.ts:441` | `>= autoApproveConfidence(0.8)` | 值不变 |
| uncertainty framing | `uncertainty-framing.ts:25` | `< 0.4` | 值不变 |
| vigor curiosity | `vigor.ts:88-89` | `confidence < 0.4` | 值不变 |
| vigor canSpeedUp | `vigor.ts:135` | `confidence > 0.7` | 值不变 |
| dissipative kick | `dissipative-kick.ts:70,88,108` | `s.confidence < 0.3` / `< 0.2` | 值不变 |
| intent preview | `intent-preview.ts:42` | `confidence ?? 0.6` | 值不变 |
| telemetry/sycophancy | 多处 | `sensorium.confidence` | 值不变 |

**结论：所有下游消费者均通过 `sensorium.confidence` 字段读取值，修改镜子中的属性名不影响它们。**

---

## 4. Tasks

### Task 1: cognitive-mirror 标签诚实化 — 修改核心逻辑与测试

**目标**：将 `confidence` 属性重命名为 `verification_coverage`，新增 `files_modified` 属性。

**步骤：**

#### 1a. 修改 `buildCognitiveMirror()` — 重命名 + 新增属性

**文件**：`src/context/cognitive-ledger.ts:98`

修改前：
```typescript
const parts: string[] = [`confidence="${formatDim(s.confidence)}"`]
```

修改后：
```typescript
const parts: string[] = [`verification_coverage="${formatDim(s.confidence)}"`]
```

**文件**：`src/context/cognitive-ledger.ts:96-97`（在 `if (!s) return ''` 之后，`const parts` 之前）

新增 `files_modified` 属性。在 `const parts: string[] = [...]` 之后添加：

```typescript
// Show how many files have been modified so model can interpret verification_coverage.
// When files_modified=0, verification_coverage=1.00 is vacuously true.
const filesModified = ledger.evidence.filesModified.size
parts.push(`files_modified="${filesModified}"`)
```

#### 1b. 更新 cognitive-mirror 测试

**文件**：`src/context/__tests__/cognitive-mirror.test.ts`

所有 `confidence="` 断言改为 `verification_coverage="`：

- 第 67 行：`assert.ok(mirror.includes('confidence="0.30"'))` → `assert.ok(mirror.includes('verification_coverage="0.30"'))`
- 第 86 行：`assert.ok(mirror.includes('confidence'))` → `assert.ok(mirror.includes('verification_coverage'))`
- 第 150 行：`assert.ok(mirror.includes('confidence="0.33"'))` → `assert.ok(mirror.includes('verification_coverage="0.33"'))`

新增 `files_modified` 断言：

在 `'generates cognitive-mirror tag with sensorium dimensions'` 测试（第 62-68 行）中添加：
```typescript
assert.ok(mirror.includes('files_modified="0"'))
```

在 `'includes all six sensorium dimensions'` 测试（第 70-89 行）中添加：
```typescript
assert.ok(mirror.includes('files_modified'))
```

在 `'formats dimensions to 2 decimal places'` 测试（第 147-153 行）的 `confidence` 断言替换为 `verification_coverage` 断言后，添加：
```typescript
assert.ok(mirror.includes('files_modified="0"'))
```

#### 1c. 测试用例名称 — 语义更新

**文件**：`src/agent/__tests__/sensorium.test.ts`

- 第 192 行（原 `'confidence defaults to 1.0 when no files modified'`）：
  修改为 `'verification coverage defaults to 1.0 when no files modified (vacuously true)'`

- 第 188 行测试名称不变（`assert.equal(s.confidence, 0.8)` 断言不变，仅标签更新），该测试描述改为：
  `'verification coverage reflects verified/modified ratio'`

#### 1d. JSDoc 更新

**文件**：`src/agent/sensorium.ts:54`（`Sensorium` 接口中 `confidence` 字段的注释）

修改前：
```typescript
/** Verification confidence: verified_count / modified_count (or 1.0 if no changes) */
confidence: number
```

修改后：
```typescript
/** Verification coverage ratio: verified_count / modified_count.
 *  Returns 1.0 when no files modified (vacuously true — 0/0 = all verified).
 *  This is a coverage metric, NOT general confidence.
 *  In the cognitive-mirror, rendered as `verification_coverage` to prevent misreading. */
confidence: number
```

#### 1e. 验证

```bash
npx tsc --noEmit                                    # 预期：clean typecheck
npm exec -- tsx --test src/context/__tests__/cognitive-mirror.test.ts  # 预期：全部通过
npm exec -- tsx --test src/agent/__tests__/sensorium.test.ts           # 预期：全部通过
```

#### 1f. 提交

```bash
git add src/context/cognitive-ledger.ts \
        src/context/__tests__/cognitive-mirror.test.ts \
        src/agent/sensorium.ts \
        src/agent/__tests__/sensorium.test.ts
git commit -m "fix(mirror): rename confidence to verification_coverage, add files_modified"
```

---

### Task 2: 全量回归验证

**目标**：确认修改未破坏任何下游行为。

**步骤：**

```bash
# 类型检查
npx tsc --noEmit
# 预期：clean，0 errors

# 全量测试
npm exec -- tsx --test src/**/__tests__/*.test.ts
# 预期：所有测试通过（含 2 个已存在的环境相关失败不计入）
```

**提交**：若 Task 1 已提交，此步无需额外提交。若合并提交：
```bash
git commit --amend --no-edit  # 仅当需要时
```

---

## 5. Verification

| 验证项 | 命令 | 预期结果 |
|--------|------|----------|
| TypeScript 编译 | `npx tsc --noEmit` | 0 errors |
| cognitive-mirror 测试 | `npm exec -- tsx --test src/context/__tests__/cognitive-mirror.test.ts` | 全部通过 |
| sensorium 测试 | `npm exec -- tsx --test src/agent/__tests__/sensorium.test.ts` | 全部通过 |
| 全量回归 | `npm exec -- tsx --test src/**/__tests__/*.test.ts` | 无新增失败 |
| 手动检查镜子输出 | 启动 agent 后检查 `<cognitive-mirror` 标签 | 含 `verification_coverage="X.XX"` 和 `files_modified="N"`，不含 `confidence=` |

---

## 6. Self-check

### 6.1 Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| confidence 不再以误导性标签出现在镜子中 | Task 1a |
| 新增 files_modified 让模型感知验证状态 | Task 1a |
| 测试断言更新 | Task 1b |
| sensorium JSDoc 澄清语义 | Task 1d |
| 下游消费者不受影响 | Task 2（全量回归） |

### 6.2 Placeholder scan

✅ 无 TODO / TBD / 待定 / 后续实现 / 补充细节
✅ 所有测试断言均为精确的 `assert.ok(mirror.includes('verification_coverage="0.30"'))` 形式
✅ 所有修改均有精确的文件路径和行号

### 6.3 Type consistency

- `buildCognitiveMirror()` 签名不变：`(ledger: CognitiveLedger) => string`
- `CognitiveLedger.evidence` 类型不变：`EvidenceState`（含 `filesModified: Set<string>`）
- `Sensorium.confidence` 类型不变：`number`
- `computeConfidence()` 返回类型不变：`number`
- 所有下游消费者通过 `Sensorium.confidence: number` 访问，类型不变

---

## 7. Execution handoff

计划已完成并保存到 `docs/superpowers/plans/2026-05-29-设计任务来实现这个-confidence-1-00-内容的优化.md`。两种执行方式：

1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
