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

- tree-sitter-wasms / typescript 子集裁剪
- serve 启动闭包延后 import（墙钟优化）
