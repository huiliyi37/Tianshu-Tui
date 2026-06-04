# DX 工具链韧性加固（收敛版）

> **状态：✅ 已全部实施** — esbuild 语法检查 (syntax-check.ts) 集成
>
> **本版基于代码核对收敛。** 原计划 7 个任务中，5 个被核对证伪为「不存在 / 已修复 / 已被上游覆盖 / 字段已存在」。详见末尾「§7 已删除任务及证据」。

**目标：** 消除验证流程中唯一被代码证据证实的高频摩擦点——`run_tests` 的 node:test 输出解析在含 ANSI 颜色序列时返回全零计数，被下游误判为 `tool_invocation_failure` 而 RED 阻塞交付。附带把 timeout 与真正的 invocation failure 区分开。

**架构：**
1. 在 `run_tests` 的 `parseOutput` 入口 strip ANSI 转义序列，根治「实际有测试通过/失败却被判为 invocation failure」。（根因，Task 1）
2. 在 `run_tests` timeout handler 标记 `failureKind: 'timeout'`，并在 `verification-attribution.ts` 把 timeout 归为 `external_blocked`（不阻塞），同时让 `isInvocationFailure` 显式排除 timeout。（Task 2）

**技术栈：** TypeScript strict / node:test + assert/strict

---

## 1. Scope check

| 子系统 | 是否涉及 | 原因 |
|--------|---------|------|
| `src/tools/run-tests.ts` | ✅ 是 | `parseOutput`（实际 line 102-118）无 ANSI strip；timeout handler 未标记 failureKind |
| `src/agent/verification-attribution.ts` | ✅ 是 | `isInvocationFailure`（实际 line 201-207）未排除 timeout；`attribute()` 无 timeout 分支 |
| `src/tools/types.ts` | ❌ 否 | `VerificationMetadata` 已含 `failureKind?` 与 `durationMs`（line 28-41），无需改 |
| `src/agent/delivery-gate-v2.ts` | ❌ 否 | `ownedFiles.length===0 → GREEN` 守卫（line 170）已在 switch 之前覆盖「无修改文件不应阻塞」；Task 1 修好后剩余 RED 均为真 RED |
| `src/agent/task-ledger.ts` | ❌ 否 | `record()`（line 90）已 stamp timestamp；已有 supersession dedup。TTL 价值边际，移至 backlog |
| `src/tools/read-file.ts` | ❌ 否 | `sliceFromArtifact`（line 86-98）offset 处理正确，git 历史从无此 bug |
| `tsconfig.json` | ❌ 否 | 测试走 `tsx --test`，从不调 tsc，全程 esbuild 内存 source map；全库无 `.js.map` 可冲突 |

---

## 2. File structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tools/run-tests.ts` | 修改 | `parseOutput` 入口 strip ANSI；timeout handler 设 `failureKind: 'timeout'` |
| `src/tools/__tests__/run-tests.test.ts` | 修改 | 新增 ANSI 输出解析 + timeout failureKind 测试 |
| `src/agent/verification-attribution.ts` | 修改 | `isInvocationFailure` 排除 timeout；`attribute()` 增 timeout → external_blocked 分支 |
| `src/agent/__tests__/verification-attribution.test.ts` | 修改（如存在）或新建 | 覆盖 timeout 归因 |

---

## 3. Research endorsement（已核对，仅保留属实项）

### 3.1 ANSI 序列破坏 node:test 计数解析（根因·已验证 TRUE）

**文件**：`src/tools/run-tests.ts:102-118`

```typescript
const totalMatch = raw.match(/[ℹ#]\s+tests\s+(\d+)/)
const failMatch  = raw.match(/[ℹ#]\s+fail\s+(\d+)/)
const passMatch  = raw.match(/[ℹ#]\s+pass\s+(\d+)/)
```

当 `node --test` 启用颜色时输出形如 `\x1b[36mℹ\x1b[39m tests \x1b[36m32\x1b[39m`，`ℹ` 被 ANSI 字节包裹，上述正则不匹配 → `passed/failed/skipped` 全 0。

**后果链（已逐环核对）**：`execute()`（line 299-308）产出 `{status:'failed', passed:0, failed:0, skipped:0, exitCode:1}`（node:test 有失败即 exit 1）→ `verification-attribution.ts` 的 `isInvocationFailure`（line 201-207：`status==='failed' && exitCode!==0 && passed===0 && failed===0 && skipped===0`）返回 true → `attribute()`（line 235）`return tool_invocation_failure / isBlocking:true` → delivery gate RED。

全文件**无任何 ANSI strip**（已确认）。

### 3.2 timeout 与 invocation failure 未区分（已验证）

**文件**：`src/agent/verification-attribution.ts:201-207`、`src/tools/run-tests.ts`（timeout handler）

`run_tests` 超时 kill 子进程时，可能已有部分输出但计数仍为 0，落入与 invocation failure 相同的全零形态，被同样硬阻塞。`attribute()` 当前无 timeout 分支。

> **注（修正原计划风险项）**：原计划提议给 `isInvocationFailure` 加 `durationMs < 5000` 辅助判断——**不采纳**。reasoning 模型 + 大测试套件下真实测试也可能 >5s，会反向误判。改用「ANSI strip 后计数为真」+「timeout 显式标记」两个确定性信号，不靠时长启发式。

---

## 4. Tasks

### Task 1：`parseOutput` 增加 ANSI 颜色代码清洗（根因）

- [ ] 实现 + 测试 + 验证

**文件**：修改 `src/tools/run-tests.ts`；测试 `src/tools/__tests__/run-tests.test.ts`

**改动**：在 `parseOutput` 函数开头 strip，后续匹配基于清洗后的字符串：

```typescript
function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;]*m/g, '')
}

function parseOutput(raw: string, runner: string): ParsedResult {
  const clean = stripAnsi(raw)
  // 将本函数内所有 raw.match(...) 改为 clean.match(...)
```

**测试**：

```typescript
it('parses node-test counts even with ANSI color codes', () => {
  const ansi = '\x1b[36mℹ\x1b[39m tests \x1b[36m32\x1b[39m\n\x1b[32mℹ\x1b[39m pass \x1b[32m32\x1b[39m\n\x1b[31mℹ\x1b[39m fail \x1b[31m0\x1b[39m'
  const parsed = parseOutput(ansi, 'node')
  assert.equal(parsed.passed, 32)
  assert.equal(parsed.failed, 0)
})
```

**验证**：`npm exec -- tsx --test src/tools/__tests__/run-tests.test.ts`
**预期**：新增测试通过，原有测试不回归。
**提交**：`fix(run_tests): strip ANSI before parsing node:test counts to avoid false invocation-failure`

---

### Task 2：区分 timeout 与 invocation failure

- [ ] 实现 + 测试 + 验证

**文件**：修改 `src/tools/run-tests.ts`（timeout handler）、`src/agent/verification-attribution.ts`；测试 `src/agent/__tests__/verification-attribution.test.ts`

**改动 A** — `run-tests.ts` timeout handler 标记 failureKind（`VerificationMetadata.failureKind` 字段已存在，types.ts:28-41）：

```typescript
verification: { ...blockedVerification, durationMs: Date.now() - startTime, failureKind: 'timeout' }
```

**改动 B** — `verification-attribution.ts`：`isInvocationFailure` 排除 timeout，`attribute()` 增 timeout 分支（置于 line 234 的 `if (result.status === 'failed')` 块内、invocation_failure 判断之前）：

```typescript
function isInvocationFailure(result: VerificationMetadata): boolean {
  if (result.failureKind === 'timeout') return false
  return result.status === 'failed' && result.exitCode !== 0
    && result.passed === 0 && result.failed === 0 && result.skipped === 0
}

// attribute() 内，status==='failed' 时最先判断：
if (result.failureKind === 'timeout') {
  return { attribution: 'external_blocked', isBlocking: false,
    reason: `Verification timed out: ${result.command}. Rerun with longer timeout if needed.`, source: result }
}
```

> 确认 `attribution` 联合类型已含 `'external_blocked'`；若无则在该类型定义处补充（实现时核对）。

**验证**：`npm exec -- tsx --test src/agent/__tests__/verification-attribution.test.ts`
**预期**：timeout verification → `external_blocked` 且 `isBlocking:false`；全零非 timeout 仍 → `tool_invocation_failure`。
**提交**：`fix(verification-attribution): treat timeout as external_blocked, exclude it from invocation-failure`

---

## 5. Verification

| 检查 | 命令 | 预期 |
|------|------|------|
| typecheck | `npm run typecheck` | 无错误 |
| run-tests 测试 | `npm exec -- tsx --test src/tools/__tests__/run-tests.test.ts` | 通过 |
| attribution 测试 | `npm exec -- tsx --test src/agent/__tests__/verification-attribution.test.ts` | 通过 |
| 全量 | `npm test` | 通过（已知 `deliver-task.test.ts` 2 个 ownership 失败属 `505533e` 遗留，与本计划无关）|

---

## 6. Self-check

**Spec coverage**：原始 4 个「问题」中，仅 ANSI 解析（→ Task 1）与 timeout 区分（→ Task 2）被代码证据证实为真问题且天枢可控。其余见 §7。

**Placeholder scan**：无 TODO / 待定；每个测试含具体断言。

**Type consistency**：`VerificationMetadata.failureKind?` 与 `durationMs` 已存在（types.ts:28-41），无需新增字段。`attribution` 是否含 `'external_blocked'` 在实现 Task 2 时核对。

---

## 7. 已删除任务及证据

下列原任务经逐文件核对后删除或降级，避免在幻影问题上耗费精力：

| 原任务 | 处置 | 证据 |
|--------|------|------|
| read_file 大文件 offset 返回开头 | **删除** | `sliceFromArtifact`（read-file.ts:95）`start = Math.max(0, offset-1)` 正确；两条 dedup 路径均传对 offset；git 历史从无此 bug |
| source map 误导（tsconfig inlineSourceMap）| **删除** | 测试走 `tsx --test`，从不调 tsc；全库无 `.js.map`，不存在可冲突文件。原「行号错乱」实为已修复的 read_file 截断 bug 喂错内容所致 |
| TaskLedger 加 timestamp + TTL | **降级 backlog** | timestamp 已存在（task-ledger.ts:27，record() line 91 自动 stamp）；已有 supersession dedup（同 key 重跑成功即覆盖失败）。TTL 仅对「再也不重跑的瞬时失败」有边际价值，非高频摩擦 |
| delivery-gate 降级无 owned-files 的 invocation_failure | **删除** | `assess()` 在 switch 之前已有 `ownedFiles.length===0 → GREEN`（delivery-gate-v2.ts:170）；无修改文件根本到不了 RED 分支。Task 1 修好后，有 owned files 时的 RED 均为真 RED，不应降级 |
| DX 已知限制 handoff 文档 | **删除** | 该文档记录的两条「限制」（read_file、source map）均不存在，会误导后续开发者 |

---

## 8. Execution handoff

收敛后仅 2 个任务，均小且确定性高，可内联执行（executing-plans）。两任务独立，可并行。

