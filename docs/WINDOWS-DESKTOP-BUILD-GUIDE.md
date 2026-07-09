# Windows 桌面版开发与打包指南

> 2026-07-09 基于 v2.17.4 实操验证整理。覆盖开发、构建、签名、发布全流程。

## 一、架构概览

```
┌─────────────────────────────────────────────────────┐
│  Tauri 2.x 外壳 (Rust)                               │
│  ┌──────────────┐  spawn  ┌────────────────────────┐ │
│  │  desktop/     │ ──────→ │  rivet sidecar (Node)   │ │
│  │  React/Vite   │  :port  │  dist/main.js serve     │ │
│  │  前端 SPA     │  token  │  127.0.0.1 + Bearer     │ │
│  └──────────────┘         └────────────────────────┘ │
│         ↕ Tauri Commands (IPC)                        │
└─────────────────────────────────────────────────────┘
```

- **前端**：React 18 + Vite + TailwindCSS 4 + TanStack Query，打包到 `desktop/dist/`
- **后端 sidecar**：tsup 打包 `src/main.ts` → `dist/main.js`，运行时通过 `rivet serve --port <port>` 启动
- **Rust 外壳**：`src-tauri/` 下，负责 spawn Node 进程、端口探测、健康检查、自动更新

## 二、环境准备（仅首次）

| 依赖 | 版本要求 | 验证命令 |
|------|----------|----------|
| Node.js | **24.1.0**（ABI 137 必须精确匹配） | `node -v` → v24.1.0，`node -p process.versions.modules` → 137 |
| Rust | 稳定版 | `rustc --version` |
| Tauri CLI | 2.x | `npx tauri --version` → 2.x |
| Git | 任意 | `git --version` |

### 签名密钥

```powershell
# 生成密钥对（仅首次）
cd desktop
npx tauri signer generate -w ~/.tauri/tianshu.key

# 公钥 → desktop/src-tauri/tauri.conf.json 的 plugins.updater.pubkey
# 私钥 → ~/.tauri/tianshu.key（绝不入 git）
```

### PortableGit（内置 Git Bash）

`fetch-shell-runtime.js` 自动从 GitHub 下载 PortableGit.7z.exe（~56MB）到 `src-tauri/resources/shell/win-x86_64/`。国内网络可能需要 VPN 或设置 `PORTABLE_GIT_MIRROR` 环境变量指向镜像。

## 三、日常开发

### 纯前端开发（快速迭代）

```powershell
# 终端 1：启动 sidecar
cd D:\dev\revit
$env:RIVET_SERVER_TOKEN = "devtoken"
node dist/main.js serve --port 3100

# 终端 2：启动前端 dev server
cd D:\dev\revit\desktop
$env:VITE_RIVET_PORT = "3100"
$env:VITE_RIVET_TOKEN = "devtoken"
npm run dev
# 浏览器访问 http://localhost:5273
```

### 完整桌面开发

```powershell
cd D:\dev\revit\desktop
npm run tauri:dev
# Tauri 自动 spawn sidecar + 注入随机 token
```

### 类型检查

```powershell
# 前端
cd desktop; npx tsc --noEmit

# 后端（含全量测试）
cd ..; npm run typecheck
```

## 四、打包构建

### 构建管线（`beforeBuildCommand` 自动执行）

```
tsup build (dist/main.js)        ← 669ms，953KB
  → pack-native.js               ← better_sqlite3.node → dist/native/，ABI 137 断言
  → stage-runtime-deps.js        ← esbuild/typescript/@ast-grep 等 → dist/node_modules/，zero-degrade 断言
  → obfuscate-runtime.js         ← javascript-obfuscator 混淆 dist/*.js（100+ 文件，~28s）
  → fetch-node-runtime.js        ← 下载 Node 24.1.0 二进制 → resources/node/
  → fetch-shell-runtime.js       ← 下载 PortableGit → resources/shell/
  → codesign-nested.js           ← macOS 签名，Windows 下为空操作
  → tauri build (Rust)           ← 增量 ~5min，首次全量 ~10min
  → NSIS + MSI 打包              ← ~2min
```

### 执行构建

```powershell
cd D:\dev\revit\desktop
npx tauri build
```

### 产物

| 路径 | 类型 | 大小 |
|------|------|------|
| `src-tauri\target\release\bundle\nsis\Tianshu_2.17.4_x64-setup.exe` | NSIS 安装包 | ~97MB |
| `src-tauri\target\release\bundle\msi\Tianshu_2.17.4_x64_zh-CN.msi` | MSI 安装包 | ~114MB |

### 构建质量断言

| 断言 | 保护什么 | 失败后果 |
|------|----------|----------|
| `pack-native.js` ABI 校验 | better_sqlite3 ABI == Node 24.1.0 的 137 | 如果跳过：静默退化为 NullDatabase，跨会话知识失能 |
| `stage-runtime-deps.js` zero-degrade | wrapper + native round-trip 能通过 | 如果跳过：sidecar 缺少依赖导致 ERR_MODULE_NOT_FOUND |
| `tsup onSuccess` bundled-skills 校验 | dist/bundled-skills/ 有内容 | 如果缺失：桌面版无默认 skills |
| `obfuscate-runtime.js` exit(1) | 每个文件混淆成功 | 如果失败：build 中断，不产包 |

> **重要**：`stage-runtime-deps.js` 的 round-trip 断言在构建机 Node 版本 ≠ 24.1.0 时会 fail。如果必须跳过，设 `STAGE_SKIP_SQLITE_CHECK=1`，但**不建议用于发布产物**。

## 五、签名与发布

### 签名（本地执行）

```powershell
cd D:\dev\revit\desktop

# NSIS 签名
npx tauri signer sign --private-key-path "$env:USERPROFILE\.tauri\tianshu.key" --password "" "src-tauri\target\release\bundle\nsis\Tianshu_2.17.4_x64-setup.exe"

# MSI 签名
npx tauri signer sign --private-key-path "$env:USERPROFILE\.tauri\tianshu.key" --password "" "src-tauri\target\release\bundle\msi\Tianshu_2.17.4_x64_zh-CN.msi"
```

成功后产物目录新增两个 `.sig` 文件。

### 生成更新清单

```powershell
cd D:\dev\revit
node desktop/scripts/gen-latest-json.js `
  --version 2.17.4 `
  --notes "v2.17.4 更新说明" `
  --bundle-dir desktop/src-tauri/target/release/bundle `
  --download-base https://github.com/huiliyi37/Tianshu-Tui/releases/download/v2.17.4 `
  > desktop/src-tauri/target/release/bundle/latest.json
```

**验证 `latest.json`**：url 字段必须是纯 GitHub URL，不能含本地路径（Windows 路径 bug 已修）。

### 发布到 GitHub Release

```powershell
# 方式 A：gh CLI（需 token 有 Tianshu-Tui 写入权限）
cd D:\dev\revit\desktop\src-tauri\target\release\bundle
gh release create v2.17.4 `
  nsis/Tianshu_2.17.4_x64-setup.exe `
  nsis/Tianshu_2.17.4_x64-setup.exe.sig `
  msi/Tianshu_2.17.4_x64_zh-CN.msi `
  msi/Tianshu_2.17.4_x64_zh-CN.msi.sig `
  latest.json `
  --title "v2.17.4" --notes "..." --repo huiliyi37/Tianshu-Tui

# 方式 B：gh CLI 的 upload 命令（已有 release 时追加资产）
gh release upload v2.17.4 <files> --repo huiliyi37/Tianshu-Tui

# 方式 C：API 直接上传（当 gh CLI 403 时兜底）
# 见下方「gh upload 403 的解决」
```

### 版本号同步清单

四处必须一致：

| 位置 | 文件 |
|------|------|
| 包版本 | `desktop/package.json` 的 `version` |
| Tauri 配置 | `desktop/src-tauri/tauri.conf.json` 的 `version` |
| Git tag | `v2.17.4` |
| gen-latest-json | `--version 2.17.4` |

## 六、自动更新闭环

```
客户端启动 → GET releases/latest/download/latest.json
  → 比对 version → 下载 setup.exe + .sig → 验证签名 → 安装重启
```

- `latest.json` 必须在 Latest Release（非 draft、非 prerelease）
- `.sig` 是 Tauri 的 Ed25519 更新签名，与 Windows 代码签名无关
- 更新 endpoint：`https://github.com/huiliyi37/Tianshu-Tui/releases/latest/download/latest.json`

## 七、Sidecar 验证

打包后、发布前必须验证 sidecar 能启动：

```powershell
# 用 bundled Node 启动（模拟桌面版真实启动路径）
$env:RIVET_SERVER_TOKEN = "test-token"
$proc = Start-Process -FilePath "desktop\src-tauri\resources\node\win-x64\node.exe" `
  -ArgumentList "--expose-gc","--max-old-space-size=4096","dist\main.js","serve","--port","3199" `
  -NoNewWindow -PassThru
Start-Sleep 5
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:3199/health" `
    -Headers @{Authorization="Bearer test-token"} -TimeoutSec 8 -UseBasicParsing
  Write-Host "HEALTH: $($r.StatusCode) — $($r.Content)"
} catch { Write-Host "FAILED: $_" }
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
```

**健康通过标志**：HTTP 200 + `registryOk: true`。

### RuntimeInfo 诊断能力（v2.17.4+）

`lib.rs` 的 `RuntimeInfo` 结构体现在暴露：
- `node_path`：使用的 Node 二进制路径
- `entry_path`：rivet-runtime/main.js 路径
- `spawn_error`：spawn 失败的 OS 错误
- `log_path`：sidecar stdout/stderr 日志路径（`<RIVET_HOME>/logs/sidecar-<ts>.log`）

启动失败时检查 `<RIVET_HOME>\logs\` 下最新日志文件。

## 八、常见问题速查

| 症状 | 根因 | 解决 |
|------|------|------|
| build 报 ABI 不匹配 | 构建机 Node ≠ 24.1.0 | 切回 Node 24.1.0 |
| sidecar 启动后 `/health` 不返回 | 混淆损坏 / 依赖缺失 / Node 版本不对 | 先不混淆验证；检查日志 |
| stage-runtime-deps 报 zero-degrade | better_sqlite3.node ABI 不匹配 | `npm rebuild better-sqlite3` |
| gh upload 403 | PAT 权限不足 | 见下方解决方法 |
| gen-latest-json 报签名缺失 | bundle 目录有旧版残留 | 清空 bundle 目录重打 |
| latest.json url 含本地路径 | 脚本 Windows 路径 bug | 已修（`.replace(/\\/g,'/')`) |
| NSIS 打包报错 codepage | 中文产品名 + MSI 西欧编码 | `wix.language = "zh-CN"`（已配） |
| PortableGit 下载失败 | GitHub 被墙 | 设 `PORTABLE_GIT_MIRROR` 或 VPN |

## 九、gh upload 403 的解决

`gh release upload` 在 fine-grained PAT 下可能返回 403（即使 repo permissions 显示 push=true）。这是 `uploads.github.com` 域名的权限检查与 `api.github.com` 不完全一致。

**兜底方案：直接调用 GitHub API 上传**：

```powershell
$token = gh auth token
$uploadBase = "https://uploads.github.com/repos/huiliyi37/Tianshu-Tui/releases/<release-id>/assets"
# release-id 从 gh release view --json id 获取

$files = @(
  @{path="nsis/Tianshu_2.17.4_x64-setup.exe"; mime="application/vnd.microsoft.portable-executable"},
  @{path="nsis/Tianshu_2.17.4_x64-setup.exe.sig"; mime="application/octet-stream"},
  @{path="msi/Tianshu_2.17.4_x64_zh-CN.msi"; mime="application/x-msi"},
  @{path="msi/Tianshu_2.17.4_x64_zh-CN.msi.sig"; mime="application/octet-stream"},
  @{path="latest.json"; mime="application/json"}
)

foreach ($f in $files) {
  $name = Split-Path $f.path -Leaf
  Invoke-RestMethod -Uri "$uploadBase`?name=$name" -Method Post `
    -Headers @{Authorization="Bearer $token"; Accept="application/vnd.github+json"} `
    -ContentType $f.mime -InFile $f.path
}
```

## 十、构建管线架构图

```mermaid
graph TD
    A[npm run build<br/>tsup → dist/main.js + chunks] --> B[pack-native.js<br/>better_sqlite3.node → dist/native/<br/>ABI 137 断言]
    B --> C[stage-runtime-deps.js<br/>esbuild/typescript/@ast-grep → dist/node_modules/<br/>zero-degrade 断言]
    C --> D[obfuscate-runtime.js<br/>混淆 dist/*.js<br/>100+ 文件 ~28s]
    D --> E[fetch-node-runtime.js<br/>Node 24.1.0 → resources/node/]
    E --> F[fetch-shell-runtime.js<br/>PortableGit → resources/shell/]
    F --> G[codesign-nested.js<br/>macOS 签名/Windows 跳过]
    G --> H[tauri build<br/>Rust 编译 ~5min]
    H --> I[NSIS + MSI 打包]
    I --> J[tauri signer sign<br/>生成 .sig 签名]
    J --> K[gen-latest-json.js<br/>生成更新清单]
    K --> L[gh release upload<br/>发布到 GitHub]
```

## 十一、文件清单（一次完整发布涉及）

| 文件 | 用途 |
|------|------|
| `desktop/src-tauri/tauri.conf.json` | Tauri 主配置（version、bundle、updater） |
| `desktop/src-tauri/tauri.windows.conf.json` | Windows 窗口配置（decorations:false 等） |
| `desktop/scripts/obfuscate-runtime.js` | 混淆脚本 |
| `desktop/scripts/fetch-node-runtime.js` | Node 运行时下载（导出 DEFAULT_NODE_VERSION） |
| `desktop/scripts/fetch-shell-runtime.js` | PortableGit 下载 |
| `desktop/scripts/gen-latest-json.js` | 更新清单生成 |
| `scripts/pack-native.js` | better-sqlite3 打包 + ABI 断言 |
| `scripts/stage-runtime-deps.js` | 运行时依赖暂存 + zero-degrade 断言 |
| `desktop/src-tauri/src/lib.rs` | Rust 外壳核心（sidecar 生命周期管理） |
