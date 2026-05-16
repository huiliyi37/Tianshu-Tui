# Wave 3 + Wave 4: UX Polish + Ecosystem Extension

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Rivet 的日常使用体验达到 DeepSeek-TUI 级别（Vim 导航、@file 补全、命令面板、外部编辑器），并通过 Git worktree 隔离实现安全的并行会话。Wave 4 补充 Streaming JSON 输出、Composable CLI 管道、POST /prompt SSE 端点。

**架构：** Vim 模式作为 BaseTextInput 的可选 mode 层；@file 补全在 InputBar 中拦截 `@` 触发；命令面板为独立 Ink overlay 组件；外部编辑器通过 spawn $EDITOR 实现；worktree 通过 `git worktree add` 创建隔离副本。

**技术栈：** TypeScript, Ink 6, React, Node.js child_process, git CLI

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tui/vim-mode.ts` | Vim 模式状态机：normal/insert/visual + motion 命令 |
| `src/tui/file-completer.ts` | @file 自动补全：glob 扫描 + 模糊匹配 |
| `src/tui/command-palette.tsx` | Ctrl-K 命令面板：模糊搜索所有命令 |
| `src/tui/external-editor.ts` | Ctrl-O 外部编辑器：spawn $EDITOR，读回内容 |
| `src/agent/worktree.ts` | Git worktree 创建/清理/列表 |
| `src/server/prompt-route.ts` | POST /prompt SSE 端点 |
| `src/__tests__/vim-mode.test.ts` | Vim 模式测试 |
| `src/__tests__/file-completer.test.ts` | 文件补全测试 |
| `src/__tests__/command-palette.test.ts` | 命令面板测试 |
| `src/__tests__/external-editor.test.ts` | 外部编辑器测试 |
| `src/__tests__/worktree.test.ts` | Worktree 测试 |
| `src/__tests__/prompt-route.test.ts` | SSE prompt 端点测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/base-text-input.tsx` | 增加 vim mode 切换 + @file 触发 |
| `src/tui/input.tsx` | 集成 file-completer 下拉 |
| `src/tui/app.tsx` | Ctrl-K 打开命令面板，Ctrl-O 打开编辑器，/vim 命令 |
| `src/main.tsx` | --worktree 参数，--stream-json 输出格式 |
| `src/config/schema.ts` | 增加 vim/editor 配置 |
| `src/server/routes.ts` | 注册 POST /prompt 路由 |
| `src/headless.ts` | 增加 stream-json 输出模式 |

---

## Wave 3: UX Polish

## 任务 1：Vim Keybindings

### 任务 1.1：Vim 模式状态机

**文件：**
- 创建：`src/tui/vim-mode.ts`
- 测试：`src/__tests__/vim-mode.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/vim-mode.test.ts
import { describe, it, expect } from 'vitest'
import { VimState, processVimKey } from '../tui/vim-mode.js'

describe('VimState', () => {
  it('starts in insert mode', () => {
    const state = new VimState()
    expect(state.mode).toBe('insert')
  })

  it('Escape switches to normal mode', () => {
    const state = new VimState()
    const result = processVimKey(state, { key: 'escape' })
    expect(result.mode).toBe('normal')
  })

  it('i in normal mode switches to insert', () => {
    const state = new VimState('normal')
    const result = processVimKey(state, { key: 'i' })
    expect(result.mode).toBe('insert')
  })

  it('h/l moves cursor in normal mode', () => {
    const state = new VimState('normal', { cursor: 5, text: 'hello world' })
    const r1 = processVimKey(state, { key: 'h' })
    expect(r1.cursor).toBe(4)
    const r2 = processVimKey(state, { key: 'l' })
    expect(r2.cursor).toBe(6)
  })

  it('w moves to next word boundary', () => {
    const state = new VimState('normal', { cursor: 0, text: 'hello world foo' })
    const result = processVimKey(state, { key: 'w' })
    expect(result.cursor).toBe(6)
  })

  it('dd clears the line', () => {
    const state = new VimState('normal', { cursor: 3, text: 'hello world' })
    const result = processVimKey(state, { key: 'd', pending: 'd' })
    expect(result.text).toBe('')
    expect(result.cursor).toBe(0)
  })

  it('A moves to end and enters insert', () => {
    const state = new VimState('normal', { cursor: 0, text: 'hello' })
    const result = processVimKey(state, { key: 'A' })
    expect(result.mode).toBe('insert')
    expect(result.cursor).toBe(5)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test -- src/__tests__/vim-mode.test.ts`
预期：FAIL — module not found

- [ ] **步骤 3：实现 vim-mode.ts**

```typescript
// src/tui/vim-mode.ts
export type VimMode = 'normal' | 'insert' | 'visual'

export interface VimContext { cursor: number; text: string }

export class VimState {
  mode: VimMode
  cursor: number
  text: string
  pending: string

  constructor(mode: VimMode = 'insert', ctx?: Partial<VimContext>) {
    this.mode = mode
    this.cursor = ctx?.cursor ?? 0
    this.text = ctx?.text ?? ''
    this.pending = ''
  }
}

interface KeyEvent { key: string; pending?: string }

function nextWordBoundary(text: string, pos: number): number {
  let i = pos
  while (i < text.length && text[i] !== ' ') i++
  while (i < text.length && text[i] === ' ') i++
  return Math.min(i, text.length)
}

function prevWordBoundary(text: string, pos: number): number {
  let i = pos - 1
  while (i > 0 && text[i - 1] === ' ') i--
  while (i > 0 && text[i - 1] !== ' ') i--
  return Math.max(0, i)
}

export function processVimKey(state: VimState, event: KeyEvent): VimState {
  const s = { ...state }
  if (event.key === 'escape') { s.mode = 'normal'; s.pending = ''; return s }
  if (s.mode === 'insert') return s

  const { key } = event
  const pending = event.pending ?? s.pending

  if (key === 'i') { s.mode = 'insert'; return s }
  if (key === 'a') { s.mode = 'insert'; s.cursor = Math.min(s.cursor + 1, s.text.length); return s }
  if (key === 'A') { s.mode = 'insert'; s.cursor = s.text.length; return s }
  if (key === 'I') { s.mode = 'insert'; s.cursor = 0; return s }
  if (key === 'h') { s.cursor = Math.max(0, s.cursor - 1); return s }
  if (key === 'l') { s.cursor = Math.min(s.text.length - 1, s.cursor + 1); return s }
  if (key === '0') { s.cursor = 0; return s }
  if (key === '$') { s.cursor = Math.max(0, s.text.length - 1); return s }
  if (key === 'w') { s.cursor = nextWordBoundary(s.text, s.cursor); return s }
  if (key === 'b') { s.cursor = prevWordBoundary(s.text, s.cursor); return s }
  if (key === 'd' && pending === 'd') { s.text = ''; s.cursor = 0; s.pending = ''; return s }
  if (key === 'd') { s.pending = 'd'; return s }
  if (key === 'x') {
    s.text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1)
    s.cursor = Math.min(s.cursor, Math.max(0, s.text.length - 1))
    return s
  }
  s.pending = ''
  return s
}
```

- [ ] **步骤 4：运行测试验证通过**
- [ ] **步骤 5：Commit** `feat(tui): vim mode state machine`

---

### 任务 1.2：集成到 BaseTextInput + /vim 命令

**文件：**
- 修改：`src/tui/base-text-input.tsx`
- 修改：`src/tui/app.tsx`
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：config schema 增加 editor.vim 开关**
- [ ] **步骤 2：BaseTextInput 增加 vimEnabled prop，normal 模式拦截按键**
- [ ] **步骤 3：app.tsx 增加 /vim 命令切换**
- [ ] **步骤 4：运行全量测试**
- [ ] **步骤 5：Commit** `feat(tui): /vim toggle in input`

---

## 任务 2：@file 自动补全

### 任务 2.1：文件补全逻辑

**文件：**
- 创建：`src/tui/file-completer.ts`
- 测试：`src/__tests__/file-completer.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/file-completer.test.ts
import { describe, it, expect } from 'vitest'
import { getCompletions, extractAtToken } from '../tui/file-completer.js'

describe('extractAtToken', () => {
  it('extracts @-prefixed token at cursor', () => {
    expect(extractAtToken('fix @src/ma', 11)).toBe('src/ma')
    expect(extractAtToken('hello @', 7)).toBe('')
    expect(extractAtToken('no at here', 5)).toBeNull()
  })
})

describe('getCompletions', () => {
  it('returns matching files from cwd', () => {
    const results = getCompletions('src/tui/app', process.cwd(), 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toContain('src/tui/app')
  })

  it('limits results', () => {
    const results = getCompletions('src/', process.cwd(), 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

- [ ] **步骤 3：实现 file-completer.ts**

```typescript
// src/tui/file-completer.ts
import { execSync } from 'node:child_process'

export function extractAtToken(text: string, cursorPos: number): string | null {
  const before = text.slice(0, cursorPos)
  const match = before.match(/@([^\s]*)$/)
  return match ? match[1]! : null
}

export function getCompletions(partial: string, cwd: string, limit: number): string[] {
  try {
    const output = execSync('git ls-files --cached --others --exclude-standard', {
      cwd, encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lower = partial.toLowerCase()
    return output.trim().split('\n').filter(Boolean)
      .filter(f => f.toLowerCase().includes(lower))
      .sort((a, b) => {
        const aS = a.toLowerCase().startsWith(lower) ? 0 : 1
        const bS = b.toLowerCase().startsWith(lower) ? 0 : 1
        return aS - bS || a.length - b.length
      })
      .slice(0, limit)
  } catch { return [] }
}

export function applyCompletion(text: string, cursorPos: number, completion: string): { text: string; cursor: number } {
  const before = text.slice(0, cursorPos)
  const after = text.slice(cursorPos)
  const atIdx = before.lastIndexOf('@')
  const newText = before.slice(0, atIdx) + '@' + completion + ' ' + after
  return { text: newText, cursor: atIdx + 1 + completion.length + 1 }
}
```

- [ ] **步骤 4：运行测试验证通过**
- [ ] **步骤 5：Commit** `feat(tui): @file autocomplete logic`

---

### 任务 2.2：InputBar 集成补全下拉

**文件：**
- 修改：`src/tui/input.tsx`
- 修改：`src/tui/base-text-input.tsx`

- [ ] **步骤 1：InputBar 增加 completions state + onChange 中检测 @**
- [ ] **步骤 2：渲染补全列表 + Tab 选择**
- [ ] **步骤 3：运行全量测试**
- [ ] **步骤 4：Commit** `feat(tui): @file completion dropdown`

---

## 任务 3：命令面板 (Ctrl-K)

### 任务 3.1：命令面板组件

**文件：**
- 创建：`src/tui/command-palette.tsx`
- 测试：`src/__tests__/command-palette.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
// src/__tests__/command-palette.test.ts
import { describe, it, expect } from 'vitest'
import { filterCommands, type PaletteCommand } from '../tui/command-palette.js'

const COMMANDS: PaletteCommand[] = [
  { name: 'compact', description: 'Compact context' },
  { name: 'model', description: 'Switch model' },
  { name: 'cockpit', description: 'Open cockpit panel' },
  { name: 'clear', description: 'Clear conversation' },
  { name: 'context', description: 'Show context usage' },
]

describe('filterCommands', () => {
  it('returns all for empty query', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(5)
  })
  it('filters by prefix', () => {
    expect(filterCommands(COMMANDS, 'co').map(r => r.name)).toEqual(['compact', 'cockpit', 'context'])
  })
  it('fuzzy matches', () => {
    expect(filterCommands(COMMANDS, 'cpt').some(r => r.name === 'compact')).toBe(true)
  })
  it('matches description', () => {
    expect(filterCommands(COMMANDS, 'switch')[0]!.name).toBe('model')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**
- [ ] **步骤 3：实现 filterCommands (fuzzy subsequence match) + CommandPalette Ink 组件**
- [ ] **步骤 4：运行测试验证通过**
- [ ] **步骤 5：Commit** `feat(tui): command palette component`

### 任务 3.2：Ctrl-K 集成到 app.tsx

- [ ] **步骤 1：app.tsx useInput 增加 Ctrl-K → setShowPalette(true)**
- [ ] **步骤 2：JSX 中条件渲染 CommandPalette，onSelect 调 handleSlashCommand**
- [ ] **步骤 3：运行全量测试**
- [ ] **步骤 4：Commit** `feat(tui): Ctrl-K opens command palette`

---

## 任务 4：外部编辑器 (Ctrl-O)

### 任务 4.1：外部编辑器逻辑

**文件：**
- 创建：`src/tui/external-editor.ts`
- 测试：`src/__tests__/external-editor.test.ts`

- [ ] **步骤 1：编写测试 — getEditorCommand, createTempFile, readAndCleanup**
- [ ] **步骤 2：实现 external-editor.ts**

```typescript
// src/tui/external-editor.ts
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

export function getEditorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || 'vi'
}

export function createTempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-edit-'))
  const path = join(dir, 'RIVET_INPUT.md')
  writeFileSync(path, content)
  return path
}

export function readAndCleanup(path: string): string {
  const content = readFileSync(path, 'utf-8')
  unlinkSync(path)
  return content
}

export function openInEditor(initialContent: string): string | null {
  const path = createTempFile(initialContent)
  const editor = getEditorCommand()
  const result = spawnSync(editor, [path], { stdio: 'inherit' })
  if (result.status !== 0) return null
  return readAndCleanup(path)
}
```

- [ ] **步骤 3：运行测试验证通过**
- [ ] **步骤 4：Commit** `feat(tui): external editor support`

### 任务 4.2：Ctrl-O 集成到 app.tsx

- [ ] **步骤 1：useInput 中 Ctrl-O → setRawMode(false), openInEditor, setRawMode(true)**
- [ ] **步骤 2：运行全量测试**
- [ ] **步骤 3：Commit** `feat(tui): Ctrl-O opens external editor`

---

## 任务 5：Git Worktree 隔离

### 任务 5.1：Worktree 管理逻辑

**文件：**
- 创建：`src/agent/worktree.ts`
- 测试：`src/__tests__/worktree.test.ts`

- [ ] **步骤 1：编写测试 — parseWorktreeList, buildWorktreeArgs**

```typescript
// src/__tests__/worktree.test.ts
import { describe, it, expect } from 'vitest'
import { parseWorktreeList, buildWorktreeArgs } from '../agent/worktree.js'

describe('parseWorktreeList', () => {
  it('parses git worktree list output', () => {
    const output = `/Users/dev/project  abc1234 [main]\n/Users/dev/wt1  def5678 [feat-x]`
    const result = parseWorktreeList(output)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ path: '/Users/dev/project', commit: 'abc1234', branch: 'main' })
  })
})

describe('buildWorktreeArgs', () => {
  it('with branch', () => {
    expect(buildWorktreeArgs('/tmp/wt', 'session-abc')).toEqual(['worktree', 'add', '-b', 'session-abc', '/tmp/wt'])
  })
  it('detached', () => {
    expect(buildWorktreeArgs('/tmp/wt')).toEqual(['worktree', 'add', '--detach', '/tmp/wt'])
  })
})
```

- [ ] **步骤 2：实现 worktree.ts**

```typescript
// src/agent/worktree.ts
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface WorktreeEntry { path: string; commit: string; branch: string }

export function parseWorktreeList(output: string): WorktreeEntry[] {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const m = line.match(/^(\S+)\s+(\w+)\s+\[(.+?)\]/)
    return m ? { path: m[1]!, commit: m[2]!, branch: m[3]! } : null
  }).filter((e): e is WorktreeEntry => e !== null)
}

export function buildWorktreeArgs(path: string, branch?: string): string[] {
  return branch ? ['worktree', 'add', '-b', branch, path] : ['worktree', 'add', '--detach', path]
}

export function createWorktree(cwd: string, sessionId: string): string {
  const wtPath = mkdtempSync(join(tmpdir(), `rivet-wt-${sessionId.slice(0, 8)}-`))
  const args = buildWorktreeArgs(wtPath, `rivet-session-${sessionId.slice(0, 8)}`)
  execSync(`git ${args.join(' ')}`, { cwd, stdio: 'pipe' })
  return wtPath
}

export function removeWorktree(cwd: string, wtPath: string): void {
  execSync(`git worktree remove --force "${wtPath}"`, { cwd, stdio: 'pipe' })
}

export function listWorktrees(cwd: string): WorktreeEntry[] {
  const output = execSync('git worktree list', { cwd, encoding: 'utf-8', stdio: 'pipe' })
  return parseWorktreeList(output)
}
```

- [ ] **步骤 3：运行测试验证通过**
- [ ] **步骤 4：Commit** `feat(agent): git worktree management`

### 任务 5.2：--worktree CLI 参数集成

- [ ] **步骤 1：main.tsx 增加 --worktree 参数 → createWorktree + chdir**
- [ ] **步骤 2：gracefulShutdown 中 removeWorktree 清理**
- [ ] **步骤 3：运行全量测试**
- [ ] **步骤 4：Commit** `feat(cli): --worktree flag for isolated sessions`

---

## Wave 4: Ecosystem Extension

## 任务 6：Streaming JSON 输出

### 任务 6.1：--stream-json 格式

**文件：**
- 修改：`src/headless.ts`

- [ ] **步骤 1：HeadlessCliArgs 增加 streamJson 字段**
- [ ] **步骤 2：runHeadless 中 streamJson 路径 — 每个 callback 写 NDJSON 到 stdout**
- [ ] **步骤 3：运行测试**
- [ ] **步骤 4：Commit** `feat(cli): --stream-json NDJSON event output`

---

## 任务 7：POST /prompt SSE 端点

### 任务 7.1：prompt 路由实现

**文件：**
- 创建：`src/server/prompt-route.ts`
- 测试：`src/__tests__/prompt-route.test.ts`

- [ ] **步骤 1：编写测试 — 400 if no prompt, 200 with SSE headers**
- [ ] **步骤 2：实现 buildPromptHandler — 接收 prompt，运行 agent，收集 SSE events**
- [ ] **步骤 3：运行测试验证通过**
- [ ] **步骤 4：Commit** `feat(server): POST /prompt SSE endpoint`

### 任务 7.2：注册到 server routes

- [ ] **步骤 1：routes.ts createRoutes 接受 agentFactory 参数，注册 POST /prompt**
- [ ] **步骤 2：main.tsx serve 分支传入 agentFactory**
- [ ] **步骤 3：运行全量测试**
- [ ] **步骤 4：Commit** `feat(server): wire POST /prompt into rivet serve`

---

## 任务 8：Composable CLI 管道

### 任务 8.1：stdin 管道检测 + 自动格式

**文件：**
- 修改：`src/main.tsx`

- [ ] **步骤 1：检测 !process.stdin.isTTY → 从 stdin 读取 prompt**
- [ ] **步骤 2：!process.stdout.isTTY 时自动切换 json 输出**
- [ ] **步骤 3：运行测试**
- [ ] **步骤 4：Commit** `feat(cli): composable pipe support — auto-detect TTY`

---

## 自检

### 规格覆盖度

| 设计文档需求 | 对应任务 |
|-------------|---------|
| Vim keybindings | 任务 1.1 + 1.2 |
| @file 自动补全 | 任务 2.1 + 2.2 |
| 命令面板 (Ctrl-K) | 任务 3.1 + 3.2 |
| 外部编辑器 (Ctrl-O) | 任务 4.1 + 4.2 |
| Git worktree 隔离 | 任务 5.1 + 5.2 |
| Streaming JSON output | 任务 6.1 |
| POST /prompt SSE | 任务 7.1 + 7.2 |
| Composable CLI | 任务 8.1 |

### 执行顺序建议

1. **任务 1-5（Wave 3）可并行** — 互不依赖
2. **任务 6 依赖 headless.ts**（Wave 1 已完成）
3. **任务 7 依赖 server/**（Wave 2 已完成）
4. **任务 8 依赖任务 6**（stream-json 格式）

### 总计

- **8 个任务，14 个子任务，59 个步骤**
- Wave 3（任务 1-5）：Vim / @file / Ctrl-K / Ctrl-O / Worktree
- Wave 4（任务 6-8）：Stream JSON / POST /prompt / Composable CLI
- Wave 3: 5 模块 10 子任务
- Wave 4: 3 模块 4 子任务
