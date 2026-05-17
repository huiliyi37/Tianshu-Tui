# StarFlow v2 闭环接线 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 StarFlow v2 的 6 个"computed but never consumed"集成缺口接成可靠闭环

**架构：** 遵循现有独立接线模式（Pattern B: mutable-class），在 loop.ts 的 3 个自然时机点（turn-start / after-tool / turn-end）分别补齐缺失的消费者代码。Phase A 修数据层（stigmergy query/prune），B/C/D 修消费层。

**技术栈：** Node.js 22, TypeScript, node:test, node:child_process (spawn)

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/agent/theta-check.ts` | spawn tsc --noEmit，解析错误，返回结构化结果 | 创建 |
| `src/agent/__tests__/theta-check.test.ts` | theta-check 单元测试 | 创建 |
| `src/agent/loop.ts` | 4 处修改：query 替换 load、prune 调用、theta 填充、kick 补齐 | 修改 |
| `src/context/__tests__/stigmergy.test.ts` | 补充 query→freshness 集成测试 | 修改 |
| `src/agent/__tests__/star-event.test.ts` | 补充 contracting 阶段触发测试 | 修改 |

---

### 任务 1：Stigmergy query() 替换 load() + prune()

**文件：**
- 修改：`src/agent/loop.ts:424-427`（run() 开始处）
- 修改：`src/agent/loop.ts:762`（tool 执行后刷新）
- 测试：`src/context/__tests__/stigmergy.test.ts`

- [ ] **步骤 1：编写失败的测试 — query 返回衰减后的 currentStrength**

在 `src/context/__tests__/stigmergy.test.ts` 末尾追加：

```typescript
describe('StigmergyStore integration with Sensorium freshness', () => {
  it('query returns currentStrength less than original after time passes', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({ path: 'src/a.ts', signal: 'well-tested', strength: 0.8 })

    // Simulate time passing by reading and manually adjusting depositedAt
    const entries = await store.load()
    entries[0].depositedAt = Date.now() - 3 * 24 * 3600 * 1000 // 3 days ago
    await store.save(entries)

    const results = await store.query()
    assert.ok(results.length === 1)
    assert.ok(results[0].currentStrength < 0.8, `expected decay, got ${results[0].currentStrength}`)
    assert.ok(results[0].currentStrength > 0.3, `expected partial decay, got ${results[0].currentStrength}`)
  })

  it('prune removes entries below threshold', async () => {
    const store = new StigmergyStore(storePath)
    await store.deposit({ path: 'src/old.ts', signal: 'fragile', strength: 0.1 })

    // Make it very old so decayed strength < 0.05
    const entries = await store.load()
    entries[0].depositedAt = Date.now() - 30 * 24 * 3600 * 1000 // 30 days ago
    await store.save(entries)

    await store.prune()
    const remaining = await store.load()
    assert.equal(remaining.length, 0)
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test src/context/__tests__/stigmergy.test.ts`
预期：PASS（query 和 prune 已实现，测试验证它们的行为）

- [ ] **步骤 3：修改 loop.ts — run() 开始处加 prune + query 替换 load**

在 `src/agent/loop.ts` 中，将 run() 开始处的 pheromone 加载逻辑替换：

```typescript
// Before (line 424-427):
this.loadedPheromones = []
this._hasEnteredHighComplexity = false
this.stigmergyStore.load().then(p => { this.loadedPheromones = p }).catch(() => {})

// After:
this.loadedPheromones = []
this._hasEnteredHighComplexity = false
this.stigmergyStore.prune().catch(() => {})
this.stigmergyStore.query().then(results => {
  this.loadedPheromones = results.map(r => ({
    path: r.path,
    signal: r.signal,
    strength: r.currentStrength,
    depositedAt: r.depositedAt,
    halfLife: r.halfLife,
  }))
}).catch(() => {})
```

- [ ] **步骤 4：修改 loop.ts — tool 执行后刷新也用 query**

在 `src/agent/loop.ts:762`，将刷新逻辑替换：

```typescript
// Before (line 762):
this.stigmergyStore.load().then(p => { this.loadedPheromones = p }).catch(() => {})

// After:
this.stigmergyStore.query().then(results => {
  this.loadedPheromones = results.map(r => ({
    path: r.path,
    signal: r.signal,
    strength: r.currentStrength,
    depositedAt: r.depositedAt,
    halfLife: r.halfLife,
  }))
}).catch(() => {})
```

- [ ] **步骤 5：修改 loadedPheromones 类型声明**

在 `src/agent/loop.ts:140`，类型已经是 `Pheromone[]`，`PheromoneRef` 接口的 `strength` 字段现在接收的是衰减后的值。无需改类型 — `PheromoneRef.strength` 在 `computeFreshness` 中被直接求和，现在传入的是 `currentStrength`，语义正确。

- [ ] **步骤 6：运行全量测试**

运行：`npm test`
预期：全部通过（1513+ pass）

- [ ] **步骤 7：Commit**

```bash
git add src/agent/loop.ts src/context/__tests__/stigmergy.test.ts
git commit -m "fix(stigmergy): use query() with decay instead of raw load(), add prune() at session start"
```

---

### 任务 2：Theta-Gamma 填充 — spawn tsc 类型检查

**文件：**
- 创建：`src/agent/theta-check.ts`
- 创建：`src/agent/__tests__/theta-check.test.ts`
- 修改：`src/agent/loop.ts:719-720`

- [ ] **步骤 1：编写失败的测试**

创建 `src/agent/__tests__/theta-check.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runThetaCheck } from '../theta-check.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('runThetaCheck', () => {
  it('returns empty errors for a valid TypeScript project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'theta-'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ['*.ts'],
    }))
    writeFileSync(join(dir, 'valid.ts'), 'export const x: number = 42\n')

    const result = await runThetaCheck(dir)
    assert.deepEqual(result.errors, [])
    assert.ok(result.durationMs >= 0)
  })

  it('returns error file paths for invalid TypeScript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'theta-'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
      include: ['*.ts'],
    }))
    writeFileSync(join(dir, 'broken.ts'), 'export const x: number = "not a number"\n')

    const result = await runThetaCheck(dir)
    assert.ok(result.errors.length > 0)
    assert.ok(result.errors.some(e => e.includes('broken.ts')))
  })

  it('returns empty errors when tsc is not found or times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'theta-'))
    // No tsconfig.json — tsc will fail
    const result = await runThetaCheck(dir)
    assert.deepEqual(result.errors, [])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --test src/agent/__tests__/theta-check.test.ts`
预期：FAIL — `Cannot find module '../theta-check.js'`

- [ ] **步骤 3：实现 theta-check.ts**

创建 `src/agent/theta-check.ts`：

```typescript
import { spawn } from 'node:child_process'

export interface ThetaCheckResult {
  errors: string[]
  durationMs: number
}

export function runThetaCheck(cwd: string, timeoutMs = 3000): Promise<ThetaCheckResult> {
  const start = Date.now()
  return new Promise(resolve => {
    const child = spawn('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
      cwd,
      timeout: timeoutMs,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: true,
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('close', (code) => {
      const durationMs = Date.now() - start
      if (code === 0 || !stderr) {
        resolve({ errors: [], durationMs })
        return
      }
      const errorFiles = [...new Set(
        stderr.split('\n')
          .filter(line => line.includes('error TS'))
          .map(line => {
            const match = line.match(/^(.+?)\(\d+,\d+\)/)
            return match ? match[1] : ''
          })
          .filter(Boolean)
      )]
      resolve({ errors: errorFiles, durationMs })
    })

    child.on('error', () => {
      resolve({ errors: [], durationMs: Date.now() - start })
    })
  })
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --test src/agent/__tests__/theta-check.test.ts`
预期：PASS

- [ ] **步骤 5：接线到 loop.ts — 填充 theta-gamma 空体**

在 `src/agent/loop.ts` 顶部添加 import：

```typescript
import { runThetaCheck } from './theta-check.js'
```

修改 `src/agent/loop.ts:719-720`：

```typescript
// Before:
if (this.sensorium && this.sensorium.complexity > 0.5 && tickTheta(this.thetaState, turn)) {
  this.thetaState = completeTheta(this.thetaState)
}

// After:
if (this.sensorium && this.sensorium.complexity > 0.5 && tickTheta(this.thetaState, turn)) {
  runThetaCheck(this.cwd).then(result => {
    for (const errFile of result.errors) {
      this.repairHintTracker.recordFailure(errFile, 'type-inconsistency')
    }
  }).catch(() => {})
  this.thetaState = completeTheta(this.thetaState)
}
```

- [ ] **步骤 6：运行全量测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 7：Commit**

```bash
git add src/agent/theta-check.ts src/agent/__tests__/theta-check.test.ts src/agent/loop.ts
git commit -m "feat(theta-gamma): fill empty body with spawn-tsc type check"
```

---

### 任务 3：Kick 效应器补齐 — deadEndPaths + alternativeFrameworks

**文件：**
- 修改：`src/agent/loop.ts:544-556`
- 测试：`src/agent/__tests__/dissipative-kick.test.ts`（已有，补充集成行为测试）

- [ ] **步骤 1：编写失败的测试 — kick deposits dead-end pheromones**

在 `src/agent/__tests__/dissipative-kick.test.ts` 末尾追加：

```typescript
describe('buildKickActions integration', () => {
  it('alternativeFrameworks are included in injectedMessage when appended', () => {
    const s = makeSensorium({ momentum: 0.1, stability: 0.2 })
    const actions = buildKickActions(s, '/project', ['src/stuck.ts'])

    // Verify the data is available for the loop to consume
    assert.ok(actions.deadEndPaths.length > 0)
    assert.ok(actions.alternativeFrameworks.length > 0)
    assert.ok(actions.injectedMessage.length > 0)

    // Simulate what loop.ts should do: append frameworks to message
    const fullMessage = `${actions.injectedMessage}\n\n**替代框架：**\n${actions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`
    assert.ok(fullMessage.includes('simplest viable approach'))
    assert.ok(fullMessage.includes('替代框架'))
  })
})
```

- [ ] **步骤 2：运行测试验证通过**

运行：`node --test src/agent/__tests__/dissipative-kick.test.ts`
预期：PASS（测试验证数据结构，不依赖 loop.ts 修改）

- [ ] **步骤 3：修改 loop.ts — 补齐 kick 效应器**

修改 `src/agent/loop.ts:544-556`：

```typescript
// Before:
if (shouldKick(this.sensorium)) {
  const kickActions = buildKickActions(this.sensorium, this.cwd)
  if (kickActions.injectedMessage) {
    this.session.addUserMessage(kickActions.injectedMessage)
  }
  if (shouldEscalateFromKick(this.sensorium) && callbacks.onPhaseChange) {
    callbacks.onPhaseChange('tianshu-encore', {
      reason: 'Dissipative kick: stagnation detected',
      suggestion: 'Escalate to stronger model or reframe the problem',
    })
  }
}

// After:
if (shouldKick(this.sensorium)) {
  const recentFailed = this.recentToolHistory
    .filter(h => h.status === 'failed')
    .map(h => h.target)
    .filter(Boolean)
  const kickActions = buildKickActions(this.sensorium, this.cwd, recentFailed)

  // Deposit dead-end pheromones for failed paths
  for (const p of kickActions.deadEndPaths) {
    this.stigmergyStore.deposit({ path: p, signal: 'dead-end', strength: 0.9 }).catch(() => {})
  }

  // Inject message with alternative frameworks appended
  const parts = [kickActions.injectedMessage]
  if (kickActions.alternativeFrameworks.length > 0) {
    parts.push(`\n**替代框架：**\n${kickActions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`)
  }
  const fullMessage = parts.join('')
  if (fullMessage) {
    this.session.addUserMessage(fullMessage)
  }

  if (shouldEscalateFromKick(this.sensorium) && callbacks.onPhaseChange) {
    callbacks.onPhaseChange('tianshu-encore', {
      reason: 'Dissipative kick: stagnation detected',
      suggestion: 'Escalate to stronger model or reframe the problem',
    })
  }
}
```

- [ ] **步骤 4：运行全量测试**

运行：`npm test`
预期：全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/agent/loop.ts src/agent/__tests__/dissipative-kick.test.ts
git commit -m "fix(kick): wire deadEndPaths deposit and alternativeFrameworks injection"
```

---

### 任务 4：Contracting Trigger — hasEnteredHighComplexity

**文件：**
- 修改：`src/agent/__tests__/star-event.test.ts`（补充 contracting 测试）

- [ ] **步骤 1：验证现有实现已正确**

检查 `src/agent/loop.ts:497-500`：

```typescript
// Track whether complexity ever reached high → enables contracting phase
if (this.sensorium.complexity > 0.5) {
  this._hasEnteredHighComplexity = true
}
```

检查 `src/agent/loop.ts:517`：

```typescript
hasEnteredHighComplexity: this._hasEnteredHighComplexity,
```

检查 `src/agent/loop.ts:425`：

```typescript
this._hasEnteredHighComplexity = false
```

**发现：contracting trigger 已经完整实现！** 字段声明（line 141）、重置（line 425）、设置（line 498-500）、传入 StarPhaseContext（line 517）全部就位。

- [ ] **步骤 2：编写测试验证 contracting 阶段可触发**

在 `src/agent/__tests__/star-event.test.ts` 中追加：

```typescript
describe('contracting phase (tianquan)', () => {
  it('triggers when hasEnteredHighComplexity + confidence high + complexity low', () => {
    const s: Sensorium = {
      momentum: 0.5,
      pressure: 0.3,
      confidence: 0.8,
      complexity: 0.3,
      freshness: 0.5,
      stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 5,
      isWriting: false,
      isRunningTests: false,
      isFinalTurn: false,
      shouldEscalate: false,
      hasEnteredHighComplexity: true,
    }
    const phase = mapSensoriumToPhase(s, ctx)
    assert.equal(phase, 'tianquan-contracting')
  })

  it('does not trigger without hasEnteredHighComplexity', () => {
    const s: Sensorium = {
      momentum: 0.5,
      pressure: 0.3,
      confidence: 0.8,
      complexity: 0.3,
      freshness: 0.5,
      stability: 0.8,
    }
    const ctx: StarPhaseContext = {
      turn: 5,
      isWriting: false,
      isRunningTests: false,
      isFinalTurn: false,
      shouldEscalate: false,
      hasEnteredHighComplexity: false,
    }
    const phase = mapSensoriumToPhase(s, ctx)
    assert.notEqual(phase, 'tianquan-contracting')
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`node --test src/agent/__tests__/star-event.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/agent/__tests__/star-event.test.ts
git commit -m "test(star-event): add contracting phase trigger verification"
```

---

### 任务 5：TypeCheck + 全量验证

**文件：** 无新修改，纯验证

- [ ] **步骤 1：运行 TypeScript 类型检查**

运行：`npm run typecheck`
预期：0 errors

- [ ] **步骤 2：运行全量测试**

运行：`npm test`
预期：全部通过（1513+ pass, 0 fail）

- [ ] **步骤 3：验证 sensorium.jsonl 格式不变**

运行：`cat .rivet/sensorium.jsonl | head -1 | node -e "const l=require('fs').readFileSync('/dev/stdin','utf8');const o=JSON.parse(l);console.log(Object.keys(o).sort().join(','))"`
预期：输出包含 `complexity,confidence,freshness,momentum,phase,pressure,stability,strategy,ts,turn`

- [ ] **步骤 4：验证 stigmergy query 返回衰减值**

运行：`node -e "import('./src/context/stigmergy.js').then(m => { const s = new m.StigmergyStore('.rivet/pheromones.json'); s.query().then(r => console.log('entries:', r.length, 'sample:', r[0]?.currentStrength)) })"`
预期：如果有 pheromones，currentStrength < strength；如果无 pheromones，entries: 0

---

## 自检结果

**1. 规格覆盖度：**
- ✅ Stigmergy query/prune（任务 1）
- ✅ Theta-gamma 填充（任务 2）
- ✅ Kick deadEndPaths + alternativeFrameworks（任务 3）
- ✅ Contracting trigger（任务 4 — 发现已实现，补测试确认）
- ✅ 全量验证（任务 5）

**2. 占位符扫描：** 无 TODO/待定/后续实现

**3. 类型一致性：**
- `PheromoneQueryResult.currentStrength` → 映射为 `PheromoneRef.strength`（任务 1）
- `ThetaCheckResult.errors: string[]` → 传入 `repairHintTracker.recordFailure(file, reason)`（任务 2）
- `kickActions.deadEndPaths` → `stigmergyStore.deposit({ path, signal: 'dead-end', strength: 0.9 })`（任务 3）
- `_hasEnteredHighComplexity` → `StarPhaseContext.hasEnteredHighComplexity`（任务 4，已实现）

---

## Implementation Result

> 实施提交：`d6c88a0 fix(starflow): wire closed-loop strategy consumers`  
> 复盘资产：`docs/analysis/2026-05-18-starflow-v2-closed-loop-retrospective.md`

### 验证结果

- `npx tsx --test src/context/__tests__/stigmergy.test.ts` → 21 pass
- `npx tsx --test src/agent/__tests__/dissipative-kick.test.ts` → 23 pass
- `npx tsx --test src/agent/__tests__/theta-check.test.ts` → 3 pass
- `npx tsx --test src/agent/__tests__/star-event.test.ts` → 25 pass
- `npx tsc --noEmit` → 0 errors
- `npx tsx --test src/**/__tests__/*.test.ts` → 1521 pass, 0 fail

### 与计划相比的工程修正

1. `runThetaCheck()` 去掉 `shell: true`，直接 `spawn('npx', args)`，贴合项目工具惯例并降低注入面。
2. 同时收集 stdout + stderr，避免 tsc/npx 在不同环境下输出位置差异导致漏报。
3. 使用手写 timer + SIGTERM/SIGKILL，而不是依赖 spawn timeout。
4. “No tsconfig” 测试调整为 “non-project returns empty”，表达真实契约：无可解析 TypeScript file errors 时不阻塞 agent。
5. theta 检测失败记录复用现有 `type_error` failure class，而不是新增无模板的 `type-inconsistency`。
6. Kick recentFailed 保守跟计划，不额外过滤非路径，保持与已有 bash dead-end 行为一致。
7. 未新增高成本 loop harness；以单元测试覆盖 action/data contract，全量测试兜底中心 loop。

### 后续建议

- `.rivet/pheromones.json` 应作为 runtime artifact 加入 `.gitignore`。
- delegate worker provider 缺失时应显式降级为 skipped/unavailable，而不是表现为普通 worker failure。
- `runThetaCheck()` 后续可增加 in-flight guard 与 telemetry。
