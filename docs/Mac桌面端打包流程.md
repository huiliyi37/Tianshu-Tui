# Mac 桌面端打包流程

> 2026-07-04 记录。适用于 macOS Apple Silicon (arm64) 和 Intel (x86_64) 打包。

## 前置要求

- **Node.js 24.1.0**（必须用 fnm 切到这个版本，因为 better-sqlite3 的 ABI 必须匹配打包的 Node runtime）
- **Rust toolchain**（`rustup` + 对应 target）
- **fnm**（Node 版本管理器）
- 项目依赖已安装（`npm install` 在项目根和 `desktop/`）

## 完整步骤

### 1. 切到 Node 24

```bash
eval "$(fnm env --shell zsh)"
fnm use 24.1.0
node --version  # 确认 v24.1.0
```

### 2. 重新编译 better-sqlite3（ABI 对齐）

```bash
npm rebuild better-sqlite3
```

> 如果跳过这步，`pack-native.js` 会报 ABI 不匹配（NODE_MODULE_VERSION 137 vs 127）。

### 3. 手动执行 beforeBuildCommand 的各步（分步验证）

```bash
cd /Users/banxia/app/deepseek-tui/opencode-tui

# 3a. 后端 tsup build
npm run build

# 3b. 打包 better-sqlite3 native binary
node scripts/pack-native.js
# 预期: ✅ Packed better_sqlite3.node ... ABI 校验通过

# 3c. 暂存 runtime 依赖
node scripts/stage-runtime-deps.js
# 预期: ✅ Staged 10 runtime packages ... zero-degrade

# 3d. fetch Node runtime（会缓存，重复执行是 no-op）
node desktop/scripts/fetch-node-runtime.js

# 3e. fetch shell runtime（Mac 上是 no-op，只 Windows 下载 busybox）
node desktop/scripts/fetch-shell-runtime.js
```

### 4. 确保 `desktop/src-tauri/resources/shell/` 存在

```bash
mkdir -p desktop/src-tauri/resources/shell
touch desktop/src-tauri/resources/shell/.gitkeep
```

> 不存在会导致 Tauri build 报 `resource path 'resources/shell' doesn't exist`。

### 5. 确保 `tsc --noEmit` 通过

```bash
cd desktop
npx tsc --noEmit
echo "EXIT=$?"  # 必须是 0
cd ..
```

> **这是白屏问题的根因**：如果 tsc 返回非零，`npm run build`（tsc && vite build）短路，
> vite 不执行，`desktop/dist/` 为空，Tauri 嵌入空前端 → 白屏。
> 修复方法：给 unused 变量加 `_` 前缀。

### 6. 确保 `desktop/dist/` 有最新前端

```bash
ls -la desktop/dist/index.html desktop/dist/assets/index-*.js
# 如果不存在或时间是旧的：
cd desktop && npm run build && cd ..
```

### 7. x86_64 额外步骤（打 Intel 包时才需要）

```bash
# 安装 Rust x86_64 target
rustup target add x86_64-apple-darwin

# 手动下载 x86_64 Node runtime（fetch-node-runtime.js 只下载当前架构）
mkdir -p desktop/src-tauri/resources/node/darwin-x64
curl -L "https://nodejs.org/dist/v24.1.0/node-v24.1.0-darwin-x64.tar.gz" -o /tmp/node-x64.tar.gz
tar xzf /tmp/node-x64.tar.gz --strip-components=2 -C desktop/src-tauri/resources/node/darwin-x64 "node-v24.1.0-darwin-x64/bin/node"
chmod +x desktop/src-tauri/resources/node/darwin-x64/node
```

### 8. 执行 Tauri build

```bash
# Apple Silicon (arm64)
npx tauri build --target aarch64-apple-darwin

# Intel (x86_64) — 首次交叉编译约 10 分钟
npx tauri build --target x86_64-apple-darwin
```

> Tauri build 会自动执行 `beforeBuildCommand`，但如果已经手动跑过步骤 3，
> `tsc --noEmit` 会再跑一次（确保通过），`npm run build` 会生成 dist。
> Rust 编译首次约 3-5 分钟，后续增量约 1 分钟。

### 9. 验证产物

```bash
# arm64
ls -lh desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Tianshu_*_aarch64.dmg

# x86_64
ls -lh desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Tianshu_*_x64.dmg

# 快速验证 app 能启动（不白屏）
open desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Tianshu.app
```

### 10. 发布到 GitHub Release

```bash
gh release create v2.13.0 \
  desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Tianshu_*_aarch64.dmg \
  desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Tianshu_*_x64.dmg \
  --repo huiliyi37/Tianshu-Tui \
  --title "v2.13.0" \
  --notes "..."
```

## 常见问题

| 问题 | 根因 | 修复 |
|------|------|------|
| 白屏 | `tsc --noEmit` 有 unused variable error，短路了 vite build | 修 tsc 错误（`_` 前缀） |
| ABI 不匹配 | Node 版本不对（不是 24.1.0） | `fnm use 24.1.0 && npm rebuild better-sqlite3` |
| `resources/shell doesn't exist` | shell 目录没创建 | `mkdir -p desktop/src-tauri/resources/shell && touch .../.gitkeep` |
| x86_64 缺 Node runtime | fetch-node-runtime 只下当前架构 | 手动 curl 下载 x86_64 版本（见步骤 7） |
| updater signing error | 没有 TAURI_SIGNING_PRIVATE_KEY | 不影响 .dmg/.app 使用，只是 updater 签名跳过 |

## 版本号管理

打包前统一升级三个文件的版本号：

```bash
# package.json (TUI npm 包)
# desktop/package.json
# desktop/src-tauri/tauri.conf.json
```

三处必须一致。

## 版本号命名规则

- **Patch**（x.x.+1）：bug 修复、小调整
- **Minor**（x.+1.0）：新功能、新特性
- **Major**（+1.0.0）：重大架构变化（暂未使用）
