# 天枢桌面版分发指南

本文档说明如何构建、签名和分发天枢桌面版。

## 前置条件

- 仓库根已执行 `npm install && npm run build`（产出 `dist/main.js`）。
- 已安装 Rust + Tauri v2 CLI 前置（见 https://tauri.app/start/prerequisites/）。
- 桌面目录已执行 `npm install`。

## 本地开发

```bash
cd desktop

# 方式 A：浏览器里调前端（需手动起 sidecar）
RIVET_SERVER_TOKEN=devtoken node ../dist/main.js serve --port 3100
VITE_RIVET_PORT=3100 VITE_RIVET_TOKEN=devtoken npm run dev

# 方式 B：完整桌面（Tauri 自动 spawn sidecar）
npm run tauri:dev
```

## 构建产物

```bash
cd desktop

# 下载对应平台的 Node 运行时（会被打包进 app）
node scripts/fetch-node-runtime.js

# 构建桌面应用
npm run tauri:build
```

构建完成后产物位于：

| 平台 | 产物路径 |
|---|---|
| macOS `.app` | `src-tauri/target/release/bundle/macos/天枢.app` |
| macOS `.dmg` | `src-tauri/target/release/bundle/dmg/天枢_*.dmg` |
| Windows `.exe` (portable) | `src-tauri/target/release/天枢.exe` |
| Windows NSIS | `src-tauri/target/release/bundle/nsis/天枢_*.exe` |
| Windows MSI | `src-tauri/target/release/bundle/msi/天枢_*.msi` |

## 内置 Node 运行时

桌面版通过 `scripts/fetch-node-runtime.js` 在构建期下载官方 Node.js 二进制，并打包到 app 资源目录。启动 sidecar 时的查找顺序为：

1. 环境变量 `RIVET_SIDECAR_CMD`（最高优先级，用于调试/测试）。
2. 打包资源中的 Node 二进制（`Resources/node-runtime/<os>-<arch>/node[.exe]`）。
3. 系统常见安装路径（`/opt/homebrew/bin/node` 等）。
4. PATH 中的 `node`。

如需指定 Node 版本：

```bash
NODE_VERSION=22.15.0 node scripts/fetch-node-runtime.js
```

## 代码签名与公证

`tauri.conf.json` 已配置好签名/公证占位：macOS 启用 `hardenedRuntime` 并读取 `APPLE_SIGNING_IDENTITY`，Windows 读取 `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`。

未配置证书时，构建仍会成功，但产物未签名/未公证，用户在 macOS/Windows 上打开时会看到安全提示。

### macOS

需要 Apple Developer ID 与 App-Specific Password。在 CI secrets 或本地环境变量中配置：

- `APPLE_SIGNING_IDENTITY`：签名证书名称（如 `"Developer ID Application: Your Name (TEAMID)"`）。
- `APPLE_ID`：Apple ID 邮箱。
- `APPLE_TEAM_ID`：10 字符团队 ID。
- `APPLE_PASSWORD`：App-Specific Password。

本地构建示例：

```bash
export APPLE_SIGNING_IDENTITY="..."
export APPLE_ID="..."
export APPLE_TEAM_ID="..."
export APPLE_PASSWORD="..."
cd desktop && npm run tauri:build
```

### Windows

需要代码签名证书。在 CI secrets 中配置：

- `WINDOWS_CERTIFICATE`：Base64 编码的 `.pfx` 证书内容。
- `WINDOWS_CERTIFICATE_PASSWORD`：证书密码。

## 自动更新

天枢已接入 `tauri-plugin-updater`，但更新服务器 endpoint 与签名密钥需自行配置。

### 1. 生成更新签名密钥对

```bash
cd desktop
npx tauri signer generate
```

私钥用于 CI 对更新包签名，公钥配置到 `tauri.conf.json` 的 `plugins.updater.pubKey`。

### 2. 配置更新端点

修改 `src-tauri/tauri.conf.json`：

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": ["https://your-cdn.com/tianshu-updates.json"],
    "pubKey": "YOUR_BASE64_ED25519_PUBLIC_KEY",
    "windows": { "installMode": "basicUi" }
  }
}
```

更新 JSON 格式参考 Tauri 官方文档。未配置时，设置里的「检查更新」会提示服务器未配置。

## CI 构建

仓库已配置两个 workflow：

- `.github/workflows/build-macos.yml`：标签推送 `v*` 时触发，产出 `.dmg` 与 `.app`。
- `.github/workflows/build-windows.yml`：标签推送 `v*` 时触发，产出 `.exe`、NSIS、MSI。

配置对应的 Repository Secrets 后即可自动签名与更新。

## 注意事项

- `src-tauri/resources/node/` 与 `.tmp-node-runtime` 不会被提交到 git，构建时自动下载。
- 当前 `better-sqlite3` 的 native `.node` 由 `scripts/pack-native.sh` 按构建机架构复制。若需跨平台分发，需为目标平台准备对应的 native binary。
- Linux 安装包（AppImage/deb/rpm）尚未配置完整 CI，如需支持，可在 `tauri.conf.json` 的 `bundle.targets` 中追加对应 target。
