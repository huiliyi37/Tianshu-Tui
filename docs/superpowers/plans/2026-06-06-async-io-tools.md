# 工具层 Async I/O 转换计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除工具执行路径上所有同步 I/O 对事件循环的阻塞，让 Ctrl+C / abort signal 在 await 点生效。

**架构：** 将 `fs` sync 调用替换为 `node:fs/promises` async 等价物。写入操作统一使用 `writeFileAtomicAsync`（已有）。递归目录遍历（glob、repo-map、file-info）改为 async 迭代。`readFilePayload` 从 sync 函数改为 async，所有调用者适配。

**技术栈：** Node.js 22+, `node:fs/promises`, 已有的 `src/fs-atomic.ts`

---

## 已完成

- [x] write-file.ts → async + atomic write (commit d05dda3)
- [x] edit.ts → async + atomic write (commit d05dda3)
- [x] hash-edit.ts → async + atomic write (commit d05dda3)
- [x] apply-patch.ts → spawnSync → spawn + abort signal (commit f751068)
- [x] read-file.ts → readFilePayload async, stat/readFile from node:fs/promises (commit fa90d29)
- [x] prewarm-file.ts → await buildPrewarmValue, sync version removed (commit fa90d29)
- [x] gitignore.ts → async factory GitignoreFilter.create(), sync dead code removed (commit fa90d29)
- [x] glob.ts → walkDir async, readdir/lstat/realpath from node:fs/promises (commit 9796ee8)
- [x] grep.ts → await GitignoreFilter.create(), lstat/readdir/realpath async (commit 9796ee8)
- [x] repo-map.ts → buildTree async, readdir/stat from node:fs/promises (commit 9796ee8)
- [x] file-info.ts → scanDirectory async, readdir/stat from node:fs/promises (commit 9796ee8)
- [x] run-tests.ts → detectTestCommand async, stat/readFile from node:fs/promises (commit 9796ee8)
- [x] plan-close.ts → readFile/stat async + writeFileAtomicAsync (commit 9796ee8)
- [x] import-resource.ts → stat/readFile/readdir async (commit 9796ee8)
- [x] recall.ts → readdir/readFile async (commit 9796ee8)
- [x] inspect-project.ts → readdir/stat/readFile async (commit 9796ee8)
- [x] related-tests.ts → stat-based fileExists async (commit 9796ee8)
- [x] read-section.ts → stat async for size guard (commit 9796ee8)

**全部 18 个文件转换完成。** 审计 commit `5466af9` 确认无代码缺陷。

### 遗留小项（非阻塞）
- gitignore.ts 构造函数 sync 路径已删除（2026-06-06 清理）
- plan-close.ts 已从 raw writeFile 改为 writeFileAtomicAsync（2026-06-06 清理）
- AbortSignal 传递未做（全局性改动，收益有限，可独立立项）

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|---------|
| `src/tools/read-file.ts` | 核心：readFilePayload sync→async，所有 sync I/O 换 async | 重构 |
| `src/agent/prewarm-file.ts` | 调用 readFilePayload，适配 async | 改调用方 |
| `src/tools/gitignore.ts` | readFileSync → readFile, 构造函数 async 化 | 重构 |
| `src/tools/glob.ts` | walkDir sync→async, readdirSync→readdir | 重构 |
| `src/tools/grep.ts` | new GitignoreFilter → await createGitignoreFilter | 改调用方 |
| `src/tools/repo-map.ts` | buildTree sync→async, readdirSync→readdir | 重构 |
| `src/tools/file-info.ts` | scanDirectory sync→async | 重构 |
| `src/tools/run-tests.ts` | readFileSync → readFile (仅 package.json, ~1KB) | 轻微 |
| `src/tools/plan-close.ts` | readFileSync/writeFileSync → async + atomic | 轻微 |
| `src/tools/import-resource.ts` | 大量 sync → async (cpSync 除外, Node 22 无 async 等价) | 重构 |
| `src/tools/recall.ts` | readdirSync + readFileSync → async | 轻微 |
| `src/tools/inspect-project.ts` | readdirSync + statSync + readFileSync → async | 中等 |
| `src/tools/related-tests.ts` | existsSync → access (或保留, 快) | 轻微 |
| `src/tools/read-section.ts` | statSync → stat | 轻微 |

**不动：** `src/tools/path-validate.ts` — `realpathSync` / `existsSync` 是微秒级调用，且被所有工具依赖，改为 async 会强制所有工具 await 它，改动面太大收益太小。

---

## 任务 1：gitignore.ts — async 工厂函数

**依赖：** 无（后续 read-file 和 glob 依赖此任务）

**文件：**
- 修改：`src/tools/gitignore.ts`

`GitignoreFilter` 构造函数内 `readFileSync` 读取 `.gitignore`。改为静态 async 工厂方法，保留 sync 版本给不关心阻塞的调用者。

- [ ] **步骤 1：添加 async 工厂方法**

在 `src/tools/gitignore.ts` 中：

```ts
// 在文件顶部替换 import
import { readFileSync as readFileSyncSync, existsSync } from 'fs'
import { readFile } from 'node:fs/promises'

// 在 GitignoreFilter 类中添加静态方法：
static async create(cwd: string): Promise<GitignoreFilter> {
  const gitignorePath = join(cwd, '.gitignore')
  if (!existsSync(gitignorePath)) return new GitignoreFilter(cwd)
  const content = await readFile(gitignorePath, 'utf-8')
  // 复用构造函数的解析逻辑，但跳过 readFileSync
  const filter = new GitignoreFilter(cwd)
  filter.rules = parseGitignore(content)
  return filter
}
```

注意：需要检查 `GitignoreFilter` 类内部结构，将 rule 解析逻辑提取为可复用的纯函数。如果构造函数直接在 `constructor` 里读文件，需要把解析逻辑提取出来让 `create()` 复用。

- [ ] **步骤 2：运行 typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
```

- [ ] **步骤 3：Commit**

```bash
git add src/tools/gitignore.ts
git commit -m "refactor(gitignore): add async factory method for non-blocking .gitignore reads"
```

---

## 任务 2：read-file.ts — readFilePayload sync→async

**依赖：** 任务 1（gitignore async 工厂）

**文件：**
- 修改：`src/tools/read-file.ts`
- 修改：`src/agent/prewarm-file.ts`

这是改动最大的任务。`readFilePayload` 从 sync 函数改为 async，所有调用者适配。

- [ ] **步骤 1：转换 readFilePayload 为 async**

在 `src/tools/read-file.ts` 中：

```ts
// 顶部 import 改为：
import { existsSync } from 'fs'
import { stat, readFile } from 'node:fs/promises'

// 函数签名改为 async：
export async function readFilePayload(cwd: string, options: ReadFilePayloadOptions): Promise<ReadFilePayload> {
```

具体替换：
- `existsSync(filePath)` + `statSync(filePath)` → 合并为 `await stat(filePath)` + catch（与 d05dda3 在 edit.ts 的模式一致）
- `readFileSync(filePath, 'utf-8')` → `await readFile(filePath, 'utf-8')`
- `getGitignoreFilter(cwd)` → 如果 gitignore 也改为 async，这里需要 `await getGitignoreFilter(cwd)`

**gitignore 缓存问题：** `getGitignoreFilter` 内部有缓存 + TTL。如果改为 async，首次 miss 需要 await，后续 hit 直接返回缓存。方案：返回 `Promise<GitignoreFilter>`，缓存 `Promise` 而非实例。

```ts
const gitignoreCache = new Map<string, { filter: Promise<GitignoreFilter>; ts: number }>()

function getGitignoreFilter(cwd: string): Promise<GitignoreFilter> {
  const cached = gitignoreCache.get(cwd)
  if (cached && Date.now() - cached.ts < GITIGNORE_CACHE_TTL) return cached.filter
  const filterPromise = GitignoreFilter.create(cwd)
  gitignoreCache.set(cwd, { filter: filterPromise, ts: Date.now() })
  return filterPromise
}
```

- [ ] **步骤 2：适配 read-file.ts 内部调用者**

read-file.ts 内有两处调用 `readFilePayload`：
- `:387` — 单文件读取
- `:518` — 多文件读取循环

两者已在 `async execute()` 内，加 `await` 即可。

- [ ] **步骤 3：适配 prewarm-file.ts**

```ts
// buildPrewarmValue — 改为 async（已是）
export async function buildPrewarmValue(cwd: string, filePath: string): Promise<PrewarmValue | undefined> {
  try {
    const payload = await readFilePayload(cwd, { filePath })
    // ...
  }
}
```

`buildPrewarmValue` 的 sync 版本（`:21`）需要移除或改为调用 async 版本。检查是否有 sync 调用者：

```bash
grep -rn "buildPrewarmValue[^A]" src/ --include="*.ts" | grep -v __tests__
```

如果有 sync 调用者，保留 sync 版本但标记 deprecated；否则直接删除。

- [ ] **步骤 4：运行测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
npx tsx --test src/tools/__tests__/read-file.test.ts
```

- [ ] **步骤 5：Commit**

```bash
git add src/tools/read-file.ts src/agent/prewarm-file.ts
git commit -m "refactor(read-file): convert readFilePayload to async — eliminates largest sync I/O blocker"
```

---

## 任务 3：glob.ts — 递归 walkDir sync→async

**依赖：** 任务 1（gitignore async 工厂）

**文件：**
- 修改：`src/tools/glob.ts`

递归目录遍历，`readdirSync` + `lstatSync` × N 个文件。改为 async 让每次 readdir/stat 都让出事件循环。

- [ ] **步骤 1：转换 walkDir 为 async**

```ts
import { readdir, lstat, realpath } from 'node:fs/promises'

async function walkDir(
  dir: string,
  results: string[],
  root: string,
  filter: RegExp | undefined,
  visited = new Set<string>(),
): Promise<void> {
  if (results.length >= MAX_RESULTS) return

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (results.length >= MAX_RESULTS) return
    const fullPath = join(dir, name)
    let s: Awaited<ReturnType<typeof lstat>>
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }

    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      await walkDir(fullPath, results, root, filter, visited)
    } else if (s.isFile()) {
      const rel = relative(root, fullPath)
      if (!filter || filter.test(rel)) {
        results.push(rel)
      }
    }
  }
}
```

- [ ] **步骤 2：适配 execute 方法**

```ts
// execute 内部：
const gitignore = await GitignoreFilter.create(params.cwd)
const files: string[] = []
await walkDir(searchRoot, files, searchRoot, regex)
```

入口 `existsSync` + `lstatSync` 也改为 async：

```ts
try {
  const rootStat = await stat(searchRoot)
  if (!rootStat.isDirectory()) {
    return { content: `Error: Not a directory: ${searchRoot}`, isError: true }
  }
} catch {
  return { content: `Error: Cannot access path: ${searchRoot}`, isError: true }
}
```

- [ ] **步骤 3：运行测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
npx tsx --test src/tools/__tests__/glob.test.ts
```

- [ ] **步骤 4：Commit**

```bash
git add src/tools/glob.ts
git commit -m "refactor(glob): convert recursive walkDir to async — no longer blocks event loop during directory traversal"
```

---

## 任务 4：repo-map.ts — buildTree sync→async

**文件：**
- 修改：`src/tools/repo-map.ts`

与 glob 相同模式：递归 `readdirSync` + `statSync`。

- [ ] **步骤 1：转换 buildTree 为 async**

```ts
import { readdir, stat } from 'node:fs/promises'

async function buildTree(dir: string, depth: number, fileCount: { n: number }, maxFiles: number, maxDepth: number): Promise<TreeNode[]> {
  // 同 glob 的模式：readdir → for each → stat → recurse
}
```

- [ ] **步骤 2：适配 execute 方法**

入口 existsSync + statSync 改为 `await stat()` + catch。`await buildTree(...)`。

- [ ] **步骤 3：运行测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
npx tsx --test src/tools/__tests__/repo-map.test.ts
```

- [ ] **步骤 4：Commit**

```bash
git add src/tools/repo-map.ts
git commit -m "refactor(repo-map): convert buildTree to async"
```

---

## 任务 5：file-info.ts — scanDirectory sync→async

**文件：**
- 修改：`src/tools/file-info.ts`

`scanDirectory` 递归 `readdirSync` + `statSync`。改为 async。

- [ ] **步骤 1：转换 scanDirectory + execute**

```ts
import { stat, lstat, readdir } from 'node:fs/promises'

async function scanDirectory(dir: string): Promise<DirScanResult> {
  let fileCount = 0
  let totalSize = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const sub = await scanDirectory(join(dir, entry.name))
        fileCount += sub.fileCount
        totalSize += sub.totalSize
      } else if (entry.isFile()) {
        fileCount++
        try {
          const s = await stat(join(dir, entry.name))
          totalSize += s.size
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return { fileCount, totalSize }
}
```

execute 中的 `lstatSync` → `await lstat()`，`statSync` → `await stat()`，`existsSync` → try `await lstat()`。

- [ ] **步骤 2：运行测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
npx tsx --test src/tools/__tests__/file-info.test.ts
```

- [ ] **步骤 3：Commit**

```bash
git add src/tools/file-info.ts
git commit -m "refactor(file-info): convert scanDirectory to async"
```

---

## 任务 6：grep.ts — 适配 gitignore async

**文件：**
- 修改：`src/tools/grep.ts`（`:271` 处 `new GitignoreFilter`）

- [ ] **步骤 1：替换构造函数调用**

```ts
// 原：const filter = new GitignoreFilter(cwd)
// 改：const filter = await GitignoreFilter.create(cwd)
```

需要在文件顶部更新 import。确认 `execute` 方法已标记 `async`。

- [ ] **步骤 2：运行测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
npx tsx --test src/tools/__tests__/grep.test.ts
```

- [ ] **步骤 3：Commit**

```bash
git add src/tools/grep.ts
git commit -m "refactor(grep): use async gitignore factory"
```

---

## 任务 7：run-tests.ts + plan-close.ts + recall.ts + read-section.ts

**文件：**
- 修改：`src/tools/run-tests.ts`
- 修改：`src/tools/plan-close.ts`
- 修改：`src/tools/recall.ts`
- 修改：`src/tools/read-section.ts`

这些都是简单替换，改动小且独立，可合并为一个 commit。

- [ ] **步骤 1：run-tests.ts**

```ts
// 顶部：import { readFile } from 'node:fs/promises'
// :19  existsSync → 保留（快）
// :23  readFileSync(pkgPath, 'utf-8') → await readFile(pkgPath, 'utf-8')
```

- [ ] **步骤 2：plan-close.ts**

```ts
// 顶部：import { readFile } from 'node:fs/promises'; import { writeFileAtomicAsync } from '../fs-atomic.js'
// :78  existsSync → 保留
// :88  readFileSync → await readFile
// :98  writeFileSync → await writeFileAtomicAsync
```

- [ ] **步骤 3：recall.ts**

```ts
// 顶部：import { readdir, readFile } from 'node:fs/promises'
// :36  existsSync → 保留
// :42  readdirSync → await readdir
// :44  readFileSync → await readFile
```

- [ ] **步骤 4：read-section.ts**

```ts
// 顶部：import { stat } from 'node:fs/promises'
// :149  statSync → await stat
```

- [ ] **步骤 5：运行 typecheck + 相关测试**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
```

- [ ] **步骤 6：Commit**

```bash
git add src/tools/run-tests.ts src/tools/plan-close.ts src/tools/recall.ts src/tools/read-section.ts
git commit -m "refactor(tools): convert remaining sync I/O to async in run-tests, plan-close, recall, read-section"
```

---

## 任务 8：inspect-project.ts — async 目录遍历

**文件：**
- 修改：`src/tools/inspect-project.ts`

类似 repo-map，递归 `readdirSync` + `statSync` + `readFileSync`。

- [ ] **步骤 1：转换内部遍历函数为 async**

`buildFileTree` 和 `detectProjectInfo` 中的所有 sync I/O 替换。模式同 repo-map 任务。

- [ ] **步骤 2：运行 typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
```

- [ ] **步骤 3：Commit**

```bash
git add src/tools/inspect-project.ts
git commit -m "refactor(inspect-project): convert to async I/O"
```

---

## 任务 9：import-resource.ts — 大量 sync 转换

**文件：**
- 修改：`src/tools/import-resource.ts`

这个文件 sync 调用最多（cpSync、rmSync、symlinkSync、mkdirSync、readFileSync、writeFileSync 等）。注意 Node 22 的 `cpSync` 没有 async 等价物（`cp` 在 `node:fs/promises` 中是实验性的），需要用 `spawn('cp', ...)` 或保留 sync 但加注释说明。

- [ ] **步骤 1：转换可转换的部分**

- `readFileSync` → `await readFile`
- `writeFileSync` → `await writeFileAtomicAsync`
- `mkdirSync` → `await mkdir`
- `rmSync` → `await rm` (from `node:fs/promises`)
- `lstatSync` → `await lstat`
- `readdirSync` → `await readdir`
- `statSync` → `await stat`
- `symlinkSync` → `await symlink` (from `node:fs/promises`)
- `cpSync` → `await cp` (from `node:fs/promises`, Node 16.7+) 或 `await spawn('cp', ['-r', src, dst])`
- `execFileSync` → `await execFile` (from `node:child_process')

- [ ] **步骤 2：运行 typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
```

- [ ] **步骤 3：Commit**

```bash
git add src/tools/import-resource.ts
git commit -m "refactor(import-resource): convert sync I/O to async"
```

---

## 任务 10：related-tests.ts — existsSync 清理

**文件：**
- 修改：`src/tools/related-tests.ts`

仅 `existsSync` 检查文件是否存在。这些是微秒级操作，改为 `access` 或保留不变。

**决策：** `existsSync` 在 `related-tests.ts` 中对每个候选文件调用一次（~10 个文件），总阻塞 <1ms。建议 **保留不变**，避免不必要改动。

- [ ] **步骤 1：确认不需要改动，在 commit message 中注明**

---

## 任务 11：最终验证

- [ ] **步骤 1：全量 typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -v loop.ts
```

- [ ] **步骤 2：全量测试**

```bash
npm test
```

- [ ] **步骤 3：确认无 sync I/O 残留**

```bash
grep -rn "readFileSync\|writeFileSync\|readdirSync\|lstatSync\|spawnSync\|execFileSync" src/tools/ --include="*.ts" | grep -v __tests__ | grep -v syntax-check
```

预期：只剩 `path-validate.ts`（realpathSync, existsSync）和 `syntax-check.ts`（注释）。

- [ ] **步骤 4：最终 commit（如有需要）**

```bash
git add -A
git commit -m "chore: async I/O conversion complete — all tool execution paths now yield to event loop"
```

---

## 自检

**1. 规格覆盖度：** 所有在扫描中发现的 sync I/O 工具都有对应任务。path-validate 明确标注不动及原因。

**2. 占位符扫描：** 每个步骤有具体的代码片段或精确的替换指令。无 "TODO" / "后续实现" / "添加错误处理"。

**3. 类型一致性：** 所有 async 函数返回 `Promise<T>`。调用者使用 `await`。`GitignoreFilter.create()` 返回 `Promise<GitignoreFilter>`，缓存存储 Promise 实例。

**4. 遗漏检查：**
- `process-kill.ts:30` 的 `spawnSync('taskkill', ...)` — Windows-only，且该工具本身就是用于杀进程，sync 在这里语义合理。标注为不动。
- `syntax-check.ts` — 只有注释引用 writeFileSync，无实际调用。不动。
