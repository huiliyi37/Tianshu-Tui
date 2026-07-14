# 桌面封版单架构裁剪 + 启动瘦身 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让每个 macOS/Windows 封版安装包只携带**目标架构**的 Node 与原生依赖，把 `.app` 从 ~370MB 压到 ~220MB 量级，并降低首次打开 / sidecar 冷启动的磁盘与扫描税；随后可选裁剪 runtime `node_modules` 与 serve 启动闭包。

**架构：** 打包政策从「每个包打进双架构原生、运行时自选」改为「每个 `--target` 产物只含本架构」。在 `fetch-node-runtime` / `stage-runtime-deps` / `build-mac.sh` 三处按 `TAURI_ENV_TARGET_TRIPLE` 裁剪；用封版验收脚本断言异架构文件不存在。第二波再砍 typescript / tree-sitter 全量 grammar；第三波（可选）延后 serve 重依赖 `import()`。

**技术栈：** Tauri v2 打包、`desktop/scripts/build-mac.sh`、`fetch-node-runtime.js`、`stage-runtime-deps.js`、`pack-native.js`、hdiutil DMG

**基线（本机实测，2026-07-14）：**

| 产物 | 现状 |
|------|------|
| `Tianshu_2.19.2_aarch64.dmg` 内 `.app` | ~371MB |
| `node-runtime/` | 224MB（darwin-arm64 **+** darwin-x64） |
| `rivet-runtime/node_modules` | ~124MB（含双 arch esbuild/ast-grep、typescript 23MB、tree-sitter-wasms 49MB） |
| 封版 sidecar → `/health`（干净 RIVET_HOME） | 冷 ~3.6s / 热 ~1.9s |

**明确不在本计划范围：** 本地 `tauri dev`、会话 `events.jsonl` 懒加载（已正确）、前端 2.4MB 主包拆分（可另开计划）。

---

## 文件结构（将创建 / 修改）

| 文件 | 职责 |
|------|------|
| `desktop/scripts/prune-bundle-arch.js`（新建） | 按目标 triple 删除异架构 Node / esbuild / ast-grep；可在 beforeBuild 末尾或 build-mac 每轮 tauri 前调用 |
| `desktop/scripts/fetch-node-runtime.js` | 拉取目标 arch 后，清理 `resources/node` 下其他 `*-*` 目录 |
| `scripts/stage-runtime-deps.js` | staging 时跳过异架构 optional 平台包；可选 trim typescript/tree-sitter |
| `desktop/scripts/build-mac.sh` | 改为「只保证**当前要打的 arch** 的平台包存在」，不再强制双 arch 同包 |
| `desktop/scripts/assert-bundle-arch.js`（新建） | 封版验收：扫描 `.app`，异架构文件 → exit 1 |
| `docs/DESKTOP-RELEASE-MAC.md` | 更新政策：单架构包、验收命令、体积预期 |
| `docs/changelog/2026-07-14-desktop-single-arch-bundle.md`（新建） | 复盘：为何改政策、ROI、验收数字 |

---

## Wave A — 单架构打包（主收益，必须先做）

### 任务 1：新建 `prune-bundle-arch.js`（可单测的纯函数）

**文件：**
- 创建：`desktop/scripts/prune-bundle-arch.js`
- 测试：`desktop/scripts/__tests__/prune-bundle-arch.test.ts`

- [ ] **步骤 1：写失败测试 — 解析目标 arch + 列出应删路径**

```ts
// desktop/scripts/__tests__/prune-bundle-arch.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveKeepArch,
  planPrunePaths,
  pruneBundleArch,
} from '../prune-bundle-arch.js'

test('resolveKeepArch maps apple triples', () => {
  assert.equal(resolveKeepArch('aarch64-apple-darwin'), 'arm64')
  assert.equal(resolveKeepArch('x86_64-apple-darwin'), 'x64')
})

test('planPrunePaths keeps only target node + native platform pkgs', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'))
  const nodeRoot = join(root, 'node-runtime')
  mkdirSync(join(nodeRoot, 'darwin-arm64'), { recursive: true })
  mkdirSync(join(nodeRoot, 'darwin-x64'), { recursive: true })
  writeFileSync(join(nodeRoot, 'darwin-arm64', 'node'), 'arm')
  writeFileSync(join(nodeRoot, 'darwin-x64', 'node'), 'x64')
  const nm = join(root, 'rivet-runtime', 'node_modules')
  mkdirSync(join(nm, '@esbuild', 'darwin-arm64'), { recursive: true })
  mkdirSync(join(nm, '@esbuild', 'darwin-x64'), { recursive: true })
  mkdirSync(join(nm, '@ast-grep', 'napi-darwin-arm64'), { recursive: true })
  mkdirSync(join(nm, '@ast-grep', 'napi-darwin-x64'), { recursive: true })

  const plan = planPrunePaths(root, 'arm64')
  assert.ok(plan.some((p) => p.endsWith(join('darwin-x64'))))
  assert.ok(!plan.some((p) => p.endsWith(join('darwin-arm64'))))
  assert.ok(plan.some((p) => p.includes('@esbuild') && p.includes('darwin-x64')))
  assert.ok(plan.some((p) => p.includes('napi-darwin-x64')))

  pruneBundleArch(root, 'arm64')
  assert.equal(existsSync(join(nodeRoot, 'darwin-x64')), false)
  assert.equal(existsSync(join(nodeRoot, 'darwin-arm64')), true)
  assert.equal(existsSync(join(nm, '@esbuild', 'darwin-x64')), false)
  assert.equal(existsSync(join(nm, '@esbuild', 'darwin-arm64')), true)
  rmSync(root, { recursive: true, force: true })
})
```

- [ ] **步骤 2：跑测试确认失败**

```bash
npm exec -- tsx --test desktop/scripts/__tests__/prune-bundle-arch.test.ts
```

预期：FAIL（模块不存在）

- [ ] **步骤 3：实现最少代码**

```js
// desktop/scripts/prune-bundle-arch.js
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** @param {string} triple e.g. aarch64-apple-darwin */
export function resolveKeepArch(triple) {
  const t = (triple || process.env.TAURI_ENV_TARGET_TRIPLE || '').trim()
  if (t.includes('aarch64') || t.endsWith('arm64')) return 'arm64'
  if (t.includes('x86_64') || t.includes('i686')) return 'x64'
  return process.arch === 'arm64' ? 'arm64' : 'x64'
}

/**
 * @param {string} resourcesRoot  Contents/Resources 或 staging 根（含 node-runtime + rivet-runtime）
 * @param {'arm64'|'x64'} keep
 * @returns {string[]} absolute paths to delete
 */
export function planPrunePaths(resourcesRoot, keep) {
  const drop = keep === 'arm64' ? 'x64' : 'arm64'
  const out = []
  const nodeRoot = join(resourcesRoot, 'node-runtime')
  if (existsSync(nodeRoot)) {
    for (const name of readdirSync(nodeRoot)) {
      // darwin-x64 / win-x64 / linux-x64 …
      if (name.endsWith(`-${drop}`) || name.includes(`-${drop}`)) {
        out.push(join(nodeRoot, name))
      }
    }
  }
  const nm = join(resourcesRoot, 'rivet-runtime', 'node_modules')
  const es = join(nm, '@esbuild')
  if (existsSync(es)) {
    for (const name of readdirSync(es)) {
      if (name.includes(drop)) out.push(join(es, name))
    }
  }
  const ag = join(nm, '@ast-grep')
  if (existsSync(ag)) {
    for (const name of readdirSync(ag)) {
      if (name.includes(drop)) out.push(join(ag, name))
    }
  }
  return out.filter((p) => existsSync(p))
}

export function pruneBundleArch(resourcesRoot, keep) {
  for (const p of planPrunePaths(resourcesRoot, keep)) {
    rmSync(p, { recursive: true, force: true })
  }
}

// CLI: node desktop/scripts/prune-bundle-arch.js <resourcesRoot> [triple]
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('prune-bundle-arch.js')) {
  const root = process.argv[2]
  const keep = resolveKeepArch(process.argv[3] || '')
  if (!root) {
    console.error('usage: prune-bundle-arch.js <resourcesRoot> [triple]')
    process.exit(2)
  }
  const plan = planPrunePaths(root, keep)
  console.log(`[prune-bundle-arch] keep=${keep} removing ${plan.length} path(s)`)
  pruneBundleArch(root, keep)
}
```

（CLI 入口检测按仓库 ESM 惯例微调，保证 `node desktop/scripts/prune-bundle-arch.js` 可跑。）

- [ ] **步骤 4：跑测试确认通过**

```bash
npm exec -- tsx --test desktop/scripts/__tests__/prune-bundle-arch.test.ts
```

预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add desktop/scripts/prune-bundle-arch.js desktop/scripts/__tests__/prune-bundle-arch.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): add prune-bundle-arch to drop non-target native runtimes

EOF
)"
```

---

### 任务 2：`fetch-node-runtime` 拉取后清掉异架构残留

**文件：**
- 修改：`desktop/scripts/fetch-node-runtime.js`（`main` / 写完 binary 之后）

根因：`resources/node/` 是累加目录；先后打 arm64 / x64 会留下两套，`tauri.conf.json` 的 `"resources/node": "node-runtime"` 会**整树打进每个包**。

- [ ] **步骤 1：在成功写出目标 binary 后增加清理**

在 `fetch-node-runtime.js` 末尾（binary + npm 拷贝完成、打印 success 之前）插入：

```js
  // Single-arch policy: each package must only ship the Node we just fetched.
  // Leftover sibling dirs from a previous --target build would otherwise be
  // copied wholesale into every .app via tauri.conf.json resources mapping.
  const resourcesNode = join(__dirname, '..', 'src-tauri', 'resources', 'node')
  if (existsSync(resourcesNode)) {
    for (const name of readdirSync(resourcesNode)) {
      if (name === '.gitkeep') continue
      if (name === `${platform}-${arch}`) continue
      const victim = join(resourcesNode, name)
      try {
        if (statSync(victim).isDirectory()) {
          rmSync(victim, { recursive: true, force: true })
          console.log(`[fetch-node-runtime] pruned sibling runtime ${name}`)
        }
      } catch { /* ignore */ }
    }
  }
```

需确保文件顶部已 `import { readdirSync, statSync, rmSync, ... }`（已有部分，补齐缺失）。

- [ ] **步骤 2：本地验证（不整包）**

```bash
# 模拟：先有两套目录
mkdir -p desktop/src-tauri/resources/node/darwin-x64
echo x > desktop/src-tauri/resources/node/darwin-x64/node
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin node desktop/scripts/fetch-node-runtime.js
ls desktop/src-tauri/resources/node
```

预期：只有 `darwin-arm64`（+ `.gitkeep`），无 `darwin-x64`。

- [ ] **步骤 3：Commit**

```bash
git add desktop/scripts/fetch-node-runtime.js
git commit -m "$(cat <<'EOF'
fix(desktop): prune non-target Node runtimes after fetch-node-runtime

EOF
)"
```

---

### 任务 3：`stage-runtime-deps` 跳过异架构平台包

**文件：**
- 修改：`scripts/stage-runtime-deps.js`

根因：`readDeps` 会把 `@esbuild` / `@ast-grep` 的 **optionalDependencies 全平台名**入队；若 `build-mac.sh` 已把两架构都解进 `node_modules`，staging 会两套都 `cpSync`。

- [ ] **步骤 1：增加平台包过滤器**

在 `ROOTS` 附近增加：

```js
import { resolveTargetTriple } from '../desktop/scripts/fetch-node-runtime.js'
// 若循环依赖麻烦：就地复制 resolveTargetArch（文件内已有）并扩展：

function isForeignPlatformPackage(name, keepArch) {
  // @esbuild/darwin-x64, @esbuild/win32-x64, @ast-grep/napi-darwin-arm64, …
  const m = name.match(/(?:^|\/)(?:darwin|linux|win32|windows)-(arm64|x64|ia32|arm)/)
    || name.match(/napi-(?:darwin|linux|win32)-(arm64|x64)/)
  if (!m) return false
  const pkgArch = m[1] === 'ia32' ? 'x86' : m[1]
  if (pkgArch === 'x86') return keepArch !== 'x64' // 罕见，保守
  return pkgArch !== keepArch
}
```

在 `while (queue)` 里 `cpSync` 之前：

```js
  const keepArch = resolveTargetArch() // 已有
  if (isForeignPlatformPackage(name, keepArch)) {
    console.log(`[stage-runtime-deps] skip foreign platform pkg ${name} (keep=${keepArch})`)
    continue
  }
```

- [ ] **步骤 2：单元覆盖（小测）**

在 `scripts/__tests__/stage-runtime-deps-filter.test.ts`（新建）测 `isForeignPlatformPackage`：导出该函数或抽到 `scripts/runtime-platform-filter.js`。

优先：**抽到** `scripts/runtime-platform-filter.js`，两边 import，避免测不到私有函数。

- [ ] **步骤 3：干跑 staging 检查体积**

```bash
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin node scripts/pack-native.js
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin node scripts/stage-runtime-deps.js
ls dist/node_modules/@esbuild
ls dist/node_modules/@ast-grep
du -sh dist/node_modules
```

预期：只有 `darwin-arm64`（及非平台包）；`du` 明显小于双 arch 时。

- [ ] **步骤 4：Commit**

```bash
git add scripts/stage-runtime-deps.js scripts/runtime-platform-filter.js scripts/__tests__/stage-runtime-deps-filter.test.ts
git commit -m "$(cat <<'EOF'
fix(build): stage only target-arch esbuild/ast-grep into rivet-runtime

EOF
)"
```

---

### 任务 4：改 `build-mac.sh` 政策 + 打完后 prune 验收

**文件：**
- 修改：`desktop/scripts/build-mac.sh`
- 创建：`desktop/scripts/assert-bundle-arch.js`

- [ ] **步骤 1：`ensure_cross_pkg` 改为按当前 arch 只补齐需要的那一个**

把「无论打哪个都补齐两套」改成循环内：

```bash
ensure_native_for_arch() {  # arm64|x64
  local arch="$1"
  case "$arch" in
    arm64)
      ensure_cross_pkg "@esbuild/darwin-arm64" "$ESBUILD_VER"
      ensure_cross_pkg "@ast-grep/napi-darwin-arm64" "$ASTGREP_VER"
      ;;
    x64)
      ensure_cross_pkg "@esbuild/darwin-x64" "$ESBUILD_VER"
      ensure_cross_pkg "@ast-grep/napi-darwin-x64" "$ASTGREP_VER"
      ;;
  esac
}
```

在 `for arch in "${ARCHS[@]}"` **内部**、`tauri build` 之前调用 `ensure_native_for_arch "$arch"`；删除文件顶部对两套的无条件 ensure（或保留 ensure 但注释改为「开发机可同时有两套；**打进包的只有目标套**」——真正进包靠 stage filter + fetch prune）。

- [ ] **步骤 2：每个 `tauri build` 成功后对 `.app` 跑 prune + assert**

```bash
  app=.../Tianshu.app
  res="${app}/Contents/Resources"
  node "${DESKTOP_DIR}/scripts/prune-bundle-arch.js" "$res" "$triple"
  node "${DESKTOP_DIR}/scripts/assert-bundle-arch.js" "$res" "$triple"
```

`assert-bundle-arch.js` 逻辑：`planPrunePaths` 非空 → 打印路径并 `process.exit(1)`。

- [ ] **步骤 3：更新 `docs/DESKTOP-RELEASE-MAC.md`**

替换「两架构都打进包」相关段落为：

- 每个 DMG / `.app` **只含目标架构** Node 与原生件  
- Intel 与 Apple Silicon **分开构建、分开分发**  
- 验收：`assert-bundle-arch.js` 必须绿  
- 预期体积：aarch64 `.app` Resources 中 `node-runtime` ≈ 110MB（不再 224MB）

- [ ] **步骤 4：打一版 arm64 验收（耗时长，单独排期）**

```bash
bash desktop/scripts/build-mac.sh arm64
APP=desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Tianshu.app
du -sh "$APP" "$APP/Contents/Resources/node-runtime"/*
ls "$APP/Contents/Resources/node-runtime"
ls "$APP/Contents/Resources/rivet-runtime/node_modules/@esbuild"
node desktop/scripts/assert-bundle-arch.js "$APP/Contents/Resources" aarch64-apple-darwin
```

预期：
- `node-runtime` 仅 `darwin-arm64`
- `@esbuild` 无 `darwin-x64`
- `.app` 总大小较 371MB 下降 **≥100MB**（目标约 220–260MB）

- [ ] **步骤 5：冷启动复测**

用新 `.app` 内 Node + main.js，干净 `RIVET_HOME`，按 `lib.rs` argv（token 仅环境变量）测到 `/health`；记录 ready_ms 写入 changelog。不要求立刻降到 <2s（Wave A 主要减扫描/安装税；墙钟可能仅小幅改善）。

- [ ] **步骤 6：Commit**

```bash
git add desktop/scripts/build-mac.sh desktop/scripts/assert-bundle-arch.js docs/DESKTOP-RELEASE-MAC.md
git commit -m "$(cat <<'EOF'
feat(desktop): ship single-arch Node/native per macOS target package

EOF
)"
```

---

## Wave B — runtime `node_modules` 瘦身（包体第二刀）

### 任务 5：tree-sitter-wasms 只打常用语言

**文件：**
- 修改：`scripts/stage-runtime-deps.js`（staging 后 prune `tree-sitter-wasms/out`）
- 查清：谁按路径加载 wasm（`rg tree-sitter-wasms` / `LANG_MAP`）

- [x] **步骤 1：列出运行时实际引用的 grammar 名** — 仅 `meridian-parser.ts` LANG_WASM：typescript / python / go
- [x] **步骤 2：staging 后删除非 allowlist `.wasm`** — `scripts/tree-sitter-wasm-keep.js`
- [x] **步骤 3：验收** — ~49MB → ~4MB
- [x] **步骤 4：Commit** — `76e61e49`

---

### 任务 6：评估 typescript 是否必须进封版

**文件：**
- 调研：`rg "from 'typescript'|require\\('typescript'\\)|createProgram|tsserver" src/`
- 修改：`scripts/stage-runtime-deps.js` 的 `ROOTS`（若可删）

- [x] **步骤 1：确认调用链** — `lsp/client.ts` 在无本地 `tsc` 时 `require('typescript')` + `createProgram`；**保留 ROOTS**，裁 locale/CLI（`typescript-stage-trim.js`）
- [x] **步骤 2：冒烟** — staged `createProgram` / `findConfigFile` OK；~23MB → ~12–14MB
- [x] **步骤 3：Commit + changelog 记录保留决定**

---

## Wave C — serve 冷启动闭包（可选，墙钟）

### 任务 7（可选）：延后重依赖 dynamic import

**前提：** Wave A/B 已合并；本任务改 `src/server/serve.ts` / 工具注册路径，需完整回归。

- [x] **步骤 1：计时** — `RIVET_SERVE_TIMING=1` 打印 listen / serve-agent import ms
- [x] **步骤 2：拆分** — `serve-agent.ts` 承载 AgentLoop/tools/Meridian/council；`runServe` 动态 `import()`；MCP `McpManager` 动态加载；listen 后预热
- [x] **步骤 3：回归** — server session 相关测试全绿；冷启动 `/health` 本机 ~760ms（基线 ~1195ms）
- [x] **步骤 4：changelog**

> **2026-07-14 完成：** Wave C 任务 7 已合并。serve 冷路径静态图从 ~5MB 依赖降到 ~3KB+轻量 chunk；重依赖在首 session / 后台预热时加载。

---

## 验收清单（Wave A 完成即算主目标达成）

| 检查项 | 通过标准 |
|--------|----------|
| aarch64 `.app` 无 `darwin-x64` Node | `assert-bundle-arch` 退出 0 |
| aarch64 `.app` 无 `@esbuild/darwin-x64` | 同上 |
| `node-runtime` 体积 | ≈ 110MB（单份），非 224MB |
| `.app` 总大小 | 较 371MB 下降 ≥100MB |
| sidecar `/health` | 仍可在干净 RIVET_HOME 下就绪；记录 ms |
| Intel 包对称 | `build-mac.sh x64` 无 `darwin-arm64` |
| 文档 | `DESKTOP-RELEASE-MAC.md` 与政策一致 |

---

## 风险与回滚

| 风险 | 缓解 |
|------|------|
| 用户把 aarch64 包拿到 Intel 机 | 文档写清；启动时 Node 路径不存在 → 已有 spawn_error banner |
| `build-mac both` 连续打两包时 `resources/node` 被后一次覆盖 | **正确**：每次 fetch 只留当前 target；勿在两次 build 间复用未 prune 的 staging |
| 缺异架构 esbuild 导致语法检查挂 | 目标机 loader 只解析本 arch；缺包应在 staging 时 fail（`ROOTS` 含 esbuild，本 arch 必须存在） |
| Windows 对等 | Wave A 逻辑对 `win-x64` 同样 prune；若暂无双 arch Windows 问题，assert 仍要跑 |

回滚：恢复 `build-mac.sh` 双 arch ensure + 去掉 prune；重新打包装回旧政策。

---

## 建议执行顺序

1. 任务 1–4（Wave A）→ 打 arm64 包量体积 → changelog  
2. 任务 5（wasm 子集）  
3. 任务 6（typescript 决策）  
4. 任务 7 另开或排期  

**不要**在未完成 assert 验收前改 serve 启动图。
