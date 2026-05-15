# Rivet P2.2 Capability Reliability Layer 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 P2.1 已建成的工具、性能和开发能力，从“功能存在”提升到“可信、可验证、可回滚、可比较、可复现”。

**架构：** P2.2 分两层推进：先修复 P2.1 审查发现的 hard gate，恢复测试基线并封住工具边界与 rollback 风险；再新增能力可靠性层，包括 verification engine、repo intelligence v2、workspace safety v2、model capability routing 和 failure sample library。所有高风险能力都必须有测试先行、证据状态和最终验证命令。

**技术栈：** TypeScript 5.7、Node.js 22、node:test、tsx、Ink 6、React 19、tsup、DeepSeek Anthropic-compatible SSE API。

---

## 背景

P2.1 已完成主要建设：新增 `glob`、`grep`、`diff`、`run_tests`、`inspect_project`、`repo_map`、`related_tests` 等工具，并加入 checkpoint/rollback、failure classifier、evidence badge、非阻塞 volatile git、token accounting、TUI 批处理和 cache debug 能力。

审查后发现 P2.1 仍存在发布阻塞和能力可信度问题：

1. `npm test` 仍因 `tsx` 缺失失败。
2. `glob` / `grep` 缺少 cwd 边界校验，可能读取项目外路径。
3. 当前 checkpoint 只记录 `HEAD`，rollback 可能删除用户任务前已有未提交改动。
4. `microCompact()` 对 context window 的判断只看 middle tokens，可能返回仍超窗的消息集。
5. `run_tests(filter=...)` 的 filter 很可能没有真正传给 test runner。
6. 测试失败时没有进入 Evidence badge，最终报告可能不可信。
7. raw output 文件名直接使用 `toolUseId`，需要路径安全处理。
8. TUI `/verbose` 与 tool flush 存在状态一致性问题。

P2.2 先关闭这些 hard gate，再建设下一层开发能力。

---

## 范围与拆分说明

P2.2 覆盖多个子系统，但它们服务于同一个能力目标：让 Rivet 的开发任务闭环变得可信。执行时必须按顺序推进：

1. **任务 1-8：Hard Gate。** 修复 P2.1 审查阻塞；未完成前不要开始新能力。
2. **任务 9-12：Capability Layer。** 新增 verification、repo intelligence、workspace safety、model capability routing、failure sample library。
3. **任务 13：全量验证。** 以测试、构建、手动 TUI 验证和失败样本生成收口。

每个任务都能独立提交；不要把多个任务塞进一个提交。

---

## 文件结构

### 修改现有文件

- `package.json` — 添加 `tsx` devDependency，恢复测试基线。
- `package-lock.json` — 锁定 `tsx`。
- `src/tools/path-validate.ts` — 扩展通用 cwd 边界校验，供读类工具复用。
- `src/tools/glob.ts` — 使用 cwd 边界校验、realpath/symlink 防循环、结果上限。
- `src/tools/grep.ts` — 使用 cwd 边界校验、全局结果上限、ripgrep streaming cap、native symlink 防循环。
- `src/tools/diff.ts` — path 参数走统一边界校验。
- `src/tools/run-tests.ts` — 改为安全 argv 构造，确保 filter 生效，并输出结构化 verification metadata。
- `src/tools/output-store.ts` — raw output 文件名改为 hash/UUID，禁止 toolUseId 参与路径。
- `src/tools/types.ts` — 扩展 `ToolResult`，承载 `verification` metadata。
- `src/agent/checkpoint.ts` — checkpoint v2：保存任务开始前 dirty snapshot、agent touched files、confirmation token；rollback 只处理 agent-owned changes。
- `src/agent/loop.ts` — 记录 agent-touched files、记录 failed/blocked test evidence、接入 verification state。
- `src/agent/evidence.ts` — Evidence badge 支持 passed/failed/blocked/not-run，区分 targeted/full verification。
- `src/compact/micro.ts` — 修正 token 判断，使用传入的增量估算值。
- `src/compact/__tests__/compact.test.ts` — 更新 cache anchor 保留后的期望。
- `src/tui/app.tsx` — 修复 `/verbose` stale state 和 tool flush name capture。
- `src/main.tsx` — 可选：piped stdin 改 async 读取，避免启动前阻塞。
- `README.md` — 补充 P2.2 capability reliability layer 的用户可见能力。

### 创建新文件

- `src/agent/verification.ts` — Verification state、结果类型、最终报告约束。
- `src/agent/__tests__/verification.test.ts` — Verification engine 单测。
- `src/repo/symbol-index.ts` — 轻量 symbol index，解析 function/class/type/export 名称。
- `src/repo/import-graph.ts` — 轻量 import graph，记录 file imports/importedBy。
- `src/repo/context-bundle.ts` — task context bundle，聚合相关文件、符号、测试、风险提示。
- `src/repo/__tests__/symbol-index.test.ts` — symbol index 单测。
- `src/repo/__tests__/import-graph.test.ts` — import graph 单测。
- `src/repo/__tests__/context-bundle.test.ts` — context bundle 单测。
- `src/model/capability.ts` — model capability card 与 routing policy。
- `src/model/__tests__/capability.test.ts` — model routing 单测。
- `src/failures/sample.ts` — failure sample 目录生成、redaction、metadata。
- `src/failures/__tests__/sample.test.ts` — failure sample 单测。

### 测试文件补充

- `src/tools/__tests__/glob.test.ts` — 增加拒绝 `..`、绝对路径逃逸、symlink cycle。
- `src/tools/__tests__/grep.test.ts` — 增加拒绝 `..`、绝对路径逃逸、全局 max_results、symlink cycle。
- `src/tools/__tests__/diff.test.ts` — 增加 path escape 测试。
- `src/tools/__tests__/run-tests.test.ts` — 增加 filter command 生效、failed metadata、blocked metadata。
- `src/tools/__tests__/output-store.test.ts` — 增加 unsafe toolUseId 不逃逸 RAW_DIR。
- `src/agent/__tests__/checkpoint.test.ts` — 增加 dirty worktree、pre-existing untracked、agent-owned rollback 测试。
- `src/agent/__tests__/loop.test.ts` — 增加 failed test evidence 与 checkpoint touched file 测试。
- `src/tui/__tests__/log-state.test.ts` — 如可覆盖 tool flush helper，则增加 per-id toolName 测试。

---

## 任务 1：恢复测试基线

**文件：**
- 修改：`package.json:47-52`
- 修改：`package-lock.json`

- [ ] **步骤 1：编写失败验证**

运行：

```bash
npm test
```

预期：FAIL，当前错误为：

```text
sh: tsx: command not found
```

- [ ] **步骤 2：添加 `tsx` devDependency**

运行：

```bash
npm install -D tsx@^4.20.5
```

预期：`package.json` 的 `devDependencies` 包含：

```json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.2.14",
    "tsx": "^4.20.5",
    "tsup": "^8.4.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **步骤 3：运行测试确认测试命令可执行**

运行：

```bash
npm test
```

预期：`tsx` 不再缺失。若有业务测试失败，保留失败输出给后续任务修复；不要因为单测失败改 test script。

- [ ] **步骤 4：运行类型检查和构建**

运行：

```bash
npm run typecheck
npm run build
```

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(test): add tsx test runner dependency"
```

---

## 任务 2：统一读类工具 cwd 边界校验

**文件：**
- 修改：`src/tools/path-validate.ts`
- 修改：`src/tools/glob.ts`
- 修改：`src/tools/grep.ts`
- 修改：`src/tools/diff.ts`
- 测试：`src/tools/__tests__/glob.test.ts`
- 测试：`src/tools/__tests__/grep.test.ts`
- 测试：`src/tools/__tests__/diff.test.ts`

- [ ] **步骤 1：为 `glob` 写失败测试**

在 `src/tools/__tests__/glob.test.ts` 添加：

```typescript
it('rejects parent directory traversal in search path', async () => {
  const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.ts', path: '..' }))
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project directory/i)
})

it('rejects absolute paths outside cwd', async () => {
  const result = await GLOB_TOOL.execute(makeParams({ pattern: '*.ts', path: tmpdir() }))
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project directory/i)
})
```

- [ ] **步骤 2：为 `grep` 写失败测试**

在 `src/tools/__tests__/grep.test.ts` 添加：

```typescript
it('rejects parent directory traversal in search path', async () => {
  const result = await GREP_TOOL.execute(makeParams({ pattern: 'secret', path: '..' }))
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project directory/i)
})

it('rejects absolute paths outside cwd', async () => {
  const result = await GREP_TOOL.execute(makeParams({ pattern: 'secret', path: tmpdir() }))
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project directory/i)
})
```

- [ ] **步骤 3：为 `diff` 写失败测试**

在 `src/tools/__tests__/diff.test.ts` 添加：

```typescript
it('rejects path traversal outside cwd', async () => {
  const result = await DIFF_TOOL.execute(makeParams({ path: '../outside.ts' }))
  assert.equal(result.isError, true)
  assert.match(result.content, /outside project directory/i)
})
```

- [ ] **步骤 4：运行失败测试**

运行：

```bash
npx tsx --test src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts src/tools/__tests__/diff.test.ts
```

预期：新增测试 FAIL，因为工具当前未统一使用 cwd 边界校验。

- [ ] **步骤 5：扩展 `path-validate.ts`**

将 `src/tools/path-validate.ts` 调整为同时支持文件和目录路径：

```typescript
import { isAbsolute, relative, resolve } from 'path'

export interface ValidatedPath {
  ok: true
  path: string
}

export interface InvalidPath {
  ok: false
  error: string
}

export type PathValidationResult = ValidatedPath | InvalidPath

export function validatePath(cwd: string, inputPath: string): PathValidationResult {
  const resolved = resolve(cwd, inputPath)
  const rel = relative(cwd, resolved)

  if (rel === '') {
    return { ok: true, path: resolved }
  }

  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `Path outside project directory: ${inputPath}` }
  }

  return { ok: true, path: resolved }
}
```

如果现有调用方依赖旧字段名，保持兼容包装：

```typescript
export function validatePathOrThrow(cwd: string, inputPath: string): string {
  const result = validatePath(cwd, inputPath)
  if (!result.ok) throw new Error(result.error)
  return result.path
}
```

- [ ] **步骤 6：接入 `glob.ts`**

在 `src/tools/glob.ts` 中替换 search root 解析逻辑：

```typescript
import { validatePath } from './path-validate.js'

const requestedRoot = params.input.path ? String(params.input.path) : '.'
const validated = validatePath(params.cwd, requestedRoot)
if (!validated.ok) {
  return { content: `Error: ${validated.error}`, isError: true }
}
const searchRoot = validated.path
```

保留后续 `existsSync(searchRoot)` 和 `statSync(searchRoot).isDirectory()` 检查。

- [ ] **步骤 7：接入 `grep.ts`**

在 `src/tools/grep.ts` 中替换 `absPath` 解析逻辑：

```typescript
import { validatePath } from './path-validate.js'

const searchPath = (params.input.path as string) ?? '.'
const validated = validatePath(params.cwd, searchPath)
if (!validated.ok) {
  return { content: `Error: ${validated.error}`, isError: true }
}
const absPath = validated.path
```

- [ ] **步骤 8：接入 `diff.ts`**

在 `src/tools/diff.ts` 中替换当前 `path.replace()` 清洗：

```typescript
import { relative } from 'path'
import { validatePath } from './path-validate.js'

if (path) {
  const validated = validatePath(params.cwd, path)
  if (!validated.ok) {
    return { content: `Error: ${validated.error}`, isError: true }
  }
  args.push('--', relative(params.cwd, validated.path))
}
```

- [ ] **步骤 9：运行测试确认通过**

运行：

```bash
npx tsx --test src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts src/tools/__tests__/diff.test.ts src/tools/__tests__/path-validate.test.ts
```

预期：PASS。

- [ ] **步骤 10：Commit**

```bash
git add src/tools/path-validate.ts src/tools/glob.ts src/tools/grep.ts src/tools/diff.ts src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts src/tools/__tests__/diff.test.ts
git commit -m "fix(tools): enforce project path boundaries"
```

---

## 任务 3：修复 traversal、symlink cycle 和搜索输出上限

**文件：**
- 修改：`src/tools/glob.ts`
- 修改：`src/tools/grep.ts`
- 测试：`src/tools/__tests__/glob.test.ts`
- 测试：`src/tools/__tests__/grep.test.ts`

- [ ] **步骤 1：为 `glob` symlink cycle 写测试**

在 `src/tools/__tests__/glob.test.ts` 顶部补充导入：

```typescript
import { symlinkSync } from 'fs'
```

添加测试：

```typescript
it('does not follow symlink cycles', async () => {
  const loopDir = mkdtempSync(join(tmpdir(), 'glob-loop-'))
  try {
    mkdirSync(join(loopDir, 'a'), { recursive: true })
    writeFileSync(join(loopDir, 'a', 'file.ts'), '')
    symlinkSync(loopDir, join(loopDir, 'a', 'loop'), 'dir')

    const result = await GLOB_TOOL.execute({
      input: { pattern: '**/*.ts' },
      toolUseId: 'test',
      cwd: loopDir,
    })

    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('a/file.ts'))
  } finally {
    rmSync(loopDir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 2：为 `grep` 全局 max_results 写测试**

在 `src/tools/__tests__/grep.test.ts` 添加：

```typescript
it('enforces max_results globally', async () => {
  const manyDir = mkdtempSync(join(tmpdir(), 'grep-many-'))
  try {
    mkdirSync(join(manyDir, 'src'), { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(manyDir, 'src', `f${i}.ts`), 'MATCH\nMATCH\nMATCH\n')
    }

    const result = await GREP_TOOL.execute({
      input: { pattern: 'MATCH', path: 'src', max_results: 3, literal: true },
      toolUseId: 'test',
      cwd: manyDir,
    })

    const matches = result.content.split('\n').filter(line => line.includes('MATCH'))
    assert.ok(matches.length <= 3, `expected <= 3 matches, got ${matches.length}`)
  } finally {
    rmSync(manyDir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 3：运行失败测试**

```bash
npx tsx --test src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts
```

预期：FAIL，当前 walker 没有 realpath cycle 保护，ripgrep 输出也不是严格全局 cap。

- [ ] **步骤 4：修复 `glob` walker**

在 `src/tools/glob.ts` 使用 `lstatSync` + `realpathSync`，不要跟随 symlink 目录：

```typescript
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'fs'

function walkDir(
  dir: string,
  results: string[],
  root: string,
  filter: RegExp | undefined,
  visited = new Set<string>(),
): void {
  if (results.length >= MAX_RESULTS) return

  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: ReturnType<typeof lstatSync>
    try {
      s = lstatSync(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      walkDir(fullPath, results, root, filter, visited)
    } else if (s.isFile()) {
      const rel = relative(root, fullPath)
      if (!filter || filter.test(rel)) results.push(rel)
    }
  }
}
```

- [ ] **步骤 5：修复 `grep` native walker**

在 `src/tools/grep.ts` 使用 `lstat` / `realpath`：

```typescript
import { lstat, readdir, realpath, stat } from 'fs/promises'

async function walk(dir: string): Promise<void> {
  if (results.length >= maxResults) return

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= maxResults) return
    const fullPath = join(dir, entry.name)
    const s = await lstat(fullPath).catch(() => null)
    if (!s || s.isSymbolicLink()) continue

    if (s.isDirectory()) {
      await walk(fullPath)
    } else if (s.isFile()) {
      const relPath = relative(cwd, fullPath)
      if (filter.isIgnored(cwd, fullPath)) continue
      if (globRegex && !globRegex.test(entry.name)) continue
      const matched = await searchFile(fullPath, regex, maxResults - results.length)
      for (const line of matched) {
        results.push(`${relPath}:${line}`)
        if (results.length >= maxResults) return
      }
    }
  }
}
```

同时调整 `searchFile` 签名：

```typescript
async function searchFile(filePath: string, regex: RegExp, remaining = Number.POSITIVE_INFINITY): Promise<string[]> {
  const results: string[] = []
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let lineNum = 0
  for await (const line of rl) {
    lineNum++
    if (regex.test(line)) {
      results.push(`${lineNum}:  ${line}`)
      if (results.length >= remaining) break
    }
  }

  rl.close()
  stream.destroy()
  return results
}
```

- [ ] **步骤 6：限制 ripgrep 输出**

在 `tryRipgrep` 中用 streaming lines cap，超过 `maxResults` 后 kill child：

```typescript
let stdout = ''
let stderr = ''
let lineCount = 0
let settled = false

const finish = (result: ToolResult | null) => {
  if (settled) return
  settled = true
  clearTimeout(timer)
  resolve(result)
}

child.stdout!.on('data', (data: Buffer) => {
  stdout += data.toString()
  const lines = stdout.split('\n')
  if (!stdout.endsWith('\n')) lines.pop()
  lineCount = lines.filter(l => l.length > 0).length
  if (lineCount >= maxResults) {
    child.kill('SIGTERM')
  }
  if (stdout.length > 200_000) {
    child.kill('SIGTERM')
  }
})
```

在 `close` 中仍然按 `maxResults` 截断：

```typescript
const lines = stdout.split('\n').filter(l => l.length > 0).slice(0, maxResults)
const suffix = lineCount >= maxResults ? '\n... (truncated)' : ''
finish({ content: truncateContent(lines.join('\n') + suffix, 12000, 6000, 4000) })
```

- [ ] **步骤 7：运行测试确认通过**

```bash
npx tsx --test src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/tools/glob.ts src/tools/grep.ts src/tools/__tests__/glob.test.ts src/tools/__tests__/grep.test.ts
git commit -m "fix(tools): cap search traversal and output"
```

---

## 任务 4：Checkpoint v2 与安全 rollback

**文件：**
- 修改：`src/agent/checkpoint.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/checkpoint.test.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：写 pre-existing dirty file 失败测试**

在 `src/agent/__tests__/checkpoint.test.ts` 添加：

```typescript
it('does not remove pre-existing unstaged changes during rollback', async () => {
  const repo = makeTempGitRepo()
  try {
    writeFileSync(join(repo, 'user-work.txt'), 'user work before agent')
    const cp = await createCheckpoint(repo, 'auto')
    assert.ok(cp)

    await recordAgentTouchedFile(repo, 'agent-created.txt')
    writeFileSync(join(repo, 'agent-created.txt'), 'agent work')

    const preview = await getRollbackPreview(repo)
    assert.ok(preview)
    const result = await rollbackToCheckpoint(repo, preview.confirmationToken)

    assert.equal(result.success, true)
    assert.ok(existsSync(join(repo, 'user-work.txt')))
    assert.ok(!existsSync(join(repo, 'agent-created.txt')))
  } finally {
    cleanupRepo(repo)
  }
})
```

此测试需要后续步骤定义 `recordAgentTouchedFile()`，当前应 FAIL。

- [ ] **步骤 2：写 confirmation token 失败测试**

添加：

```typescript
it('requires confirmation token for rollback', async () => {
  const repo = makeTempGitRepo()
  try {
    await createCheckpoint(repo, 'auto')
    await recordAgentTouchedFile(repo, 'agent-created.txt')
    writeFileSync(join(repo, 'agent-created.txt'), 'agent work')
    const result = await rollbackToCheckpoint(repo)
    assert.equal(result.success, false)
  } finally {
    cleanupRepo(repo)
  }
})
```

- [ ] **步骤 3：运行失败测试**

```bash
npx tsx --test src/agent/__tests__/checkpoint.test.ts
```

预期：FAIL，当前 rollback 不区分用户原有改动和 agent 改动，也不要求 token。

- [ ] **步骤 4：实现 checkpoint metadata**

在 `src/agent/checkpoint.ts` 中替换 `CheckpointData`：

```typescript
interface CheckpointData {
  version: 2
  hash: string
  timestamp: number
  label: string
  cwd: string
  preExistingDirtyFiles: string[]
  preExistingUntrackedFiles: string[]
  agentTouchedFiles: string[]
  confirmationToken?: string
}

export interface RollbackPreview {
  text: string
  confirmationToken: string
}
```

新增 helpers：

```typescript
async function gitLines(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: 5000, encoding: 'utf-8' })
  return stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

async function getDirtySnapshot(cwd: string): Promise<{ dirty: string[]; untracked: string[] }> {
  const dirty = await gitLines(cwd, ['diff', '--name-only'])
  const staged = await gitLines(cwd, ['diff', '--cached', '--name-only'])
  const untracked = await gitLines(cwd, ['ls-files', '--others', '--exclude-standard'])
  return {
    dirty: [...new Set([...dirty, ...staged])].sort(),
    untracked: [...new Set(untracked)].sort(),
  }
}
```

- [ ] **步骤 5：更新 `createCheckpoint()`**

```typescript
export async function createCheckpoint(cwd: string, label?: string): Promise<Checkpoint | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd, timeout: 5000, encoding: 'utf-8',
    })
    const hash = stdout.trim()
    const snapshot = await getDirtySnapshot(cwd)

    mkdirSync(RIVET_DIR, { recursive: true })
    const msg = label ?? 'checkpoint'
    const data: CheckpointData = {
      version: 2,
      hash,
      timestamp: Date.now(),
      label: msg,
      cwd,
      preExistingDirtyFiles: snapshot.dirty,
      preExistingUntrackedFiles: snapshot.untracked,
      agentTouchedFiles: [],
    }
    writeFileSync(checkpointFile(cwd), JSON.stringify(data, null, 2))

    return { hash, timestamp: data.timestamp, message: msg }
  } catch {
    return null
  }
}
```

- [ ] **步骤 6：新增 `recordAgentTouchedFile()`**

```typescript
export function recordAgentTouchedFile(cwd: string, file: string): void {
  const data = loadCheckpointData(cwd)
  if (!data) return
  const normalized = file.replace(/^\.\//, '')
  if (normalized.startsWith('/') || normalized.includes('..')) return
  data.agentTouchedFiles = [...new Set([...data.agentTouchedFiles, normalized])].sort()
  writeFileSync(checkpointFile(cwd), JSON.stringify(data, null, 2))
}
```

- [ ] **步骤 7：更新 preview 返回 token**

```typescript
export async function getRollbackPreview(cwd: string): Promise<RollbackPreview | null> {
  const data = loadCheckpointData(cwd)
  if (!data) return null

  const token = Math.random().toString(36).slice(2, 10)
  data.confirmationToken = token
  writeFileSync(checkpointFile(cwd), JSON.stringify(data, null, 2))

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const rollbackFiles = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))

  if (rollbackFiles.length === 0) return null

  const text = [
    `Checkpoint: ${data.hash.slice(0, 8)} (${new Date(data.timestamp).toLocaleString()})`,
    'Agent-owned files to restore/remove:',
    ...rollbackFiles.map(f => `- ${f}`),
  ].join('\n')

  return { text, confirmationToken: token }
}
```

- [ ] **步骤 8：更新 rollback 只处理 agent-owned files**

```typescript
export async function rollbackToCheckpoint(
  cwd: string,
  confirmationToken?: string,
): Promise<{ success: boolean; hash?: string }> {
  const data = loadCheckpointData(cwd)
  if (!data || !confirmationToken || confirmationToken !== data.confirmationToken) {
    return { success: false }
  }

  const protectedFiles = new Set([...data.preExistingDirtyFiles, ...data.preExistingUntrackedFiles])
  const files = data.agentTouchedFiles.filter(f => !protectedFiles.has(f))
  if (files.length === 0) return { success: false }

  try {
    for (const file of files) {
      const trackedAtHead = await execFileP('git', ['cat-file', '-e', `${data.hash}:${file}`], { cwd })
        .then(() => true)
        .catch(() => false)
      if (trackedAtHead) {
        await execFileP('git', ['checkout', data.hash, '--', file], { cwd, timeout: 10000 })
      } else {
        const fullPath = join(cwd, file)
        if (existsSync(fullPath)) rmSync(fullPath, { recursive: true, force: true })
      }
    }
    return { success: true, hash: data.hash.slice(0, 7) }
  } catch {
    return { success: false }
  }
}
```

需要在文件顶部加入：

```typescript
import { rmSync } from 'fs'
```

- [ ] **步骤 9：AgentLoop 记录 touched file**

在 `src/agent/loop.ts` 导入：

```typescript
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
```

在修改工具执行前记录：

```typescript
if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
  if (!checkpointCreatedThisTurn) {
    const cp = await createCheckpoint(this.cwd, 'auto')
    checkpointCreatedThisTurn = true
    if (cp) callbacks.onCheckpoint?.(cp.hash)
  }
  recordAgentTouchedFile(this.cwd, tu.input.file_path)
}
```

- [ ] **步骤 10：更新 TUI rollback 调用**

在 `src/tui/app.tsx` 中保存 preview token：

```typescript
const rollbackTokenRef = useRef<string | null>(null)
```

处理 `/rollback`：

```typescript
const preview = await getRollbackPreview(process.cwd())
if (preview) {
  rollbackTokenRef.current = preview.confirmationToken
  addLog({ type: 'text', content: `This will rollback agent-owned changes:\n${preview.text}\n\nType /rollback confirm to proceed.` })
}
```

处理 `/rollback confirm`：

```typescript
const result = await rollbackToCheckpoint(process.cwd(), rollbackTokenRef.current ?? undefined)
rollbackTokenRef.current = null
```

- [ ] **步骤 11：运行测试确认通过**

```bash
npx tsx --test src/agent/__tests__/checkpoint.test.ts src/agent/__tests__/loop.test.ts
```

预期：PASS。

- [ ] **步骤 12：Commit**

```bash
git add src/agent/checkpoint.ts src/agent/loop.ts src/tui/app.tsx src/agent/__tests__/checkpoint.test.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(checkpoint): rollback only agent-owned changes"
```

---

## 任务 5：修复 microCompact token 判断

**文件：**
- 修改：`src/compact/micro.ts`
- 修改：`src/compact/__tests__/compact.test.ts`

- [ ] **步骤 1：写失败测试：返回后仍超窗时必须尽量截断**

在 `src/compact/__tests__/compact.test.ts` 的 `describe('microCompact')` 中添加：

```typescript
it('uses full token budget including anchor and recent messages', () => {
  const bigMsg = 'x'.repeat(100)
  const messages = [
    msg('user', bigMsg), msg('assistant', bigMsg),
    msg('user', bigMsg), msg('assistant', bigMsg),
    msg('user', bigMsg), msg('assistant', bigMsg),
    msg('user', bigMsg), msg('assistant', bigMsg),
  ]

  const result = microCompact(messages, 160, 200)
  const after = estimateTokens(result.messages)
  assert.ok(after <= 160 || result.truncated === 2, `after=${after} truncated=${result.truncated}`)
})
```

- [ ] **步骤 2：更新现有 cache anchor 期望**

把原测试中的错误断言：

```typescript
assert.ok(result.truncated >= 4, `expected >= 4 truncated, got ${result.truncated}`)
assert.equal(result.messages.length, 4)
```

替换为：

```typescript
assert.equal(result.truncated, 2)
assert.equal(result.messages.length, 6)
assert.deepEqual(result.messages.slice(0, 2), messages.slice(0, 2))
assert.deepEqual(result.messages.slice(-4), messages.slice(-4))
```

- [ ] **步骤 3：运行失败测试**

```bash
npx tsx --test src/compact/__tests__/compact.test.ts
```

预期：FAIL，当前 `microCompact()` 用 middle token 判断预算。

- [ ] **步骤 4：修复 `microCompact()`**

将 `src/compact/micro.ts` 中的核心逻辑替换为：

```typescript
const anchor = messages.slice(0, CACHE_ANCHOR_MESSAGES)
const recent = messages.slice(-KEEP_RECENT_MESSAGES)
const middle = messages.slice(CACHE_ANCHOR_MESSAGES, -KEEP_RECENT_MESSAGES)

let totalTokens = estimatedTokens
let removeCount = 0
while (removeCount < middle.length && totalTokens > contextWindow) {
  totalTokens -= estimateMessageTokens(middle[removeCount]!)
  removeCount++
}

const keptMiddle = middle.slice(removeCount)
return {
  messages: [...anchor, ...keptMiddle, ...recent],
  truncated: removeCount,
}
```

不要在这里再调用 `estimateTokens(messages)`，因为调用方已经传入增量估算值。

- [ ] **步骤 5：运行测试确认通过**

```bash
npx tsx --test src/compact/__tests__/compact.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/compact/micro.ts src/compact/__tests__/compact.test.ts
git commit -m "fix(compact): respect full token budget in micro compact"
```

---

## 任务 6：修复 run_tests filter 与 Verification metadata

**文件：**
- 修改：`src/tools/types.ts`
- 修改：`src/tools/run-tests.ts`
- 创建：`src/agent/verification.ts`
- 测试：`src/tools/__tests__/run-tests.test.ts`
- 测试：`src/agent/__tests__/verification.test.ts`

- [ ] **步骤 1：扩展 ToolResult 类型测试需求**

在 `src/tools/__tests__/run-tests.test.ts` 添加测试，验证 file filter 生效：

```typescript
it('runs only the requested node-test file when filter is a test file', async () => {
  const dir = makeTestProject({
    script: 'tsx --test src/**/__tests__/*.test.ts',
    files: {
      'src/__tests__/a.test.ts': 'import { test } from "node:test"; test("a", () => {})',
      'src/__tests__/b.test.ts': 'import { test } from "node:test"; test("b", () => { throw new Error("should not run") })',
    },
  })
  try {
    const result = await RUN_TESTS_TOOL.execute(makeParams(dir, { filter: 'src/__tests__/a.test.ts' }))
    assert.equal(result.isError, false)
    assert.match(result.content, /1 passed, 0 failed/)
    assert.equal(result.verification?.scope, 'targeted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

如果 `makeTestProject` helper 不存在，在同一测试文件中创建：

```typescript
function makeTestProject(input: { script: string; files: Record<string, string> }): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: input.script }, devDependencies: { tsx: '^4.20.5' } }))
  for (const [file, content] of Object.entries(input.files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), content)
  }
  return dir
}
```

- [ ] **步骤 2：写 failed metadata 测试**

```typescript
it('returns verification metadata when tests fail', async () => {
  const dir = makeTestProject({
    script: 'tsx --test src/**/__tests__/*.test.ts',
    files: {
      'src/__tests__/fail.test.ts': 'import { test } from "node:test"; test("fail", () => { throw new Error("boom") })',
    },
  })
  try {
    const result = await RUN_TESTS_TOOL.execute(makeParams(dir, {}))
    assert.equal(result.isError, true)
    assert.equal(result.verification?.status, 'failed')
    assert.equal(result.verification?.failed, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
```

- [ ] **步骤 3：运行失败测试**

```bash
npx tsx --test src/tools/__tests__/run-tests.test.ts
```

预期：FAIL，当前 filter/metadata 不满足新行为。

- [ ] **步骤 4：扩展 `ToolResult`**

在 `src/tools/types.ts` 添加：

```typescript
export interface VerificationMetadata {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: 'full' | 'targeted'
  exitCode: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
}

export interface ToolResult {
  content: string
  isError?: boolean
  uiContent?: string
  rawPath?: string
  verification?: VerificationMetadata
}
```

如果 `ToolResult` 已存在，只合并新增字段，不重复声明。

- [ ] **步骤 5：实现安全命令构造**

在 `src/tools/run-tests.ts` 中新增：

```typescript
interface TestCommand {
  command: string
  args: string[]
  display: string
  runner: string
  scope: 'full' | 'targeted'
}

function isTestFileFilter(filter: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filter)
}

function buildTestCommand(cwd: string, filter?: string): TestCommand {
  const { base, runner } = detectTestCommand(cwd)
  if (!filter) {
    return { command: 'npm', args: ['test'], display: 'npm test', runner, scope: 'full' }
  }

  const safeFilter = filter.replace(/[`$\\;"'|]/g, '')
  if (runner === 'node-test' && isTestFileFilter(safeFilter)) {
    if (base.includes('tsx')) {
      return { command: 'npx', args: ['tsx', '--test', safeFilter], display: `npx tsx --test ${safeFilter}`, runner, scope: 'targeted' }
    }
    return { command: 'node', args: ['--test', safeFilter], display: `node --test ${safeFilter}`, runner, scope: 'targeted' }
  }

  if (runner === 'vitest') {
    return { command: 'npx', args: ['vitest', 'run', safeFilter], display: `npx vitest run ${safeFilter}`, runner, scope: 'targeted' }
  }

  if (runner === 'jest') {
    return { command: 'npx', args: ['jest', '--testPathPattern', safeFilter], display: `npx jest --testPathPattern ${safeFilter}`, runner, scope: 'targeted' }
  }

  return { command: 'npm', args: ['test', '--', safeFilter], display: `npm test -- ${safeFilter}`, runner, scope: 'targeted' }
}
```

- [ ] **步骤 6：使用 `spawn(command, args)`**

替换当前 `argv = ['sh', '-c', ...]` 逻辑：

```typescript
const testCommand = buildTestCommand(params.cwd, filter)
const child = track(spawn(testCommand.command, testCommand.args, {
  cwd: params.cwd,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
}))
```

并使用：

```typescript
const commandDisplay = testCommand.display
const runner = testCommand.runner
```

- [ ] **步骤 7：返回 verification metadata**

在 close handler 中构造：

```typescript
const verification = {
  command: commandDisplay,
  status: exitCode === 0 ? 'passed' as const : 'failed' as const,
  scope: testCommand.scope,
  exitCode,
  passed: parsed.passed,
  failed: parsed.failed,
  skipped: parsed.skipped,
  durationMs,
}

resolve({
  content: truncated,
  uiContent: buildUiOutput(raw, meta),
  rawPath,
  verification,
  isError: exitCode !== 0,
})
```

在 timeout/error handler 中返回 blocked metadata：

```typescript
verification: {
  command: commandDisplay,
  status: 'blocked',
  scope: testCommand.scope,
  exitCode: -1,
  passed: 0,
  failed: 0,
  skipped: 0,
  durationMs: Date.now() - startTime,
}
```

- [ ] **步骤 8：创建 Verification state**

创建 `src/agent/verification.ts`：

```typescript
import type { VerificationMetadata } from '../tools/types.js'

export interface VerificationState {
  runs: VerificationMetadata[]
}

export function emptyVerificationState(): VerificationState {
  return { runs: [] }
}

export function addVerificationRun(state: VerificationState, run: VerificationMetadata): VerificationState {
  return { runs: [...state.runs, run] }
}

export function summarizeVerification(state: VerificationState): string {
  if (state.runs.length === 0) return 'Tests not run'
  const last = state.runs[state.runs.length - 1]!
  if (last.status === 'blocked') return `Tests blocked: ${last.command}`
  const scope = last.scope === 'targeted' ? 'targeted' : 'full'
  return `${scope} tests ${last.status}: ${last.passed} passed, ${last.failed} failed`
}
```

- [ ] **步骤 9：测试 Verification state**

创建 `src/agent/__tests__/verification.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addVerificationRun, emptyVerificationState, summarizeVerification } from '../verification.js'

const baseRun = {
  command: 'npm test',
  status: 'passed' as const,
  scope: 'full' as const,
  exitCode: 0,
  passed: 10,
  failed: 0,
  skipped: 0,
  durationMs: 100,
}

describe('verification state', () => {
  it('summarizes missing tests', () => {
    assert.equal(summarizeVerification(emptyVerificationState()), 'Tests not run')
  })

  it('summarizes full passed tests', () => {
    const state = addVerificationRun(emptyVerificationState(), baseRun)
    assert.equal(summarizeVerification(state), 'full tests passed: 10 passed, 0 failed')
  })

  it('summarizes blocked tests', () => {
    const state = addVerificationRun(emptyVerificationState(), { ...baseRun, status: 'blocked', exitCode: -1 })
    assert.equal(summarizeVerification(state), 'Tests blocked: npm test')
  })
})
```

- [ ] **步骤 10：运行测试确认通过**

```bash
npx tsx --test src/tools/__tests__/run-tests.test.ts src/agent/__tests__/verification.test.ts
```

预期：PASS。

- [ ] **步骤 11：Commit**

```bash
git add src/tools/types.ts src/tools/run-tests.ts src/tools/__tests__/run-tests.test.ts src/agent/verification.ts src/agent/__tests__/verification.test.ts
git commit -m "fix(run-tests): make targeted verification reliable"
```

---

## 任务 7：Evidence badge 记录 failed/blocked tests

**文件：**
- 修改：`src/agent/evidence.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：写 failed evidence 测试**

在 `src/agent/__tests__/loop.test.ts` 增加一个 mock `run_tests` 返回失败的测试：

```typescript
it('includes failed test results in evidence badge', async () => {
  const session = new SessionContext()
  const registry = new ToolRegistry()
  registry.register({
    definition: {
      name: 'run_tests',
      description: 'Run tests',
      input_schema: { type: 'object', properties: {} },
    },
    async execute() {
      return {
        content: 'Exit code: 1\n2 passed, 1 failed, 0 skipped',
        isError: true,
        verification: {
          command: 'npm test',
          status: 'failed',
          scope: 'full',
          exitCode: 1,
          passed: 2,
          failed: 1,
          skipped: 0,
          durationMs: 10,
        },
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  })

  const client = mockClient([
    makeToolUseBlock('tool_1', 'run_tests', {}),
    makeTextBlock('Done'),
  ])
  const loop = new AgentLoop({
    client,
    promptEngine: makeEngine(),
    toolRegistry: registry,
    maxTurns: 3,
    contextWindow: 1000000,
    compact: { enabled: false, autoThreshold: 800000, autoFloor: 500000, model: 'deepseek-v4-flash' },
  }, session)

  let text = ''
  await loop.run('run tests', {
    onTextDelta: chunk => { text += chunk },
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: () => {},
    onError: err => { throw err },
    onAbort: () => {},
    onApprovalRequired: async () => true,
  })

  assert.match(text, /Tests: .*2 passed, 1 failed/)
})
```

- [ ] **步骤 2：运行失败测试**

```bash
npx tsx --test src/agent/__tests__/loop.test.ts
```

预期：FAIL，当前 failed `run_tests` 不进入 evidence。

- [ ] **步骤 3：扩展 EvidenceTracker**

在 `src/agent/evidence.ts` 中替换 test state：

```typescript
import type { VerificationMetadata } from '../tools/types.js'

export interface EvidenceState {
  filesRead: Set<string>
  filesModified: Set<string>
  verifications: VerificationMetadata[]
}
```

替换 `trackTestResult()`：

```typescript
trackVerification(result: VerificationMetadata): void {
  this.state.verifications.push(result)
}
```

在 `buildBadge()` 中生成：

```typescript
if (this.state.verifications.length > 0) {
  const last = this.state.verifications[this.state.verifications.length - 1]!
  if (last.status === 'blocked') {
    parts.push(`- Tests: blocked (${last.command})`)
  } else {
    const icon = last.status === 'passed' ? 'passed' : 'failed'
    parts.push(`- Tests: ${icon} (${last.scope}) ${last.passed} passed, ${last.failed} failed`)
  }
}
```

未验证判断改成：

```typescript
if (modified.length > 0 && this.state.verifications.length === 0) {
  unverified.push('tests not run after modifications')
}
```

- [ ] **步骤 4：AgentLoop 接入 verification metadata**

在 `src/agent/loop.ts` 替换 run_tests evidence：

```typescript
if (tu.name === 'run_tests' && result.verification) {
  this.evidence.trackVerification(result.verification)
  if (result.verification.status !== 'passed') {
    const failures = classifyTestRun(result.content)
    if (failures.length > 0 && failures[0]!.confidence >= 0.7) {
      result.content += `\n\nDiagnosis: ${failures[0]!.suggestion}`
    }
  }
}
```

删除旧的只在 `!result.isError` 时记录测试的分支。

- [ ] **步骤 5：运行测试确认通过**

```bash
npx tsx --test src/agent/__tests__/loop.test.ts src/agent/__tests__/verification.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/evidence.ts src/agent/loop.ts src/agent/__tests__/loop.test.ts
git commit -m "fix(agent): include failed tests in evidence"
```

---

## 任务 8：Raw output 路径安全与 TUI 状态修复

**文件：**
- 修改：`src/tools/output-store.ts`
- 修改：`src/tools/__tests__/output-store.test.ts`
- 修改：`src/tui/app.tsx`

- [ ] **步骤 1：写 raw output unsafe id 测试**

在 `src/tools/__tests__/output-store.test.ts` 添加：

```typescript
it('does not use toolUseId directly as a file path', async () => {
  const rawPath = await persistRawOutput('../escape', 'secret')
  assert.ok(rawPath.includes('rivet-raw'))
  assert.ok(!rawPath.includes('..'))
  assert.ok(rawPath.endsWith('.raw'))
})
```

- [ ] **步骤 2：运行失败测试**

```bash
npx tsx --test src/tools/__tests__/output-store.test.ts
```

预期：FAIL 或暴露路径包含 unsafe id。

- [ ] **步骤 3：修复 output-store 文件名**

在 `src/tools/output-store.ts` 顶部加入：

```typescript
import { createHash, randomUUID } from 'node:crypto'
```

新增：

```typescript
function safeRawFileName(id: string): string {
  const hash = createHash('sha256').update(id || randomUUID()).digest('hex').slice(0, 24)
  return `${hash}.raw`
}
```

替换：

```typescript
const filePath = join(RAW_DIR, `${id}.raw`)
```

为：

```typescript
const filePath = join(RAW_DIR, safeRawFileName(id))
```

- [ ] **步骤 4：修复 `/verbose` stale state**

在 `src/tui/app.tsx` 替换：

```typescript
setVerbose(v => !v)
addLog({ type: 'text', content: verbose ? 'Verbose mode: off (show 20 lines)' : 'Verbose mode: on (show 200 lines)' })
```

为：

```typescript
const nextVerbose = !verbose
setVerbose(nextVerbose)
addLog({ type: 'text', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' })
```

- [ ] **步骤 5：修复 tool flush toolName capture**

在 `src/tui/app.tsx` refs 附近新增：

```typescript
const toolNamesRef = useRef<Map<string, string>>(new Map())
```

替换 `scheduleToolFlush`：

```typescript
const scheduleToolFlush = (id: string, name: string) => {
  dirtyToolIdsRef.current.add(id)
  toolNamesRef.current.set(id, name)
  if (!toolFlushRef.current) {
    toolFlushRef.current = setTimeout(() => {
      for (const dirtyId of dirtyToolIdsRef.current) {
        const accumulated = toolOutputAccumRef.current.get(dirtyId)
        const toolName = toolNamesRef.current.get(dirtyId) ?? 'tool'
        if (accumulated !== undefined) {
          updateLogEntry(dirtyId, toolName, summarizeToolOutput(accumulated, verbose ? 200 : 24))
        }
      }
      dirtyToolIdsRef.current.clear()
      toolFlushRef.current = null
    }, 50)
  }
}
```

在 final tool result 分支清理：

```typescript
toolNamesRef.current.delete(id)
```

- [ ] **步骤 6：运行测试和类型检查**

```bash
npx tsx --test src/tools/__tests__/output-store.test.ts src/tui/__tests__/log-state.test.ts
npm run typecheck
```

预期：PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/tools/output-store.ts src/tools/__tests__/output-store.test.ts src/tui/app.tsx
git commit -m "fix(reliability): sanitize raw output paths and TUI state"
```

---

## 任务 9：Verification Engine 与最终回答约束

**文件：**
- 修改：`src/agent/verification.ts`
- 修改：`src/agent/evidence.ts`
- 修改：`src/agent/loop.ts`
- 测试：`src/agent/__tests__/verification.test.ts`
- 测试：`src/agent/__tests__/loop.test.ts`

- [ ] **步骤 1：写最终状态测试**

在 `src/agent/__tests__/verification.test.ts` 添加：

```typescript
import { buildFinalVerificationReport } from '../verification.js'

describe('final verification report', () => {
  it('marks modified files as not verified when tests did not run', () => {
    const report = buildFinalVerificationReport({
      modifiedFiles: ['src/a.ts'],
      verification: emptyVerificationState(),
    })
    assert.match(report, /Not verified:/)
    assert.match(report, /tests not run after modifications/)
  })

  it('does not claim full verification for targeted tests', () => {
    const state = addVerificationRun(emptyVerificationState(), { ...baseRun, scope: 'targeted', command: 'npx tsx --test src/a.test.ts' })
    const report = buildFinalVerificationReport({ modifiedFiles: ['src/a.ts'], verification: state })
    assert.match(report, /Verified:/)
    assert.match(report, /targeted tests passed/)
    assert.match(report, /Not verified:/)
    assert.match(report, /full suite not run/)
  })
})
```

- [ ] **步骤 2：运行失败测试**

```bash
npx tsx --test src/agent/__tests__/verification.test.ts
```

预期：FAIL，因为 `buildFinalVerificationReport` 还不存在。

- [ ] **步骤 3：实现 final verification report**

在 `src/agent/verification.ts` 添加：

```typescript
export interface FinalVerificationInput {
  modifiedFiles: string[]
  verification: VerificationState
}

export function buildFinalVerificationReport(input: FinalVerificationInput): string {
  const changed = input.modifiedFiles.length > 0
  const last = input.verification.runs[input.verification.runs.length - 1]
  const lines: string[] = ['## Verification']

  if (!last) {
    lines.push('- Verified: none')
    if (changed) lines.push('- Not verified: tests not run after modifications')
    return lines.join('\n')
  }

  if (last.status === 'blocked') {
    lines.push(`- Verified: none`)
    lines.push(`- Not verified: tests blocked while running ${last.command}`)
    return lines.join('\n')
  }

  lines.push(`- Verified: ${last.scope} tests ${last.status}: ${last.passed} passed, ${last.failed} failed`)
  if (last.scope === 'targeted') {
    lines.push('- Not verified: full suite not run')
  }
  if (last.status === 'failed') {
    lines.push('- Risks: tests are failing')
  }
  return lines.join('\n')
}
```

- [ ] **步骤 4：AgentLoop 使用最终验证报告**

在 `EvidenceTracker` 或 `AgentLoop` 中，最终 badge 使用 verification report。最小变更：在 `EvidenceTracker.buildBadge()` 中输出固定段落：

```typescript
if (modified.length > 0) {
  parts.push(`- Files modified: ${modified.length}`)
}
```

并确保未运行测试时保留：

```typescript
parts.push('- Not verified: tests not run after modifications')
```

- [ ] **步骤 5：运行测试确认通过**

```bash
npx tsx --test src/agent/__tests__/verification.test.ts src/agent/__tests__/loop.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/agent/verification.ts src/agent/evidence.ts src/agent/loop.ts src/agent/__tests__/verification.test.ts src/agent/__tests__/loop.test.ts
git commit -m "feat(agent): enforce verification-aware final reports"
```

---

## 任务 10：Repo Intelligence v2

**文件：**
- 创建：`src/repo/symbol-index.ts`
- 创建：`src/repo/import-graph.ts`
- 创建：`src/repo/context-bundle.ts`
- 创建：`src/repo/__tests__/symbol-index.test.ts`
- 创建：`src/repo/__tests__/import-graph.test.ts`
- 创建：`src/repo/__tests__/context-bundle.test.ts`
- 修改：`src/tools/repo-map.ts` 或 `src/tools/inspect-project.ts`，接入 context bundle 摘要

- [ ] **步骤 1：写 symbol index 测试**

创建 `src/repo/__tests__/symbol-index.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSymbolIndexFromText } from '../symbol-index.js'

describe('symbol index', () => {
  it('extracts functions, classes, types and exports with line numbers', () => {
    const index = buildSymbolIndexFromText('src/example.ts', [
      'export function run() {}',
      'class Worker {}',
      'export interface Config { name: string }',
      'type Result = string',
    ].join('\n'))

    assert.deepEqual(index.map(s => [s.name, s.kind, s.line]), [
      ['run', 'function', 1],
      ['Worker', 'class', 2],
      ['Config', 'type', 3],
      ['Result', 'type', 4],
    ])
  })
})
```

- [ ] **步骤 2：实现 symbol index**

创建 `src/repo/symbol-index.ts`：

```typescript
export interface SymbolEntry {
  name: string
  kind: 'function' | 'class' | 'type'
  file: string
  line: number
  exported: boolean
}

const SYMBOL_PATTERNS: Array<{ kind: SymbolEntry['kind']; regex: RegExp }> = [
  { kind: 'function', regex: /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', regex: /^(export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/ },
  { kind: 'class', regex: /^(export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', regex: /^(export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/ },
]

export function buildSymbolIndexFromText(file: string, text: string): SymbolEntry[] {
  const entries: SymbolEntry[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim()
    for (const pattern of SYMBOL_PATTERNS) {
      const match = trimmed.match(pattern.regex)
      if (match) {
        entries.push({
          name: match[2]!,
          kind: pattern.kind,
          file,
          line: i + 1,
          exported: Boolean(match[1]),
        })
        break
      }
    }
  }
  return entries
}
```

- [ ] **步骤 3：写 import graph 测试**

创建 `src/repo/__tests__/import-graph.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildImportEdgesFromText } from '../import-graph.js'

describe('import graph', () => {
  it('extracts relative import edges', () => {
    const edges = buildImportEdgesFromText('src/a.ts', [
      "import { b } from './b.js'",
      "import type { C } from '../c.js'",
      "import 'zod'",
    ].join('\n'))

    assert.deepEqual(edges, [
      { from: 'src/a.ts', to: './b.js' },
      { from: 'src/a.ts', to: '../c.js' },
    ])
  })
})
```

- [ ] **步骤 4：实现 import graph**

创建 `src/repo/import-graph.ts`：

```typescript
export interface ImportEdge {
  from: string
  to: string
}

const IMPORT_RE = /^import(?:\s+type)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/gm

export function buildImportEdgesFromText(file: string, text: string): ImportEdge[] {
  const edges: ImportEdge[] = []
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(text)) !== null) {
    const target = match[1]!
    if (target.startsWith('.')) edges.push({ from: file, to: target })
  }
  return edges
}
```

- [ ] **步骤 5：写 context bundle 测试**

创建 `src/repo/__tests__/context-bundle.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildContextBundle } from '../context-bundle.js'

describe('context bundle', () => {
  it('combines symbols, tests and risks into a task bundle', () => {
    const bundle = buildContextBundle({
      task: 'fix run tests filter',
      likelyFiles: ['src/tools/run-tests.ts'],
      relatedTests: ['src/tools/__tests__/run-tests.test.ts'],
      symbols: [{ name: 'buildTestCommand', kind: 'function', file: 'src/tools/run-tests.ts', line: 1, exported: false }],
      risks: ['test command must not use shell interpolation'],
    })

    assert.match(bundle, /fix run tests filter/)
    assert.match(bundle, /src\/tools\/run-tests\.ts/)
    assert.match(bundle, /buildTestCommand/)
  })
})
```

- [ ] **步骤 6：实现 context bundle**

创建 `src/repo/context-bundle.ts`：

```typescript
import type { SymbolEntry } from './symbol-index.js'

export interface ContextBundleInput {
  task: string
  likelyFiles: string[]
  relatedTests: string[]
  symbols: SymbolEntry[]
  risks: string[]
}

export function buildContextBundle(input: ContextBundleInput): string {
  const lines: string[] = []
  lines.push(`Task: ${input.task}`)
  lines.push('Likely files:')
  for (const file of input.likelyFiles) lines.push(`- ${file}`)
  lines.push('Related tests:')
  for (const test of input.relatedTests) lines.push(`- ${test}`)
  lines.push('Relevant symbols:')
  for (const symbol of input.symbols) {
    lines.push(`- ${symbol.name} (${symbol.kind}) ${symbol.file}:${symbol.line}`)
  }
  if (input.risks.length > 0) {
    lines.push('Risks:')
    for (const risk of input.risks) lines.push(`- ${risk}`)
  }
  return lines.join('\n')
}
```

- [ ] **步骤 7：运行测试确认通过**

```bash
npx tsx --test src/repo/__tests__/symbol-index.test.ts src/repo/__tests__/import-graph.test.ts src/repo/__tests__/context-bundle.test.ts
```

预期：PASS。

- [ ] **步骤 8：Commit**

```bash
git add src/repo/symbol-index.ts src/repo/import-graph.ts src/repo/context-bundle.ts src/repo/__tests__/symbol-index.test.ts src/repo/__tests__/import-graph.test.ts src/repo/__tests__/context-bundle.test.ts
git commit -m "feat(repo): add lightweight context intelligence"
```

---

## 任务 11：Model Capability Routing v1

**文件：**
- 创建：`src/model/capability.ts`
- 创建：`src/model/__tests__/capability.test.ts`
- 修改：`src/api/provider.ts`
- 修改：`src/config/schema.ts`

- [ ] **步骤 1：写 routing 测试**

创建 `src/model/__tests__/capability.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { recommendModelForTask } from '../capability.js'

describe('model capability routing', () => {
  const cards = [
    { model: 'cheap-long', toolUseReliability: 0.6, jsonStability: 0.7, editSuccessRate: 0.5, testRepairRate: 0.4, contextWindow: 1000000, cacheEconomics: 'strong' as const, recommendedTasks: ['summarize'] },
    { model: 'tool-strong', toolUseReliability: 0.95, jsonStability: 0.9, editSuccessRate: 0.85, testRepairRate: 0.7, contextWindow: 128000, cacheEconomics: 'medium' as const, recommendedTasks: ['edit'] },
  ]

  it('prefers tool reliable model for edits', () => {
    assert.equal(recommendModelForTask('code_edit', cards).model, 'tool-strong')
  })

  it('prefers long context model for summarization', () => {
    assert.equal(recommendModelForTask('repo_summarization', cards).model, 'cheap-long')
  })
})
```

- [ ] **步骤 2：实现 capability routing**

创建 `src/model/capability.ts`：

```typescript
export type CapabilityTask = 'repo_summarization' | 'code_edit' | 'test_failure_diagnosis' | 'compaction' | 'risky_refactor'

export interface ModelCapabilityCard {
  model: string
  toolUseReliability: number
  jsonStability: number
  editSuccessRate: number
  testRepairRate: number
  contextWindow: number
  cacheEconomics: 'weak' | 'medium' | 'strong'
  recommendedTasks: string[]
}

function score(task: CapabilityTask, card: ModelCapabilityCard): number {
  switch (task) {
    case 'repo_summarization':
      return card.contextWindow / 1_000_000 + (card.cacheEconomics === 'strong' ? 1 : 0)
    case 'code_edit':
      return card.toolUseReliability * 0.5 + card.editSuccessRate * 0.5
    case 'test_failure_diagnosis':
      return card.testRepairRate * 0.7 + card.jsonStability * 0.3
    case 'compaction':
      return (card.cacheEconomics === 'strong' ? 1 : 0.5) + card.jsonStability
    case 'risky_refactor':
      return card.toolUseReliability * 0.4 + card.editSuccessRate * 0.3 + card.testRepairRate * 0.3
  }
}

export function recommendModelForTask(task: CapabilityTask, cards: ModelCapabilityCard[]): ModelCapabilityCard {
  if (cards.length === 0) throw new Error('No model capability cards configured')
  return [...cards].sort((a, b) => score(task, b) - score(task, a))[0]!
}
```

- [ ] **步骤 3：运行测试确认通过**

```bash
npx tsx --test src/model/__tests__/capability.test.ts
```

预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add src/model/capability.ts src/model/__tests__/capability.test.ts
git commit -m "feat(model): add capability-based routing policy"
```

---

## 任务 12：Failure Sample Library

**文件：**
- 创建：`src/failures/sample.ts`
- 创建：`src/failures/__tests__/sample.test.ts`
- 修改：`.gitignore`
- 修改：`README.md`

- [ ] **步骤 1：写 sample 生成测试**

创建 `src/failures/__tests__/sample.test.ts`：

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFailureSample } from '../sample.js'

describe('failure sample library', () => {
  it('writes redacted failure sample files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'failure-sample-'))
    try {
      const result = await createFailureSample(dir, {
        slug: 'tool-json-invalid',
        task: 'Run tests',
        model: 'deepseek-v4',
        transcript: 'apiKey=sk-secret-value',
        expected: 'tests pass',
        actual: 'tool JSON invalid',
        rootCause: 'model emitted malformed JSON',
        fix: 'repair JSON before parsing',
      })

      const transcript = readFileSync(join(result.path, 'transcript.redacted.jsonl'), 'utf-8')
      assert.ok(!transcript.includes('sk-secret-value'))
      assert.ok(transcript.includes('sk-xxx'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [ ] **步骤 2：实现 failure sample writer**

创建 `src/failures/sample.ts`：

```typescript
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FailureSampleInput {
  slug: string
  task: string
  model: string
  transcript: string
  expected: string
  actual: string
  rootCause: string
  fix: string
}

function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-xxx')
}

function safeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'failure'
}

export async function createFailureSample(root: string, input: FailureSampleInput): Promise<{ path: string }> {
  const date = new Date().toISOString().slice(0, 10)
  const dir = join(root, `${date}-${safeSlug(input.slug)}`)
  await mkdir(dir, { recursive: true })

  await writeFile(join(dir, 'task.md'), `${input.task}\n`)
  await writeFile(join(dir, 'model.md'), `${input.model}\n`)
  await writeFile(join(dir, 'transcript.redacted.jsonl'), redactSecrets(input.transcript))
  await writeFile(join(dir, 'expected.md'), `${input.expected}\n`)
  await writeFile(join(dir, 'actual.md'), `${input.actual}\n`)
  await writeFile(join(dir, 'root-cause.md'), `${input.rootCause}\n`)
  await writeFile(join(dir, 'fix.md'), `${input.fix}\n`)

  return { path: dir }
}
```

- [ ] **步骤 3：更新 `.gitignore`**

确保 failure samples 默认可选择纳入仓库，但本地 raw transcripts 不纳入。添加：

```gitignore
failure-samples/**/transcript.raw.jsonl
```

不要忽略 `transcript.redacted.jsonl`。

- [ ] **步骤 4：README 增加贡献入口**

在 `README.md` 增加一节：

```markdown
## Failure samples

Rivet uses redacted failure samples to improve open-model coding-agent reliability.
A sample contains the task, model, redacted transcript, expected behavior, actual behavior, root cause, and fix.
Do not commit raw transcripts or secrets. Use `transcript.redacted.jsonl` and replace credentials with placeholders such as `sk-xxx`.
```

- [ ] **步骤 5：运行测试确认通过**

```bash
npx tsx --test src/failures/__tests__/sample.test.ts
```

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/failures/sample.ts src/failures/__tests__/sample.test.ts .gitignore README.md
git commit -m "feat(failures): add redacted failure sample library"
```

---

## 任务 13：全量验证和手动 TUI 验证

**文件：**
- 修改：`docs/analysis/2026-05-15-handoff.md`
- 修改：`.wolf/buglog.json`（仅当本计划执行中修复了失败测试、构建错误或工具 bug）
- 修改：`.wolf/memory.md`
- 修改：`.wolf/anatomy.md`

- [ ] **步骤 1：运行全量测试**

```bash
npm test
```

预期：PASS。若失败，保留第一条失败栈，回到对应任务修复；不要跳过测试。

- [ ] **步骤 2：运行类型检查**

```bash
npm run typecheck
```

预期：PASS。

- [ ] **步骤 3：运行构建**

```bash
npm run build
```

预期：PASS。

- [ ] **步骤 4：运行安全边界手动检查**

启动本地 CLI 后用工具或 slash commands 验证：

```text
glob(pattern="*.ts", path="..")
grep(pattern="API_KEY", path="..")
diff(path="../outside.ts")
```

预期：都返回 `outside project directory`，不输出项目外文件内容。

- [ ] **步骤 5：运行 rollback 手动检查**

在测试 repo 中执行：

```bash
echo "user work" > user-before-agent.txt
# 启动 Rivet，让 agent 创建 agent-created.txt
# 执行 /rollback
# 执行 /rollback confirm
```

预期：`user-before-agent.txt` 保留，`agent-created.txt` 被删除或恢复。

- [ ] **步骤 6：运行 targeted test 手动检查**

通过 `run_tests(filter="src/tools/__tests__/run-tests.test.ts")` 验证：

```text
scope: targeted
command: npx tsx --test src/tools/__tests__/run-tests.test.ts
```

预期：只运行目标 test file，不运行全量测试。

- [ ] **步骤 7：更新 handoff**

在 `docs/analysis/2026-05-15-handoff.md` 追加：

```markdown
## P2.2 Capability Reliability Layer validation

- `npm test`: PASS
- `npm run typecheck`: PASS
- `npm run build`: PASS
- Path boundary checks: PASS
- Safe rollback dirty-worktree check: PASS
- Targeted `run_tests(filter=...)`: PASS
- Evidence badge failed/blocked test reporting: PASS
```

如果某项未通过，写成 `BLOCKED` 并说明阻塞原因，不写 PASS。

- [ ] **步骤 8：更新 OpenWolf 记录**

按项目规则更新：

- `.wolf/anatomy.md`：新增创建文件条目。
- `.wolf/memory.md`：记录 P2.2 执行结果。
- `.wolf/buglog.json`：记录本计划修复的 bug，例如 `tsx missing`、path escape、unsafe rollback、run_tests filter ignored。

- [ ] **步骤 9：最终 secret 扫描**

运行：

```bash
git grep -n -E 'sk-[A-Za-z0-9_-]{20,}' -- ':!package-lock.json'
```

预期：无输出。若有输出，替换为 `sk-xxx` 并重新运行。

- [ ] **步骤 10：Commit**

```bash
git add docs/analysis/2026-05-15-handoff.md .wolf/anatomy.md .wolf/memory.md .wolf/buglog.json
git commit -m "docs: record P2.2 validation results"
```

---

## 自检结果

### 规格覆盖度

- `tsx` 缺失：任务 1。
- `glob/grep/diff` path boundary：任务 2。
- symlink cycle、grep 输出上限：任务 3。
- checkpoint v2、安全 rollback、confirmation token：任务 4。
- `microCompact()` token 判断：任务 5。
- `run_tests(filter)` 与 verification metadata：任务 6。
- failed/blocked test evidence：任务 7。
- raw output path sanitize 与 TUI stale state：任务 8。
- Verification Engine：任务 9。
- Repo Intelligence v2：任务 10。
- Model Capability Routing v1：任务 11。
- Failure Sample Library：任务 12。
- 全量验证与 OpenWolf 记录：任务 13。

### 占位符扫描

本文档没有使用“待定”、“TODO”、“后续实现”作为步骤内容。每个代码任务都包含具体文件、测试、代码片段、命令和预期结果。

### 类型一致性

- `VerificationMetadata` 在任务 6 定义，任务 7 和任务 9 复用同一字段名。
- `RollbackPreview` 在任务 4 定义，TUI 使用 `text` 和 `confirmationToken`。
- `ModelCapabilityCard` 在任务 11 定义，测试和路由函数使用同一字段名。
- `SymbolEntry` 在任务 10 定义，context bundle 使用同一类型。

### 范围检查

P2.2 是一个 staged plan。任务 1-8 是发布 hard gate，必须先完成；任务 9-12 是能力增强层，可以在 hard gate 全部通过后分批并行执行。
