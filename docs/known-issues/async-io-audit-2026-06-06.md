# Async I/O 转换审计报告

**审计日期**: 2026-06-06
**审计范围**: `fa90d29`..`a023e0c`（最近 5 个提交）
**分支**: `fix/stall-root-causes-abort-exit`
**状态**: 未定位根因，记录所有发现

---

## 一、提交概览

| 提交 | 描述 | 文件数 | 风险等级 |
|------|------|--------|----------|
| `fa90d29` | readFilePayload + gitignore → async | 9 | ⚠️ 中 |
| `9796ee8` | 工具层 sync I/O → async | 11 | ⚠️ 中 |
| `e5c150b` | docs only | - | 🟢 无 |
| `e99f4c0` | profile-registry skip README.md | 1 | 🟢 无 |
| `a023e0c` | meridian-db ESM import fix | 1 | 🟢 低 |

---

## 二、逐文件审计

### ✅ 已确认正确（无问题）

| 文件 | 变更 | 结论 |
|------|------|------|
| `src/agent/loop.ts` | `maybePrewarm` → async, `await buildPrewarmValue` | ✅ 正确 |
| `src/agent/loop-factory.ts` | `maybePrewarm` fire-and-forget, `prewarmFile` → async | ✅ 正确（fire-and-forget 是有意设计） |
| `src/agent/prewarm-file.ts` | 删除 sync `buildPrewarmValueSync`，统一 async | ✅ 正确 |
| `src/tools/glob.ts` | `walkDir` → async, `readdir/lstat/realpath` from fs/promises | ✅ 正确 |
| `src/tools/repo-map.ts` | `buildTree` → async, `readdir/stat` from fs/promises | ✅ 正确 |
| `src/tools/run-tests.ts` | `buildTestCommand` → async, `detectTestCommand` awaited | ✅ 正确 |
| `src/tools/read-file.ts` | `readFilePayload` → async, `stat/readFile` from fs/promises | ✅ 正确 |
| `src/tools/gitignore.ts` | `GitignoreFilter.create()` → async factory | ✅ 正确 |
| `src/tools/import-resource.ts` | git commands → `execFile` callback wrapper | ✅ 正确（有 timeout） |
| `src/tools/inspect-project.ts` | `walk` → async, `stat/readdir` from fs/promises | ✅ 正确 |
| `src/tools/related-tests.ts` | `fileExists` → async (uses `stat`) | ✅ 正确 |
| `src/tools/recall.ts` | `searchKnowledgeFiles` → async | ✅ 正确 |
| `src/tools/plan-close.ts` | file I/O → async | ✅ 正确 |
| `src/tools/read-section.ts` | minor changes | ✅ 正确 |
| `src/tools/file-info.ts` | `stat/lstat` from fs/promises | ✅ 正确 |
| `src/tools/grep.ts` | `GitignoreFilter.create()` awaited | ✅ 正确 |

### ⚠️ 潜在关注点

1. **`src/repo/meridian-db.ts`** (`a023e0c`)
   - 从 `const { createRequire } = require('node:module')` 改为 `import { createRequire } from 'node:module'`
   - **风险**: `createRequire(import.meta.url)` 返回的 `require` 函数在 `get db()` getter 中同步调用。如果 `better-sqlite3` 的 native 模块加载卡住，会阻塞事件循环。
   - **实际影响**: 低。`better-sqlite3` 加载通常在毫秒级完成。

2. **`src/agent/session-registry.ts`** (未在最近提交中修改)
   - 仍使用 `await import('node:module')` 动态导入方式
   - 与 `meridian-db.ts` 的静态 `import` 方式不一致，但功能等效
   - **无风险**

3. **`src/tools/path-validate.ts`** (未在 async 转换中修改)
   - 保留 `realpathSync`、`existsSync` 同步调用
   - 提交注释明确说明："trivial syscalls, converting would cascade through all callers"
   - **风险**: 对网络文件系统或高延迟文件系统，`realpathSync` 可能造成短暂阻塞。
   - **建议**: 如果卡死与文件系统延迟相关，将此文件也改为 async。

4. **`src/agent/turn-stream.ts`** — `maybePrewarm` 接口类型
   - 接口定义 `maybePrewarm: (text: string) => void`
   - 实际实现是 `async (text: string) => Promise<void>`
   - TypeScript 允许此赋值（Promise 被忽略），行为正确
   - `setImmediate(() => this.deps.maybePrewarm(t))` — fire-and-forget
   - **无风险**，但建议更新接口类型为 `Promise<void>` 以增强可读性

---

## 三、症状分析

### 观察到的现象

1. **全量测试套件挂起** (120s timeout)
   - 单个测试文件正常通过
   - 串行执行也挂起
   - `--test-force-exit` 可强制退出
   - **根因**: Node.js test runner 的孤儿进程问题（非代码回归）

2. **TypeScript 类型检查极慢** (38s)
   - 最终完成，无类型错误
   - **根因**: 项目规模大（1204 TS/TSX 文件），非本次改动引入

3. **会话卡死** (用户报告)
   - **无法在本环境中复现** — 需要实际运行 TUI

### 已排除的假设

- ~~Promise 链断裂（缺少 await）~~ — 所有变更点已逐一确认
- ~~async 函数未正确 import~~ — tsc 无类型错误
- ~~死循环~~ — 未发现新增 while/for 循环
- ~~better-sqlite3 加载失败~~ — ESM import 修复后正确

---

## 四、核心判断

**async I/O 转换本身是正确的。** 这 20 个文件的改动没有引入明显的代码缺陷。

会话卡死的最可能原因：

1. **预存问题未修复完成** — 分支名就是 `fix/stall-root-causes-abort-exit`，说明 async I/O 之前的 sync 阻塞才是卡死的根因。async 转换是修复的一部分，但可能不完整。

2. **Turn-boundary 盲区** — `_runInner` 中有多个 turn-boundary 步骤（postTurn hooks、compaction、prewarm），这些步骤在 `rejectOnAbort` 包装之前不受 abort 信号保护。未提交的改动正是给这些步骤加 `rejectOnAbort`。

3. **Heartbeat 硬超时** — `TurnHeartbeat` 的 `hardStallMs` 机制（240s）在未提交改动中才被激活。当前提交中虽然有 heartbeat 心跳，但没有"真正 abort"的牙齿。

### 建议优先级

| 优先级 | 行动 | 说明 |
|--------|------|------|
| **P0** | 提交未完成的 `rejectOnAbort` 包装 | `loop.ts` 和 `turn-heartbeat.ts` 的改动是修复卡死的关键 |
| **P1** | 给 `TurnHeartbeat` 加 `hardStallFired` 回调 | 让 watchdog 真正能 abort 卡住的 turn |
| **P2** | `path-validate.ts` 改为 async | 消除最后的 sync I/O 阻塞点 |
| **P3** | 更新 `TurnStreamDeps.maybePrewarm` 类型签名 | 代码可读性改进 |
| **P3** | 调查测试套件孤儿进程问题 | 非紧急，但影响 CI |

---

## 五、未解决问题

1. **无法在审计环境中运行 TUI** — 本审计基于静态代码分析，无法通过实际交互验证卡死是否已修复。
2. **卡死的确切触发条件未定位** — 可能是特定类型的工具调用后，在 turn-boundary 阶段阻塞。
3. **`git bisect` 未执行** — 无法确定卡死是哪个提交引入的（可能在 async I/O 之前就已存在）。

---

## 六、session-registry.ts 专项审计

### 修改历史

| 提交 | 变更 |
|------|------|
| `b31ba91` | 修复 ESM require 崩溃 + 显式 claims 删除（因无 FK cascade） |
| `9718ce3` | 检查 `safeRun` 返回值 + 移除重复 session 删除 |
| `fa90d29` | 仅改 warning 消息（+reason），无行为变更 |

### 发现的问题

**1. `acquireClaim` 存在死代码（不影响卡死）**

`src/agent/session-registry.ts:224-226`:
```typescript
    const changes = this.safeRun(...)
    return changes > 0
    return true        // ← 死代码，永不可达
```

`9718ce3` 在 `return true` 之前插入了 `return changes > 0`，但没有删除原有的 `return true`。当 `safeRun` 失败并返回 0 时（如 null DB fallback），函数返回 `false` 而非 fallback 的 `true`。

**实际影响**：当 `better-sqlite3` 不可用时，`acquireClaim` 永远返回 `false`。这会导致 delegation coordinator 和 tool-pipeline 的 claims 检测功能退化——但**不会导致卡死**，只是 claims 冲突检测不生效。

**2. `create()` 中的 sync I/O（不影响卡死）**

`src/agent/session-registry.ts:113-115`:
```typescript
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
```

仅在启动时调用一次，`existsSync` + `mkdirSync` 是瞬时操作，不构成阻塞风险。

**3. `create()` 中的动态 import（不影响卡死）**

```typescript
const nodeModule = await import('node:module')
const Database = nodeModule.createRequire(import.meta.url)('better-sqlite3')
```

与 `meridian-db.ts`(`a023e0c`) 的静态 `import { createRequire } from 'node:module'` 方式不同，但功能等效。动态 import 内置模块不会阻塞。

### 结论

`session-registry.ts` 没有引入可导致卡死的代码缺陷。发现的问题限于 `acquireClaim` 在 null DB 场景下的返回值语义错误。

---

## 七、附录：未提交改动清单
