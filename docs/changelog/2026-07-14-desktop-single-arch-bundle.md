# 2026-07-14 — 桌面封版单架构包体政策

## 背景

封版 `Tianshu_2.19.2_aarch64.dmg` 内 `.app` ≈ 371MB，其中：

- `node-runtime/` **224MB**（darwin-arm64 + darwin-x64 各 ~110MB）
- `rivet-runtime/node_modules` 内双架构 esbuild / @ast-grep

根因是旧政策「每个包打进双架构原生、运行时自选」+ `resources/node` 累加两套后整树进 Tauri resources。

## 改动（Wave A）

| 文件 | 作用 |
|------|------|
| `desktop/scripts/prune-bundle-arch.js` | 按目标 arch 删除异架构 Node / esbuild / ast-grep |
| `desktop/scripts/assert-bundle-arch.js` | 封版验收：仍有异架构路径则 fail |
| `desktop/scripts/fetch-node-runtime.js` | 拉取后 prune `resources/node` 兄弟目录 |
| `scripts/runtime-platform-filter.js` + `stage-runtime-deps.js` | staging 跳过异架构 optional 平台包 |
| `desktop/scripts/build-mac.sh` | 每 target 只 ensure 本 arch；build 后 prune+assert |
| `docs/DESKTOP-RELEASE-MAC.md` | 文档改为单架构分发政策 |

## 验收

单元测试：

```bash
npm exec -- tsx --test desktop/scripts/__tests__/prune-bundle-arch.test.ts scripts/__tests__/stage-runtime-deps-filter.test.ts
```

整包（耗时，需本机执行）：

```bash
bash desktop/scripts/build-mac.sh arm64
# 预期 node-runtime 仅 darwin-arm64，.app 较 371MB 下降 ≥100MB
```

## 未做（Wave B/C）

- ~~tree-sitter-wasms / typescript 子集裁剪~~ → 见下方 Wave B
- serve 启动闭包延后 import（墙钟优化，Wave C / 任务 7）

## Wave B（2026-07-14）

| 改动 | 结果 |
|------|------|
| `scripts/tree-sitter-wasm-keep.js` | 只保留 meridian `LANG_WASM`：typescript / python / go；`out/` **49MB → ~4MB** |
| `scripts/typescript-stage-trim.js` | **保留** `typescript`（`lsp/client` 无本地 `tsc` 时 `createProgram` 回退）；裁掉 locale + tsc/tsserver CLI；**23MB → ~12–14MB** |

**为何不删 typescript：** 封版 sidecar 在用户项目缺 `node_modules/.bin/tsc` 时走进程内回退；删掉会让 typecheck gate `ranOk:false` fail-open。CLI/`tsserver` 与 locale 包进程内 API 用不到，可安全裁。

验收：

```bash
npm exec -- tsx --test scripts/__tests__/tree-sitter-wasm-keep.test.ts scripts/__tests__/typescript-stage-trim.test.ts
TAURI_ENV_TARGET_TRIPLE=aarch64-apple-darwin STAGE_SKIP_SQLITE_CHECK=1 node scripts/stage-runtime-deps.js
# 预期：tree-sitter-wasms ~4MB；typescript ~12–14MB；createProgram 可 require
```

## Wave C（2026-07-14）

| 改动 | 结果 |
|------|------|
| `src/server/serve-agent.ts` | AgentLoop / tools / Meridian / council 装配从 serve 静态图拆出 |
| `serve.ts` `loadServeAgent()` | listen 后再动态 import；`RIVET_SERVE_TIMING=1` 打点 |
| MCP | `import('../mcp/manager.js')` 异步初始化，不挡 `/health` |
| `AgentFactory` | 可返回 `Promise`；测试双仍同步 |

本机验收（干净 `RIVET_HOME`，`dist/main.js serve`）：

| 指标 | 改前 | 改后 |
|------|------|------|
| `/health` ready_ms（热盘） | ~1195 | ~640–760 |
| listen 内就绪 | （淹没在大图 import） | **~2–5ms**（`RIVET_SERVE_TIMING`） |
| serve 入口 chunk | ~340KB + ~5MB 静态依赖 | ~3KB + ~322KB 轻量依赖 |
| serve-agent 后台加载 | — | ~30–100ms（重 chunk 懒加载） |

`turndown` 本已 dynamic import，无需再改。
