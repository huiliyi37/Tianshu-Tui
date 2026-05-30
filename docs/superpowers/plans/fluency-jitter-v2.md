# 流畅度优化 v2 · 后台偷帧 + 渲染抖动（S12-S16）实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除流式期间主线程同步读盘/写盘造成的间歇卡顿，平滑终端 resize 重排与 thinking spinner。

**架构：** prewarm 读盘用 `setImmediate` 移出流式回调栈；compactOai replace 路径增加异步原子写变体；terminal resize 加 32ms 节流（leading+trailing）；thinking spinner 改 120ms 多帧 braille 旋转。S15 经逐一核实无需改动（既有守卫已覆盖）。关键设计决策——所有改动均为"最小侵入"：仅修改接缝层（`turn-stream.ts`、`session-persist.ts`、`use-terminal-size.ts`、`thinking.tsx`），不重构核心 loop 闭包。

**技术栈：** TypeScript、Ink 6、node:test + tsx。测试命令 `npx tsx --test <file>`，类型检查 `npm run typecheck`。

**⚠️ 跨计划冲突提示：** S12 修改 `src/agent/turn-stream.ts` 的 `onToolCallHint`，与簇一（静默窗口）S1 改的是同一回调。若两簇都执行，**S1 与 S12 的 `onToolCallHint` 改动需合并**（S1 加 `onToolHint?.()` 转发，S12 把 `prewarmFile` 调用包进 `setImmediate`）——合并后形如：先同步 `input.callbacks.onToolHint?.(toolName)`，再 `setImmediate(() => prewarmFile(fp))`。执行时若两簇有交集，以最后执行者负责合并。

---

## v1 → v2 优化说明

| 项目 | v1 问题 | v2 修正 |
|------|---------|---------|
| S12 测试 | 未 await `setImmediate` 回调，测试在 `streamTurn` resolve 后立即检查 order，`prewarm-ran` 尚未入队 | 添加 `await new Promise(r => setImmediate(r))` 等待微任务队列排空 |
| S13 行号 | 标注 `loop.ts:479-480`，实际 `compactOai` 调用在 `:470` | 修正为 `:470`（已核实） |
| S13 代码 | `writeChain.then(() => persist.compactOaiAsync(...))` 缺少 `await`，`compactOaiAsync` 返回 Promise 但 `.then()` 返回的链未 await | 改为 `writeChain = writeChain.then(() => persist.compactOaiAsync(m.messages))` 保持与 append 分支一致的链式写法（同步写入变异步写入不改变链语义） |
| S14 测试 | 声称"新建" `use-terminal-size.test.ts`，但该文件已存在（含 `getTerminalSizeSnapshot` 快照测试） | 改为**追加**到已有文件，不覆盖现有测试 |
| S16 性能 | 120ms timer 每次都调 `setElapsed(Date.now() - startRef.current)` 触发 React re-render，但 elapsed 显示精度仅秒级 | 添加秒级变化守卫：`const newElapsed = startRef.current > 0 ? Date.now() - startRef.current : 0`；`if (Math.floor(newElapsed / 1000) !== Math.floor(elapsed / 1000)) setElapsed(newElapsed)`，frame 每 120ms 更新、elapsed 仅在秒变时更新 |

---

## 范围检查

本计划涉及 4 个独立子系统，每个任务独立可测、可独立提交：

1. **流式回调延迟**（S12）→ `turn-stream.ts` 接缝层
2. **持久化异步化**（S13）→ `fs-atomic.ts` + `session-persist.ts` + `loop.ts` listener
3. **resize 节流**（S14）→ `use-terminal-size.ts` subscribe 层
4. **spinner 平滑**（S16）→ 新建 `braille-spinner.ts` + `thinking.tsx` 改造
5. **错拍计时器**（S15）→ 经核实无改动，标记关闭

无跨任务文件冲突（除 S12/S1 的 `turn-stream.ts` 已在头部标注）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/agent/turn-stream.ts` | 修改 | `onToolCallHint` 和 `maybePrewarm` 触发延迟化 |
| `src/agent/__tests__/turn-stream.test.ts` | 追加 | S12 setImmediate 延迟验证测试 |
| `src/fs-atomic.ts` | 修改 | 新增 `writeFileAtomicAsync` |
| `src/agent/session-persist.ts` | 修改 | 新增 `compactOaiAsync` |
| `src/agent/loop.ts:470` | 修改 | listener replace 分支改用 `compactOaiAsync` |
| `src/__tests__/fs-atomic.test.ts` | 创建 | `writeFileAtomicAsync` 原子写测试 |
| `src/tui/use-terminal-size.ts` | 修改 | 新增 `createThrottledResizeHandler` + subscribe 改用节流 |
| `src/tui/__tests__/use-terminal-size.test.ts` | 追加 | 节流合并测试（**不覆盖现有快照测试**） |
| `src/tui/braille-spinner.ts` | 创建 | 纯函数 `brailleSpinnerFrame` |
| `src/tui/thinking.tsx` | 修改 | spinner 从 2 帧/2s 改为多帧/120ms，elapsed 秒级守卫 |
| `src/tui/__tests__/braille-spinner.test.ts` | 创建 | braille 帧循环测试 |

---

## 调研背书

### S12：`prewarmFile` / `maybePrewarm` 同步调用链

- **调用方**：`turn-stream.ts:64` `this.deps.maybePrewarm(text)`、`:119` `this.deps.prewarmFile?.(partialArgs.file_path)`
- **最终阻塞点**：`prewarm-file.ts:22` `readFilePayload(cwd, { filePath })` → `read-file.ts:185` `statSync` → `:197` `readFileSync`（≤100KB）
- **loop.ts 中 `prewarmFile` 闭包**（`:490-493`）：`const value = buildPrewarmValue(this.cwd, filePath)` 直接同步调用
- **`maybePrewarm` 闭包**（`:488`）：`this.maybePrewarm(text)` → `extractIntents` → `buildPrewarmValue`
- **接缝选择理由**：改 `turn-stream.ts` 而非 `loop.ts` 闭包，因为 TurnStreamController 是被测模块，依赖注入为纯 stub，改接缝不侵入 loop 闭包
- **边缘风险**：`setImmediate` 后若 abort 触发，prewarm 回调可能访问已关闭的资源。但 prewarm 是纯读盘+缓存写入，无副作用，abort 后执行安全。
- **`readFilePayload` 深度同步且被工具实际读取复用**：改异步风险大（YAGNI），故仅延迟触发时机。

### S13：`compactOai` 同步全量重写

- **调用方**：`loop.ts:470` listener replace 分支（`persist.compactOai(m.messages)`）
- **阻塞链**：`session-persist.ts:211-214` → `writeFileAtomicSync` → `writeFileSync` + `renameSync`
- **append 分支已是异步**：`appendOaiWithChecksum` 使用 `appendFile`（异步 Promise）
- **边缘风险**：`compactOaiAsync` 与 `appendOaiWithChecksum` 通过 `writeChain` 序列化，无并发写冲突。旧同步 API `compactOai` 保留不变，不影响非 listener 调用方。

### S14：terminal resize 无节流

- **调用方**：`use-terminal-size.ts:11` `process.stdout.on('resize', cb)`，7 处 viewport-aware 组件通过 `useSyncExternalStore` 订阅
- **现有保护**：`getTerminalSizeSnapshot` 已做快照缓存（引用相等），但每次 resize 事件仍触发 React re-render
- **边缘风险**：节流期间 terminal 真正变化了尺寸但回调延迟。32ms trailing 保证最终一致性，且 Ink 的下一帧自然使用最新 `process.stdout.rows/columns`。

### S15：错拍计时器（核实结论）

- `app.tsx:386` activity interval（1000ms）→ **已有** `if (!isStreaming) return`
- `app.tsx:413` fluency interval（2000ms）→ **已有** `if (!isStreaming) return`
- `thinking.tsx:148` spinner interval → **已有** `if (!isStreaming) return`，改进归入 S16
- `base-text-input.tsx:74` 光标闪烁（530ms）→ **已有** `if (disabled) return`
- **结论：无需改动。** 强行造统一 tick 总线属过度工程。

### S16：thinking spinner 2 帧/2s

- **现状**：`thinking.tsx:148` interval 2000ms；`:163` `const spinner = elapsed % 2000 < 1000 ? '⠋' : '⠙'`
- **调用方**：仅 ThinkingCollapser 组件内使用
- **边缘风险**：120ms timer 在 `isStreaming` 为 true 时运行，组件卸载时 `clearInterval` 清理。无内存泄漏。

---

## 任务

### 任务 S12：流式回调中同步 readFileSync 阻塞 → setImmediate 移出热路径

- [ ] **步骤 1：写失败测试**

追加到 `src/agent/__tests__/turn-stream.test.ts`（文件末尾 `describe` 块内）：

```ts
  it('defers prewarmFile off the streaming callback via setImmediate (S12)', async () => {
    const order: string[] = []
    const stubClient: StreamClient = {
      async stream(_req: OaiChatRequest, cb: StreamCallbacks) {
        cb.onToolCallHint?.('read_file', { file_path: 'src/a.ts' })
        order.push('after-hint-sync')
      },
    } as unknown as StreamClient
    const controller = new TurnStreamController({
      client: stubClient, abortSignal: new AbortController().signal,
      getStreamedTextLength: () => 0, appendStreamedText: () => {},
      getLastPrewarmAt: () => 0, setLastPrewarmAt: () => {}, maybePrewarm: () => {},
      prewarmFile: () => { order.push('prewarm-ran') },
      addUsage: () => {}, recordTurnCache: () => {},
    })
    await controller.streamTurn({
      request: {} as OaiChatRequest, turn: 1, lastTurnTextFingerprint: '',
      callbacks: { onTextDelta: () => {}, onThinkingDelta: () => {}, onToolUse: () => {}, onError: () => {} },
    })
    // setImmediate 回调在 await streamTurn resolve 之后才排入事件循环
    // 需要等待一个微任务周期让 setImmediate 回调执行
    await new Promise(r => setImmediate(r))
    assert.equal(order[0], 'after-hint-sync')
    assert.ok(order.includes('prewarm-ran'), 'prewarm should still eventually run')
    assert.ok(order.indexOf('after-hint-sync') < order.indexOf('prewarm-ran'))
  })
```

> 注：`TurnStreamController` 构造参数以该文件现有 `makeController` 的 `TurnStreamDeps` 为准。此处不用 `makeController` 因为需要独立注入 `prewarmFile`。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/turn-stream.test.ts`
预期：FAIL。现状 `prewarmFile` 同步调用，`prewarm-ran` 排在 `after-hint-sync` 之前。

- [ ] **步骤 3：写最小实现**

修改 `src/agent/turn-stream.ts` `onToolCallHint`（约 117-119）：

```ts
      onToolCallHint: (toolName, partialArgs) => {
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          const fp = partialArgs.file_path
          setImmediate(() => this.deps.prewarmFile?.(fp))
        }
      },
```

修改 `src/agent/turn-stream.ts` 流式 prewarm 触发（约 64-67）：

```ts
          if (this.deps.getStreamedTextLength() - this.deps.getLastPrewarmAt() >= 500) {
            this.deps.setLastPrewarmAt(this.deps.getStreamedTextLength())
            const t = text
            setImmediate(() => this.deps.maybePrewarm(t))
          }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/agent/__tests__/turn-stream.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/agent/turn-stream.ts src/agent/__tests__/turn-stream.test.ts
git commit -m "perf(turn-stream): defer prewarm disk reads off streaming callback (S12)"
```

---

### 任务 S13：compactOai replace 同步全量重写阻塞 → 异步原子写变体

- [ ] **步骤 1：写失败测试**

创建 `src/__tests__/fs-atomic.test.ts`：

```ts
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomicAsync } from '../fs-atomic.js'

describe('writeFileAtomicAsync (S13)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-atomic-')) })
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('writes data atomically and leaves no tmp file', async () => {
    const fp = join(dir, 'session.jsonl')
    await writeFileAtomicAsync(fp, 'line1\nline2\n')
    assert.equal(readFileSync(fp, 'utf-8'), 'line1\nline2\n')
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
  })
  it('overwrites existing file content', async () => {
    const fp = join(dir, 'session.jsonl')
    writeFileSync(fp, 'old')
    await writeFileAtomicAsync(fp, 'new')
    assert.equal(readFileSync(fp, 'utf-8'), 'new')
  })
  it('creates missing parent directory', async () => {
    const fp = join(dir, 'nested', 'deep', 'f.json')
    await writeFileAtomicAsync(fp, '{}')
    assert.equal(readFileSync(fp, 'utf-8'), '{}')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/__tests__/fs-atomic.test.ts`
预期：FAIL。`does not provide an export named 'writeFileAtomicAsync'`。

- [ ] **步骤 3：写最小实现**

`src/fs-atomic.ts` 顶部 import 增加：

```ts
import { mkdir } from 'node:fs/promises'
```

在 `writeFileAtomicSync` 函数之后新增异步变体：

```ts
/**
 * Async version of writeFileAtomicSync — avoids blocking the event loop
 * during large session rewrites (compaction/reset).
 */
export async function writeFileAtomicAsync(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const suffix = randomUUID().slice(0, 8)
  const tmpPath = filePath + '.' + suffix + '.tmp'
  try {
    const { writeFile: writeFileAsync, rename: renameAsync, unlink: unlinkAsync } = await import('node:fs/promises')
    await writeFileAsync(tmpPath, data, 'utf-8')
    await renameAsync(tmpPath, filePath)
  } catch (err) {
    try {
      const { unlink: unlinkAsync } = await import('node:fs/promises')
      await unlinkAsync(tmpPath)
    } catch { /* ignore cleanup failure */ }
    throw err
  }
}
```

> 注：使用动态 `import('node:fs/promises')` 避免顶部混合 sync/async 导入的代码风格不一致。也可改为顶部 `import { writeFile, rename, unlink } from 'node:fs/promises'`——两者等价，实现者自选。

`src/agent/session-persist.ts`：顶部 import 改为：

```ts
import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'
```

在 `compactOai` 方法（约 211-214）后新增：

```ts
  /** Async atomic compaction — avoids blocking the agent loop on full rewrites (S13). */
  async compactOaiAsync(messages: OaiMessage[]): Promise<void> {
    const content = messages.map(m => appendChecksum(serializeOaiSessionMessage(m))).join('\n') + '\n'
    await writeFileAtomicAsync(this.filePath, content)
  }
```

`src/agent/loop.ts` listener replace 分支（约 470）改为：

```ts
          writeChain = writeChain
            .then(() => persist.compactOaiAsync(m.messages))
```

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
npx tsx --test src/__tests__/fs-atomic.test.ts
npx tsx --test src/agent/__tests__/session-persist.test.ts
npm run typecheck
```
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/fs-atomic.ts src/agent/session-persist.ts src/agent/loop.ts src/__tests__/fs-atomic.test.ts
git commit -m "perf(persist): async atomic rewrite for compactOai replace path (S13)"
```

---

### 任务 S14：终端 resize 无防抖 → subscribe 中 32ms 节流

- [ ] **步骤 1：写失败测试**

**追加**到已有文件 `src/tui/__tests__/use-terminal-size.test.ts`（不覆盖现有 `getTerminalSizeSnapshot` 测试）：

```ts
import { createThrottledResizeHandler } from '../use-terminal-size.js'

describe('createThrottledResizeHandler (S14)', () => {
  it('coalesces a burst of calls into far fewer invocations', async () => {
    let calls = 0
    const h = createThrottledResizeHandler(() => { calls++ }, 32)
    for (let i = 0; i < 20; i++) h()
    await new Promise(r => setTimeout(r, 60))
    h.cancel()
    assert.ok(calls <= 3, `20 rapid calls should coalesce to <=3, got ${calls}`)
    assert.ok(calls >= 1, 'should fire at least once')
  })
})
```

> 注：`import { createThrottledResizeHandler }` 需要添加到文件顶部的 import 语句中（与已有的 `getTerminalSizeSnapshot` import 合并）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/use-terminal-size.test.ts`
预期：FAIL。`does not provide an export named 'createThrottledResizeHandler'`。

- [ ] **步骤 3：写最小实现**

`src/tui/use-terminal-size.ts` 新增节流 helper（leading+trailing）：

```ts
type ThrottledHandler = (() => void) & { cancel: () => void }

export function createThrottledResizeHandler(cb: () => void, delayMs: number): ThrottledHandler {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const handler = (() => {
    const now = Date.now()
    if (now - last >= delayMs) {
      last = now
      cb()
    } else if (timer === null) {
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        cb()
      }, delayMs - (now - last))
    }
  }) as ThrottledHandler
  handler.cancel = () => { if (timer !== null) { clearTimeout(timer); timer = null } }
  return handler
}
```

`subscribe`（现 10-13）改为：

```ts
function subscribe(cb: () => void) {
  const throttled = createThrottledResizeHandler(cb, 32)
  process.stdout.on('resize', throttled)
  return () => { throttled.cancel(); process.stdout.off('resize', throttled) }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/use-terminal-size.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/use-terminal-size.ts src/tui/__tests__/use-terminal-size.test.ts
git commit -m "perf(tui): throttle terminal resize to coalesce re-renders (S14)"
```

---

### 任务 S15：错拍计时器对齐 —— 经核实为「无改动」（诚实结论）

> **原 S15 假设**的"4 个计时器无守卫错拍重绘"经逐一核实**大部分不成立**：
> - `app.tsx:386` activity interval（1000ms）**已有** `if (!isStreaming) return`
> - `app.tsx:413` fluency interval（2000ms）**已有** `if (!isStreaming) return`
> - `thinking.tsx:148` spinner interval（2000ms）**已有** `if (!isStreaming) return`，改进归入 S16
> - `base-text-input.tsx:74` 光标闪烁（530ms）**已有** `if (disabled) return`
>
> 既有守卫已覆盖。强行造统一 tick 总线属过度工程（YAGNI）。**无代码改动。**

- [ ] **步骤 1：记录核实结论（无代码改动）**

可选复核命令：

```bash
grep -n "if (!isStreaming) return\|if (disabled) return" src/tui/app.tsx src/tui/thinking.tsx src/tui/base-text-input.tsx
```

预期：app.tsx / thinking.tsx 的 interval 守卫存在；base-text-input 的 disabled 守卫存在。S15 关闭。

---

### 任务 S16：thinking spinner 2 帧/2 秒像卡死 → 多帧 braille 平滑旋转

- [ ] **步骤 1：写失败测试**

创建 `src/tui/__tests__/braille-spinner.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brailleSpinnerFrame } from '../braille-spinner.js'

describe('brailleSpinnerFrame (S16)', () => {
  it('cycles through multiple distinct braille frames', () => {
    const frames = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(brailleSpinnerFrame))
    assert.ok(frames.size >= 6, `expected >=6 distinct frames, got ${frames.size}`)
  })
  it('wraps around the frame index', () => {
    assert.equal(brailleSpinnerFrame(0), brailleSpinnerFrame(10_000_000))
  })
  it('returns a single braille char', () => {
    assert.match(brailleSpinnerFrame(3), /^[⠀-⣿]$/)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/braille-spinner.test.ts`
预期：FAIL。`Cannot find module '../braille-spinner.js'`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/braille-spinner.ts`：

```ts
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Smooth braille spinner frame for a monotonically increasing tick index (S16). */
export function brailleSpinnerFrame(tick: number): string {
  return FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length]!
}
```

修改 `src/tui/thinking.tsx`：

顶部添加 import：

```ts
import { brailleSpinnerFrame } from './braille-spinner.js'
```

在 ThinkingCollapser 组件内（约 107 行 `const [elapsed, setElapsed] = useState(0)` 后）新增 frame state：

```ts
  const [frame, setFrame] = useState(0)
```

替换 2000ms interval（约 148-155）为 120ms 统一 timer，frame 每 120ms 推进，elapsed 仅在秒变时更新：

```ts
  useEffect(() => {
    if (!isStreaming) return
    const id = setInterval(() => {
      setFrame(f => f + 1)
      if (startRef.current > 0) {
        const newElapsed = Date.now() - startRef.current
        if (Math.floor(newElapsed / 1000) !== Math.floor(elapsed / 1000)) {
          setElapsed(newElapsed)
        }
      }
    }, 120)
    return () => clearInterval(id)
  }, [isStreaming, elapsed])
```

> 注：`elapsed` 加入 deps 是因为闭包读取 `elapsed` 来做秒级比较。`setFrame` 和 `setElapsed` 是 React setState 稳定引用，无需列入 deps。

替换 spinner 取值（约 163）：

```ts
  const spinner = brailleSpinnerFrame(frame)
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/braille-spinner.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/braille-spinner.ts src/tui/thinking.tsx src/tui/__tests__/braille-spinner.test.ts
git commit -m "fix(tui): smooth multi-frame braille thinking spinner (S16)"
```

---

## 验证

### 全局验证命令

```bash
# 类型检查
npm run typecheck

# 全量测试
npx tsx --test src/agent/__tests__/turn-stream.test.ts
npx tsx --test src/__tests__/fs-atomic.test.ts
npx tsx --test src/tui/__tests__/use-terminal-size.test.ts
npx tsx --test src/tui/__tests__/braille-spinner.test.ts
```

### 预期结果

| 命令 | 预期 |
|------|------|
| `npm run typecheck` | exit 0，无类型错误 |
| `turn-stream.test.ts` | 全部 PASS，含新增 S12 延迟测试 |
| `fs-atomic.test.ts` | 全部 PASS，含原子写、覆盖、自动建目录 |
| `use-terminal-size.test.ts` | 全部 PASS，含原有快照测试 + 新增节流合并测试 |
| `braille-spinner.test.ts` | 全部 PASS，帧循环、wrap-around、单字符 |

---

## 自检

- **Spec 覆盖度：** S12（prewarm setImmediate）→ 任务 S12 ✅ | S13（compactOaiAsync）→ 任务 S13 ✅ | S14（resize 节流）→ 任务 S14 ✅ | S15（无改动）→ 任务 S15 ✅ | S16（多帧 spinner）→ 任务 S16 ✅。五项全覆盖。
- **占位符扫描：** 无 TODO / TBD / 待定 / 后续实现 / 补充细节。每个步骤含具体代码或精确编辑描述。
- **类型一致性：** `writeFileAtomicAsync(filePath: string, data: string): Promise<void>`（S13）/ `compactOaiAsync(messages: OaiMessage[]): Promise<void>`（S13）/ `createThrottledResizeHandler(cb: () => void, delayMs: number): ThrottledHandler`（S14）/ `brailleSpinnerFrame(tick: number): string`（S16）签名跨步骤一致。
- **已核实边缘：** S12 `setImmediate` 后 abort 安全（纯读盘无副作用）；S13 `writeChain` 序列化无并发写；S14 trailing 保证最终一致性；S16 `elapsed` deps 引入闭包一致性。
- **跨计划冲突：** S12 与簇一 S1 同改 `turn-stream.ts:onToolCallHint`，已在头部标注合并方式。
- **诚实标注：** S15 经核实为无改动项，未编造改动以凑数。

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/fluency-jitter-v2.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. **内联执行** — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
