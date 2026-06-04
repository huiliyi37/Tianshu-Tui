# Windows 兼容性适配计划

## 目标

让天枢 TUI 能在 Windows（PowerShell / Git Bash / CMD）上完整运行：安装、启动、对话、工具执行、TUI 渲染。

## 问题全景（按严重度排序）

### P0 — 阻断：程序无法启动或核心工具直接崩溃

| # | 文件:行号 | 问题 | Windows 表现 |
|---|-----------|------|-------------|
| 1 | `src/tools/bash.ts:105` | `spawn('sh', ['-c', command])` 硬编码 `sh` | `ENOENT` — sh 不存在 |
| 2 | `src/tools/process-kill.ts:13` | `kill(-child.pid, signal)` — 负 PID（进程组）| `EINVAL` / 杀不掉进程 |
| 3 | `src/tools/process-kill.ts` | SIGTERM / SIGKILL 信号 | Windows 不支持 POSIX 信号 |

### P1 — 严重：关键功能不可用

| # | 文件:行号 | 问题 | Windows 表现 |
|---|-----------|------|-------------|
| 4 | `src/tools/grep.ts:182` | `spawn('rg', args)` — 依赖 ripgrep | `ENOENT`（未安装 rg） |
| 5 | `src/lsp/client.ts:11` | `execSync('npx tsc ... 2>&1')` shell 重定向 | CMD 下 `2>&1` 语义不同 |
| 6 | `src/tools/run-tests.ts:47` | `find src -name '*.test.ts'` Unix 命令 | `ENOENT` — find 不存在 |
| 7 | `src/tools/import-resource.ts:213` | `execFileSync('curl', ...)` 下载 | Win10+ 有 curl，旧版没有 |
| 8 | `src/tools/import-resource.ts:145` | `~` 展开用 `process.env.HOME` | Windows 用 `%USERPROFILE%` |
| 9 | `src/tui/external-editor.ts:6` | 默认编辑器 `vi` | Windows 上 `vi` 不存在 |
| 10 | `better-sqlite3` | 原生 C++ 编译模块 | 需要 node-gyp + VS Build Tools |

### P2 — 中等：功能降级或行为不一致

| # | 文件:行号 | 问题 | Windows 表现 |
|---|-----------|------|-------------|
| 11 | `src/tools/bash.ts:18` | SAFE_ENV_PREFIXES 含 Unix 特有变量 | 无害但冗余 |
| 12 | `src/tools/git.ts:73-77` | SIGTERM → SIGKILL 超时杀进程 | 部分场景杀不干净 |
| 13 | `src/tools/diff.ts:84` | `child.kill('SIGTERM')` | 同上 |
| 14 | `src/tools/grep.ts:196,206` | `child.kill('SIGTERM')` | 同上 |
| 15 | 测试脚本 | `find src`, `&&`, backtick 拼接 | Windows CMD 不兼容 |

## 解决方案

### Phase 1：平台抽象层（P0 修复）

**目标**：建立 `src/platform.ts`，提供跨平台的 shell 执行、进程终止、路径展开能力。

#### 1.1 `src/platform.ts` — 平台检测与 shell 执行

```typescript
// 核心 API
export function getShellCommand(): { cmd: string; args: string[] }
export function terminateProcess(child: ChildProcess, signal?: 'SIGTERM' | 'SIGKILL'): void
export function terminateProcessTree(pid: number, signal?: 'SIGTERM' | 'SIGKILL'): void
export function expandHome(path: string): string
export function getDefaultEditor(): string
```

- **Windows**: `cmd.exe /c` 或检测 `ComSpec`
- **Unix**: `sh -c`（保持现有行为）
- `terminateProcessTree`：Windows 用 `taskkill /T /PID`，Unix 保持 `kill -pgid`

#### 1.2 改造 `bash.ts`

```typescript
// Before
spawn('sh', ['-c', command], opts)

// After
const { cmd, args } = getShellCommand()
spawn(cmd, [...args, command], opts)
```

#### 1.3 改造 `process-kill.ts`

```typescript
// Before
kill(-child.pid, signal)  // 进程组杀

// After
if (process.platform === 'win32') {
  spawnSync('taskkill', ['/T', '/PID', String(child.pid), '/F'])
} else {
  kill(-child.pid, signal)
}
```

### Phase 2：工具层适配（P1 修复）

#### 2.1 `grep.ts` — ripgrep 降级

在 `rg` 不可用时降级到 Node.js 原生 `fs.readFileSync` + `RegExp` 遍历：

```typescript
try {
  child = track(spawn('rg', args, ...))
} catch {
  // fallback: Node.js file walking
  return nodeGrepFallback(pattern, absPath, opts)
}
```

#### 2.2 `run-tests.ts:47` — `find` 命令替代

```typescript
// Before
execSync(`find src -name '*.test.ts' -path '*${filter}*' | head -5`)

// After
import { globSync } from 'node:fs'
const files = globSync(`src/**/*${filter}*.test.ts`).slice(0, 5)
```

#### 2.3 `lsp/client.ts:11` — shell 重定向修复

```typescript
// Before
execSync('npx tsc --noEmit --pretty false 2>&1', { ... })

// After
const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
  cwd, encoding: 'utf-8', timeout: 30_000,
  stdio: ['pipe', 'pipe', 'pipe'],
})
const output = (result.stdout || '') + (result.stderr || '')
```

#### 2.4 `import-resource.ts` — HOME 展开 + curl 降级

```typescript
// Before
source.replace(/^~/, process.env.HOME ?? '~')

// After
source.replace(/^~/, homedir())
```

curl → 先尝试 `curl`，失败则用 Node.js `undici`（已在依赖中）fetch。

#### 2.5 `external-editor.ts` — 默认编辑器

```typescript
// Before
return process.env['VISUAL'] || process.env['EDITOR'] || 'vi'

// After
if (process.platform === 'win32') {
  return process.env['VISUAL'] || process.env['EDITOR'] || 'notepad'
}
return process.env['VISUAL'] || process.env['EDITOR'] || 'vi'
```

### Phase 3：进程信号统一 + 测试修复

#### 3.1 统一所有 `child.kill('SIGTERM')` 调用

创建 `platform.ts` 中的 `gracefulKill(child)` 和 `forceKill(child)`：
- Unix: SIGTERM / SIGKILL
- Windows: `taskkill /T /PID` / `taskkill /T /PID /F`

搜索替换所有直接 `child.kill('SIGTERM')` 和 `child.kill('SIGKILL')` 调用。

影响文件：
- `src/tools/git.ts`
- `src/tools/diff.ts`
- `src/tools/grep.ts`
- `src/tools/run-tests.ts`
- `src/agent/theta-check.ts`

#### 3.2 测试脚本修复

`package.json` 的 `scripts.test` 用 `$(find ...)` 语法 — 替换为 `glob` 或条件判断：

```json
{
  "test": "node --test $(find src -name '*.test.ts') 2>/dev/null || tsx scripts/run-all-tests.ts"
}
```

或者用跨平台 glob 工具（如 `glob` npm 包或 Node.js 内置 `glob`）。

### Phase 4：构建与分发

#### 4.1 CI 增加 Windows runner

在 GitHub Actions 中增加 `windows-latest` matrix：
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
runs-on: ${{ matrix.os }}
```

#### 4.2 `better-sqlite3` 预编译

考虑使用 `better-sqlite3` 的 prebuild 机制，或在 README 中明确说明 Windows 需要：
```
npm install -g windows-build-tools
```

或切换到 `sql.js`（纯 WASM，无原生编译），但这会损失性能，作为最后手段。

## 文件改动清单

| 文件 | 改动类型 | Phase |
|------|---------|-------|
| `src/platform.ts` | **新建** | 1 |
| `src/tools/bash.ts` | 修改 | 1 |
| `src/tools/process-kill.ts` | 修改 | 1 |
| `src/tools/process-tracker.ts` | 修改 | 1 |
| `src/tools/grep.ts` | 修改 | 2 |
| `src/tools/run-tests.ts` | 修改 | 2 |
| `src/lsp/client.ts` | 修改 | 2 |
| `src/tools/import-resource.ts` | 修改 | 2 |
| `src/tui/external-editor.ts` | 修改 | 2 |
| `src/tools/git.ts` | 修改 | 3 |
| `src/tools/diff.ts` | 修改 | 3 |
| `src/agent/theta-check.ts` | 修改 | 3 |
| `package.json` | 修改 | 3 |
| `src/platform.ts` | 测试 | 1 |
| `src/__tests__/platform.test.ts` | **新建** | 1 |

## 执行顺序

```
Phase 1 (P0 阻断) → Phase 2 (P1 关键) → Phase 3 (P2 清理) → Phase 4 (CI)
```

每个 Phase 内按文件逐个提交，每改一个文件 → typecheck → 相关测试 → deliver。

## 估算工作量

- Phase 1: ~2 小时（核心，必须先做）
- Phase 2: ~3 小时（每个工具独立）
- Phase 3: ~1.5 小时（搜索替换 + 测试）
- Phase 4: ~1 小时（CI 配置）

总计 ~7.5 小时，可拆成 8-10 个独立提交。

---

## 执行状态

### ✅ 已完成 (3 commits, 2026-06-11)

| Commit | Phase | 文件 |
|--------|-------|------|
| `a0f92b4` | Phase 1 | `src/platform.ts` (new), `src/tools/bash.ts`, `src/tools/process-kill.ts` |
| `3ec1f86` | Phase 2a | `src/tui/external-editor.ts`, `src/tools/import-resource.ts` |
| `73e32a8` | Phase 2b+3 | `src/lsp/client.ts`, `src/tools/run-tests.ts`, `src/tools/diff.ts`, `src/tools/grep.ts`, `src/agent/theta-check.ts` |

**已修复问题**: #1 #2 #3 #5 #6 #7 #8 #9 #13 #14（10/15）

### 📋 待办

| # | 优先级 | 内容 | 说明 |
|---|--------|------|------|
| 10 | P1 | `better-sqlite3` 原生模块 | 见下方专项计划 |
| 15 | P2 | `package.json` test 脚本 | `$(find ...)` → `glob` |
| — | P2 | CI Windows runner | GitHub Actions matrix |

---

## 专项计划：better-sqlite3 Windows 兼容

### 背景

`better-sqlite3` (v12.10.0) 是一个 C++ 原生模块，通过 `node-gyp` 编译。
在 Windows 上 `npm install` 需要 Visual Studio Build Tools（~4GB）。

**使用位置**:
- `src/repo/meridian-db.ts:1` — 同步 import（代码图谱持久化）
- `src/agent/session-registry.ts:98` — 动态 import（会话注册表）

### 方案对比

| 方案 | 安装体验 | 性能 | API 兼容 | 风险 |
|------|---------|------|---------|------|
| **A: 依赖 prebuild** | 零配置 | 原生 | 100% | prebuild 不存在时回退到编译 |
| **B: 切换到 sql.js** | 零配置 | ~50% | 90% | 同步 API → 需适配异步初始化 |

### 推荐方案：A（prebuild 优先）

`better-sqlite3` v12.x 已为 Windows x64/arm64 提供 [prebuildify](https://github.com/WiseLibs/better-sqlite3/blob/master/package.json) 预编译二进制。
`npm install` 时应自动下载 prebuild，无需 VS Build Tools。

**验证步骤**:
1. 在 Windows 机器上 `npm install`，观察是否触发 node-gyp 编译
2. 如果 prebuild 下载失败，检查 `npm` 日志确认原因
3. 如果确实无法获取 prebuild，再考虑方案 B

### 兜底方案：sql.js 降级

如果 prebuild 不可行，可以创建一个 `better-sqlite3` 兼容层：

```typescript
// src/repo/sqlite-adapter.ts
import initSqlJs from 'sql.js'

// 提供与 better-sqlite3 兼容的同步 API
export class SqliteAdapter {
  private db: any  // sql.js Database
  static async create(path: string): Promise<SqliteAdapter> {
    const SQL = await initSqlJs()
    // sql.js 是异步初始化，但之后所有操作是同步的
  }
  exec(sql: string): void { ... }
  prepare(sql: string): Statement { ... }
}
```

**代价**:
- 需安装 `sql.js` (约 1.2MB WASM)
- 首次初始化需异步加载 WASM
- 大查询性能约为 better-sqlite3 的 50%
- 需适配两处调用点（meridian-db.ts, session-registry.ts）

**估计工作量**: 3-4 小时（含测试）

### 执行建议

1. 先在 Windows 上试 `npm install` → 大概率 prebuild 直接可用
2. 如果不行，优先排查 prebuild 失败原因（网络/Node版本/架构）
3. sql.js 方案作为最后防线
