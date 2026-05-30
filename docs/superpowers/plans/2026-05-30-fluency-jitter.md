# 流畅度优化 · 簇四：后台偷帧 + 渲染抖动（S12-S16）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除流式期间主线程同步读盘/写盘造成的间歇卡顿，平滑终端 resize 重排与 thinking spinner。

**架构：** prewarm 读盘用 `setImmediate` 移出流式回调栈；compactOai replace 路径增加异步原子写变体；terminal resize 加节流；thinking spinner 改多帧平滑。S15 经核实大部分计时器已有 `!isStreaming` 守卫，仅保留实际可改的部分。

**技术栈：** TypeScript、Ink、node:test + tsx。测试命令 `npx tsx --test <file>`，类型检查 `npm run typecheck`。

**⚠️ 跨计划冲突提示：** S12 修改 `src/agent/turn-stream.ts` 的 `onToolCallHint`，与簇一（静默窗口）S1 改的是同一回调。若两簇都执行，**S1 与 S12 的 `onToolCallHint` 改动需合并**（S1 加 `onToolHint?.()` 转发，S12 把 `prewarmFile` 调用包进 `setImmediate`）——合并后形如：先同步 `input.callbacks.onToolHint?.(toolName)`，再 `setImmediate(() => prewarmFile(fp))`。执行时若两簇有交集，以最后执行者负责合并。

---

### 任务 S12：流式回调中同步 readFileSync 阻塞 → setImmediate 移出热路径

现状：`turn-stream.ts:69` `onTextDelta` 调 `maybePrewarm(text)`，`:113` `onToolCallHint` 调 `prewarmFile`，最终在 `loop.ts:702`/`:500` 同步 `buildPrewarmValue` → `read-file.ts:197` `readFileSync`+`statSync`（≤100KB）。这是 SSE 流式回调栈里同步读盘，卡主线程偷帧。`readFilePayload` 深度同步且被工具实际读取复用，改异步风险大（YAGNI）。最小修法：把 prewarm 触发包进 `setImmediate`，让流式回调立即返回。接缝放在 `turn-stream.ts`（被测模块，依赖注入为纯 stub），`loop.ts` 闭包不改。

**文件：**
- 修改：`src/agent/turn-stream.ts`（`onToolCallHint` 111-115；流式 prewarm 触发 67-70）
- 测试：`src/agent/__tests__/turn-stream.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/agent/__tests__/turn-stream.test.ts`：

```ts
  it('does not run prewarmFile synchronously inside the stream callback (S12)', async () => {
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
    assert.equal(order[0], 'after-hint-sync')
    assert.ok(order.includes('prewarm-ran'), 'prewarm should still eventually run')
    assert.ok(order.indexOf('after-hint-sync') < order.indexOf('prewarm-ran'))
  })
```

> 注：`TurnStreamController` 构造参数以该文件现有用例的 `TurnStreamDeps` 为准补齐。

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/agent/__tests__/turn-stream.test.ts`
预期：FAIL。现状 `prewarmFile` 同步调用，`prewarm-ran` 排在 `after-hint-sync` 之前，`AssertionError: order.indexOf('after-hint-sync') < order.indexOf('prewarm-ran')`。

- [ ] **步骤 3：写最小实现**

`src/agent/turn-stream.ts` `onToolCallHint`（111-115）：

```ts
      onToolCallHint: (toolName, partialArgs) => {
        if (toolName === 'read_file' && typeof partialArgs.file_path === 'string') {
          const fp = partialArgs.file_path
          setImmediate(() => this.deps.prewarmFile?.(fp))
        }
      },
```

`src/agent/turn-stream.ts` 流式 prewarm 触发（67-70）：

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

### 任务 S13：compactOai replace 同步全量重写阻塞 → 异步原子写变体

现状（已核实）：`loop.ts:480` listener `replace` 分支调 `persist.compactOai(m.messages)`（同步）→ `session-persist.ts:211-214` `content = messages.map(m => appendChecksum(serializeOaiSessionMessage(m))).join('\n')+'\n'` → `writeFileAtomicSync(this.filePath, content)`（`fs-atomic.ts` 同步 writeFileSync+renameSync）。`append` 分支已是异步 `appendFile`。replace 稀少（compaction/reset）但全量重写整文件，同步卡主线程。最小修法：`fs-atomic.ts` 加 `writeFileAtomicAsync`，`session-persist.ts` 加 `compactOaiAsync`，listener 改用之。保留旧同步 API（`compact()` 等仍用）。

**文件：**
- 修改：`src/fs-atomic.ts`（新增 `writeFileAtomicAsync`）
- 修改：`src/agent/session-persist.ts`（新增 `compactOaiAsync`，211-214 后）
- 修改：`src/agent/loop.ts`（listener replace 分支 479-480）
- 测试：`src/__tests__/fs-atomic.test.ts`（不存在则创建）

- [ ] **步骤 1：写失败测试**

创建/追加 `src/__tests__/fs-atomic.test.ts`：

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
预期：FAIL。`does not provide an export named 'writeFileAtomicAsync'`（导入即失败）。

- [ ] **步骤 3：写最小实现**

`src/fs-atomic.ts` 顶部 import 增加，并在 `writeFileAtomicSync` 后新增异步变体：

```ts
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises'
```

```ts
export async function writeFileAtomicAsync(filePath: string, data: string): Promise<void> {
  const dir = dirname(filePath)
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  const suffix = randomUUID().slice(0, 8)
  const tmpPath = filePath + '.' + suffix + '.tmp'
  try {
    await writeFile(tmpPath, data, 'utf-8')
    await rename(tmpPath, filePath)
  } catch (err) {
    try { await unlink(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}
```

`src/agent/session-persist.ts`：import 改为 `import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'`，在 `compactOai`（214）后新增（body 与同步版逐字一致，仅写入改 await）：

```ts
  /** Async atomic compaction — avoids blocking the agent loop on full rewrites (S13). */
  async compactOaiAsync(messages: OaiMessage[]): Promise<void> {
    const content = messages.map(m => appendChecksum(serializeOaiSessionMessage(m))).join('\n') + '\n'
    await writeFileAtomicAsync(this.filePath, content)
  }
```

`src/agent/loop.ts` listener replace 分支（479-480）改为：

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

### 任务 S14：终端 resize 无防抖 → subscribe 中节流

现状（已核实）：`use-terminal-size.ts:11` `process.stdout.on('resize', cb)` 直连无节流。`useSyncExternalStore` 把每个 resize 立即转 re-render，7 处 viewport-aware 组件随之重算行数 + Markdown 重 parse。拖拽窗口时事件成串爆发，画面剧烈抖动。修法：`subscribe` 里对 resize 回调加 ~32ms 节流（trailing）。

**文件：**
- 修改：`src/tui/use-terminal-size.ts`（新增节流 helper + `subscribe` 用之）
- 测试：`src/tui/__tests__/use-terminal-size.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/use-terminal-size.test.ts`：

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/use-terminal-size.test.ts`
预期：FAIL。`does not provide an export named 'createThrottledResizeHandler'`。

- [ ] **步骤 3：写最小实现**

`src/tui/use-terminal-size.ts` 新增节流 helper（leading+trailing）并在 `subscribe` 使用：

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

### 任务 S15：错拍计时器对齐 —— 经核实为「基本无改动」（诚实结论）

> **重要诚实结论：** 原 S15 假设的"4 个计时器无守卫错拍重绘"经逐一核实**大部分不成立**：
> - `app.tsx:386` activity interval（1000ms）**已有** `if (!isStreaming) return` 守卫。
> - `app.tsx:413` fluency interval（2000ms）**已有** `if (!isStreaming) return` 守卫。
> - `thinking.tsx:146` spinner interval（2000ms）**已有** `if (!isStreaming) return`，且其改进归入 S16。
> - `base-text-input.tsx:74-78` 光标闪烁（530ms）**已有** `if (disabled) return`；且经核实该组件**无** `focused`/`hasFocus` prop（props 为 value/onChange/onSubmit/disabled/placeholder/history/vimEnabled/onTabComplete/isSlashMode/slashSelectedIdx/slashFilteredCount/onSlashNavigate）。
>
> 因此 S15 **不产出代码改动**——既有 `!isStreaming`/`disabled` 守卫已覆盖描述的重绘问题，强行造统一 tick 总线属过度工程（违反 YAGNI）。本任务标记为 **已验证无需改动**，无 TDD 步骤。真正的 spinner 平滑见 S16。

- [ ] **步骤 1：记录核实结论（无代码改动）**

确认上述四处守卫现状（可选复核命令）：

```bash
grep -n "if (!isStreaming) return\|if (disabled) return" src/tui/app.tsx src/tui/thinking.tsx src/tui/base-text-input.tsx
grep -n "focused\|hasFocus" src/tui/base-text-input.tsx
```

预期：app.tsx / thinking.tsx 的 interval 守卫存在；base-text-input 无 focus prop。S15 至此关闭，进入 S16。

---

### 任务 S16：thinking spinner 2 帧/2 秒像卡死 → 多帧 braille 平滑旋转

现状（已核实）：`thinking.tsx:147-153` interval 2000ms；`:163` `const spinner = elapsed % 2000 < 1000 ? '⠋' : '⠙'`（仅 2 帧、2 秒周期，看着像卡死）。修法：用多帧 braille 序列 + 单一 120ms timer 同时推进 frame 与 elapsed（替换原 2000ms timer，不新增 timer）；仅重绘 collapsed 单行 `<Text>`，elapsed 文本仍按秒级显示故无文本闪烁，仅 spinner 字符 120ms 平滑旋转。

**文件：**
- 创建：`src/tui/braille-spinner.ts`（纯函数 `brailleSpinnerFrame`）
- 修改：`src/tui/thinking.tsx`（106 区字段、145-153 interval、163 spinner）
- 测试：`src/tui/__tests__/braille-spinner.test.ts`（新建）

- [ ] **步骤 1：写失败测试**

新建 `src/tui/__tests__/braille-spinner.test.ts`：

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
预期：FAIL。`does not provide an export named 'brailleSpinnerFrame'`。

- [ ] **步骤 3：写最小实现**

新建 `src/tui/braille-spinner.ts`：

```ts
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Smooth braille spinner frame for a monotonically increasing tick index (S16). */
export function brailleSpinnerFrame(tick: number): string {
  return FRAMES[((tick % FRAMES.length) + FRAMES.length) % FRAMES.length]!
}
```

`src/tui/thinking.tsx`：组件内新增 `const [frame, setFrame] = useState(0)`（紧邻 `const [elapsed, setElapsed] = useState(0)`）。把 145-153 interval 由 2000ms 改 120ms，单 timer 同时推进 frame 与 elapsed：

```ts
  useEffect(() => {
    if (!isStreaming) return
    const id = setInterval(() => {
      setFrame(f => f + 1)
      if (startRef.current > 0) setElapsed(Date.now() - startRef.current)
    }, 120)
    return () => clearInterval(id)
  }, [isStreaming])
```

第 163 行 spinner 取值改为（顶部 import `brailleSpinnerFrame`）：

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

## 自检结果

- **覆盖度：** S12（prewarm setImmediate）、S13（compactOaiAsync）、S14（resize 节流）、S15（**验证无需改动**）、S16（多帧 spinner）五项齐全。
- **类型一致性：** `writeFileAtomicAsync(filePath, data)`（S13）/`compactOaiAsync(messages)`（S13）/`createThrottledResizeHandler(cb, delayMs)`（S14）/`brailleSpinnerFrame(tick)`（S16）签名跨步骤一致。
- **已核实：** `compactOai` 内部确为 `appendChecksum(serializeOaiSessionMessage(m))` + `this.filePath`，`compactOaiAsync` body 与之逐字对应；`thinking.tsx:163` spinner 现状确为 2 帧三元。
- **跨计划冲突：** S12 与簇一 S1 同改 `turn-stream.ts:onToolCallHint`，已在头部标注合并方式。
- **诚实标注：** S15 经核实为无改动项（既有守卫已覆盖），未编造改动以凑数。

