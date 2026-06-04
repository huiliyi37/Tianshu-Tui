# 流畅度优化 · 簇二：输出节奏（S5-S7）实现计划

> **状态：✅ 已全部实施** — Fluency rhythm 策略 (fluency-policy.ts)

**目标：** 让流式输出文本平滑逐句流动、慢流也有稳定心跳、回答定稿瞬间无布局跳变。

**架构：** 调整 `BlockStreamWriter` 的分块策略（降低 maxChars + 句末标点 break + 缩短 idle），并让流式渲染与定稿渲染共用 `<Markdown>` 路径以消除切换点。

**技术栈：** TypeScript、Ink、node:test + tsx。测试命令 `npx tsx --test <file>`，类型检查 `npm run typecheck`。

**注意：** S5 与 S6 都改 `src/tui/block-stream-writer.ts:8-13` 同一个 `DEFAULT_CONFIG` 对象的不同字段（maxChars vs idleMs），互不冲突。按 S5→S6→S7 顺序实现。

---

### 任务 S5：BlockStreamWriter 憋到 maxChars(600) 才吐块，文本大段蹦出

现状：`src/tui/block-stream-writer.ts` `DEFAULT_CONFIG.maxChars = 600`（第10行）；`checkEmit()`（第57-79行）只在 `buffer.length >= maxChars`（第62行）时切块，否则仅在 `lastIndexOf('\n\n')` 段落 break（第73行）时吐。`findBreakPoint`（第92-100行）优先级 `\n\n` → `\n` → 空格，**无句末标点 break**。一段无空行无换行的长文（中文连续叙述）会憋到 600 字符才整块蹦出。

修法（最小）：`maxChars` 降到 200，并在 `checkEmit()` 未达 maxChars 的分支新增「句末标点 break」。

**文件：**
- 修改：`src/tui/block-stream-writer.ts`（第10行 `maxChars`；第73-78行 `checkEmit` 段落 break 段；第100行后新增 `findSentenceEnd`）
- 测试：`src/tui/__tests__/block-stream-writer.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/tui/__tests__/block-stream-writer.test.ts` 的 `describe` 块内，紧接现有 `it('handles empty chunks'...)` 之后：

```ts
  it('emits at a sentence-ending punctuation before reaching maxChars', () => {
    const sentenceWriter = new BlockStreamWriter({}, (text) => { emitted.push(text) })
    const first = '这是一段连续不断的中文叙述用来验证句末标点切块行为正确无误啊'
    sentenceWriter.push(first + '。' + '后面还有更多内容继续追加进来填充缓冲区')
    assert.ok(emitted.length >= 1, 'should emit on sentence punctuation')
    assert.ok(emitted[0]!.endsWith('。'), `block should end at 。 but got: ${emitted[0]}`)
    assert.ok(!emitted[0]!.includes('后面还有'), 'should not include post-punctuation tail')
  })

  it('default maxChars is lowered to 200', () => {
    const big = new BlockStreamWriter({}, (text) => { emitted.push(text) })
    big.push('字'.repeat(650))
    assert.ok(emitted.length >= 2, 'long unbroken text must be chunked, not held to 600')
    assert.ok(emitted.every(b => b.length <= 200), `each block <= 200, got: ${emitted.map(b => b.length)}`)
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/block-stream-writer.test.ts`
预期：FAIL。`emits at a sentence-ending punctuation` 失败于 `should emit on sentence punctuation`（47 字 < 旧 maxChars 600 且无 `\n\n`，`emitted.length` 为 0）；`default maxChars is lowered to 200` 失败于 `every(b => b.length <= 200)`（旧 maxChars=600，首块 ≈600 > 200）。

- [ ] **步骤 3：写最小实现**

`src/tui/block-stream-writer.ts` 第8-13行改 `maxChars`：

```ts
const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 100,
  maxChars: 200,
  idleMs: 500,
  maxBufferSize: 64 * 1024,
}
```

`src/tui/block-stream-writer.ts` 第73-78行（`checkEmit` 内、maxChars 分支之后的段落 break 段），替换为：

```ts
    const paraIdx = this.buffer.lastIndexOf('\n\n')
    if (paraIdx !== -1 && paraIdx >= Math.floor(this.config.minChars * 0.5)) {
      const block = this.buffer.slice(0, paraIdx + 2)
      this.buffer = this.buffer.slice(paraIdx + 2)
      this.enqueue(block)
      return
    }

    const sentIdx = this.findSentenceEnd(this.buffer)
    if (sentIdx !== -1) {
      const block = this.buffer.slice(0, sentIdx + 1)
      this.buffer = this.buffer.slice(sentIdx + 1)
      this.enqueue(block)
    }
```

在 `findBreakPoint`（第100行 `}` 之后）新增私有方法：

```ts
  private findSentenceEnd(text: string): number {
    // 句末标点（中英文）：。！？.!?；; 取最后一个出现位置作为切点
    let last = -1
    for (let i = 0; i < text.length; i++) {
      if ('。！？.!?；;'.includes(text[i]!)) last = i
    }
    return last
  }
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/block-stream-writer.test.ts && npm run typecheck`
预期：PASS，typecheck 无错误。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/block-stream-writer.ts src/tui/__tests__/block-stream-writer.test.ts
git commit -m "fix(stream): chunk at sentence boundaries and lower maxChars to 200 (S5)"
```

---

### 任务 S6：idleMs(500) 在慢流上憋很久突然吐

现状：`src/tui/block-stream-writer.ts:11` `idleMs: 500`。`push()` 每次 `resetIdleTimer()`（第32、45-48行）。当 token 以略快于 500ms 的间隔滴入，idle timer 永不触发，文字一直卡在 buffer，直到 200 字符或一次真正停顿才涌出。

修法（最小）：`idleMs` 下调到 180，让慢流有稳定心跳。

**文件：**
- 修改：`src/tui/block-stream-writer.ts`（第11行 `idleMs`）
- 测试：`src/tui/__tests__/block-stream-writer.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

追加到 `src/tui/__tests__/block-stream-writer.test.ts` 的 `describe` 块内：

```ts
  it('flushes a short buffer after the idle window (<=200ms)', async () => {
    const w = new BlockStreamWriter({}, (text) => { emitted.push(text) })
    w.push('短句无标点也无换行')
    assert.equal(emitted.length, 0, 'nothing emitted synchronously below minChars')
    await new Promise(r => setTimeout(r, 220))
    assert.equal(emitted.length, 1, 'idle flush must fire within ~200ms')
    assert.equal(emitted[0], '短句无标点也无换行')
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/block-stream-writer.test.ts`
预期：FAIL。等待 220ms 时旧 `idleMs=500` 尚未触发，`emitted.length` 为 0，断言 `idle flush must fire within ~200ms` 失败（0 !== 1）。

- [ ] **步骤 3：写最小实现**

`src/tui/block-stream-writer.ts` 第8-13行 `DEFAULT_CONFIG` 改 `idleMs`：

```ts
const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 100,
  maxChars: 200,
  idleMs: 180,
  maxBufferSize: 64 * 1024,
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx tsx --test src/tui/__tests__/block-stream-writer.test.ts && npm run typecheck`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/block-stream-writer.ts src/tui/__tests__/block-stream-writer.test.ts
git commit -m "fix(stream): lower idle flush window to 180ms for steady slow-stream cadence (S6)"
```

### 任务 S7：定稿瞬间从纯 Text 切到 Markdown 导致布局突变

现状（已核实）：
- `src/tui/stream.tsx:36` `const textWithCursor = isStreaming ? displayText + '▊' : displayText`；第48-54行流式用 `<Text>{textWithCursor}</Text>`，定稿用 `<Markdown text={textWithCursor} />`。
- `src/tui/markdown-render.tsx:511` `hasMd` 内联表达式（未导出），第512-513行 fast-path：无 md 标记时返回纯 `<Text>`；`parseBlocks` 已在第505行 `useMemo` 无条件运行。
- 流式末帧纯 `<Text>`（无 code block 边框），定稿帧切 `<Markdown>` 给 code block 加边框/padding → 行数/缩进突变（视觉"跳一下"）。

修法（最小，YAGNI）：让 `StreamOutput` 流式期间也走 `<Markdown>`，消除切换点。fast-path 保证无 md 文本仍退化为纯 Text（无额外开销/边框）。光标 `▊` 不能拼进 markdown 文本（污染解析），改为 `<Markdown>` 后独立 `<Text>` 渲染。

**文件：**
- 修改：`src/tui/stream.tsx`（第36行光标拼接、第48-54行渲染分支）
- 修改：`src/tui/markdown-render.tsx`（第503行前抽出并导出 `hasMarkdown`，第511行复用）
- 测试：`src/tui/__tests__/markdown-render.test.ts`（追加 fast-path 一致性断言）

> 说明：项目无 `ink-testing-library`，渲染输出无法直接断言（既有测试约定测纯函数，见 `stream-window.test.ts`）。S7 的可测缝是 `Markdown` 的 fast-path：流式与定稿共用同一 `Markdown`，对"无 md 文本"必须退化为纯 Text。结构性改动由 `npm run typecheck` + 既有 `stream.test.tsx` 守护。

- [ ] **步骤 1：写失败测试**

在 `src/tui/__tests__/markdown-render.test.ts` 追加：

```ts
import { hasMarkdown } from '../markdown-render.js'

describe('hasMarkdown fast-path (S7 stream/final parity)', () => {
  it('plain prose has no markdown so streaming renders as plain Text', () => {
    assert.equal(hasMarkdown('这是一段没有任何标记的普通中文叙述'), false)
    assert.equal(hasMarkdown('plain english line with no markup'), false)
  })

  it('detects code fences so code blocks render identically while streaming and final', () => {
    assert.equal(hasMarkdown('text\n```ts\nconst x = 1\n```'), true)
    assert.equal(hasMarkdown('inline `code` here'), true)
    assert.equal(hasMarkdown('# heading'), true)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx tsx --test src/tui/__tests__/markdown-render.test.ts`
预期：FAIL。导入即报 `The requested module '../markdown-render.js' does not provide an export named 'hasMarkdown'`。

- [ ] **步骤 3：写最小实现**

`src/tui/markdown-render.tsx` 第503行（`export const Markdown` 之前）新增导出：

```ts
export function hasMarkdown(text: string): boolean {
  return text.includes('**') || text.includes('`') || text.includes('```')
    || /^#{1,6}\s/m.test(text) || /^[-*]\s/m.test(text) || /^>\s/m.test(text)
}
```

第511行替换为复用：

```ts
  const hasMd = hasMarkdown(text)
```

`src/tui/stream.tsx` 第36行替换（光标不再拼进文本）：

```ts
  const displayWithCursor = displayText
```

第48-54行替换为统一 `<Markdown>` + 独立光标：

```ts
        <Box flexDirection="column" paddingLeft={2}>
          <Markdown text={isStreaming ? displayWithCursor : displayText} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
```

（`Markdown` 与 `Text` 均已在第1、3行 import，无需新增。删除原 `textWithCursor` 变量与 `+ '▊'` 拼接。）

- [ ] **步骤 4：运行测试验证通过**

运行：
```bash
npx tsx --test src/tui/__tests__/markdown-render.test.ts
npx tsx --test src/tui/__tests__/stream.test.tsx
npm run typecheck
```
预期：PASS。`hasMarkdown` 用例通过；`stream.test.tsx` 仍通过；typecheck 无错误。

- [ ] **步骤 5：Commit**

```bash
git add src/tui/stream.tsx src/tui/markdown-render.tsx src/tui/__tests__/markdown-render.test.ts
git commit -m "fix(stream): render Markdown during streaming to remove final-frame layout jump (S7)"
```

---

## 自检结果

- **覆盖度：** S5（句末标点 break + maxChars 200）、S6（idleMs 180）、S7（流式 Markdown）三任务齐全。
- **类型一致性：** `BlockStreamWriter`、`hasMarkdown`、`Markdown` 签名跨任务一致。
- **顺序依赖：** S5→S6 都改 `DEFAULT_CONFIG`（不同字段）；S6 实现块含完整 config（已含 S5 的 maxChars=200），按序提交时 diff 只动 idleMs 一行。S7 独立。
- **已知约束：** 无 `ink-testing-library`，S7 测纯函数 fast-path（项目既有约定）。
