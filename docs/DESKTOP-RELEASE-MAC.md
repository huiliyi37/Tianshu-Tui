# 桌面版 macOS 双架构打包（arm64 / Intel）

> Windows 打包见 `DESKTOP-RELEASE.md`。本文只讲 macOS，尤其是「为什么之前的
> Intel 包是坏的」以及正确打法。

## TL;DR

```bash
bash desktop/scripts/build-mac.sh both      # arm64 + Intel 一起打
bash desktop/scripts/build-mac.sh arm64     # 只打 Apple Silicon
bash desktop/scripts/build-mac.sh x64        # 只打 Intel
```

产物：
```
desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/
  ├── macos/Tianshu.app
  └── dmg/Tianshu_<ver>_aarch64.dmg
desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/
  ├── macos/Tianshu.app
  └── dmg/Tianshu_<ver>_x64.dmg
```

前置：`rustup target add x86_64-apple-darwin aarch64-apple-darwin`、Node **24.1.0**。

## 为什么之前的 Intel 包是坏的（根因）

桌面 app 内置三类**按架构编译的原生二进制**：

| 原生件 | 位置 | 之前的问题 |
|--------|------|-----------|
| Node sidecar 运行时 | `resources/node/darwin-<arch>/node` | 无问题（两架构都打进包，`lib.rs` 按运行架构自选） |
| **better-sqlite3** | `dist/native/better_sqlite3.node` | **单文件、无架构区分**。`pack-native.js` 直接拷宿主 `node_modules` 的二进制。M1 上就是 arm64 → 塞进 Intel 包 → Intel 机 sidecar(x64 node) 加载失败 → 退化 nullDb（跨会话知识/claims/registry 静默失能），严重时 sidecar 直接崩 |
| esbuild / @ast-grep napi | `dist/node_modules/@esbuild/*`、`@ast-grep/napi-darwin-*` | 宿主 `npm install` 只装宿主架构 → Intel 包里是 arm64 → 对应工具在 Intel 机报错 |

三个脚本原本都只看**宿主** `process.arch`，无视 Tauri 交叉编译的目标架构，所以在
M1 上 `tauri build --target x86_64-apple-darwin` 打出来的 Intel 包混入了 arm64 原生件。

## 修复（已落地）

1. **`desktop/scripts/fetch-node-runtime.js`**：新增 `resolveTargetTriple()`，按
   `TAURI_ENV_TARGET_TRIPLE`（Tauri 每次 build 都设）拉/校验**目标架构**的 Node，
   而非宿主。
2. **`scripts/pack-native.js`**：目标架构 ≠ 宿主时，走 `prebuild-install --arch
   <目标> --target <目标 Node 版本>` 拉对应架构 + ABI 的 `better_sqlite3.node`，
   打包后读 Mach-O 头校验架构（fail-closed）。拉取用临时替换 + 还原，不污染宿主
   `node_modules`。ABI 正确性由 `--target` 保证（跨架构无法 `require` 探测）。
3. **`scripts/stage-runtime-deps.js`**：跨架构时跳过「宿主 require round-trip」断言
   （宿主进程加载不了异架构 .node），改为 Mach-O 架构校验。
4. **`desktop/scripts/build-mac.sh`**：非破坏式补齐**两个架构**的 esbuild /
   @ast-grep 平台包（直接解 tarball，不动 npm 依赖树——`npm i --cpu/--os` 会把宿主
   架构包删掉），两架构原生同时打进每个包，运行时由各自 JS loader 按 arch 自选。

> 关键坑：`npm install --cpu=x64 --os=darwin @esbuild/darwin-x64` 会把
> `@esbuild/darwin-arm64` 当作「不匹配目标」**删掉**。要两架构共存必须绕开 npm
> 依赖树解析（`npm pack` + 手动解包）。

## DMG 打包方式

不走 tauri 自带的 `bundle_dmg.sh`——它用 AppleScript 让 Finder 摆图标/背景，在
无 GUI / 自动化受限的会话里会失败并残留挂载盘。`build-mac.sh` 改用 `hdiutil` 直接
产只读压缩 DMG（含 `/Applications` 拖拽符号链接），确定性可重复。

## 签名 / 公证现状

- **updater 签名**：`desktop/.env` 的 `TAURI_SIGNING_PRIVATE_KEY` 会给 `.app.tar.gz`
  产 `.sig`。⚠ **当前私钥与 `tauri.conf.json > plugins.updater.pubkey` 不匹配**
  （build 时有 warning），mac 自动更新签名校验会失败，需先对齐这对密钥才能启用
  mac 自动更新。手动分发 .dmg 不受影响。
- **Apple 公证**：未配 `APPLE_SIGNING_IDENTITY` → 产物**未签名/未公证**。用户下载
  后首次打开会被 Gatekeeper 拦（报「已损坏」），需执行：
  ```bash
  xattr -cr /Applications/Tianshu.app
  ```
  要彻底免这步，须配 Developer ID + `APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID` 走
  `sign-and-build.sh` 的公证路径。

## 验证产物架构

```bash
app=desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Tianshu.app
file "$app/Contents/MacOS/tianshu-desktop"                              # 应为 x86_64
file "$app/Contents/Resources/rivet-runtime/native/better_sqlite3.node"  # 应为 x86_64
ls   "$app/Contents/Resources/node-runtime/"                            # darwin-arm64 + darwin-x64
```
