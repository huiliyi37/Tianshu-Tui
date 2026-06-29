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
NODE_VERSION=24.1.0 node scripts/fetch-node-runtime.js
```

## 代码签名与公证

`tauri.conf.json` 已配置好签名/公证占位：macOS 启用 `hardenedRuntime` 并读取 `APPLE_SIGNING_IDENTITY`，Windows 读取 `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`。

未配置证书时，构建仍会成功，但产物未签名/未公证，用户在 macOS/Windows 上打开时会看到安全提示。

### macOS

**当前发布策略：未签名 + 用户首次 `xattr`。** 开源项目暂不付费做 Apple 公证（需 $99/年 Developer Program），所以正式包未签名。这是有意为之，不是缺陷。

#### 默认流程（无需任何 Apple 账号）

照常 `bash scripts/sign-and-build.sh` 出 dmg（脚本检测到没配 `APPLE_SIGNING_IDENTITY` 会提示「未签名」）。发布时**必须**在 Release 说明里带上首次打开指引（见下方「发布说明模板」），否则用户点开报「已损坏」会以为包坏了。

用户首次打开：拖入「应用程序」后执行一次

```bash
xattr -cr /Applications/天枢.app
```

清掉下载隔离属性即可。对「已损坏」提示，右键→打开通常无效，必须用 `xattr`。

#### 发布说明模板（每次 macOS Release 粘贴）

```markdown
### macOS 安装说明（重要）

下载 `天枢_x.x.x_aarch64.dmg`，拖入「应用程序」。

首次打开如提示「天枢已损坏，移到废纸篓」——包没坏，这是 Apple 对未公证开源应用的拦截。
打开「终端」执行一次即可正常使用：

    xattr -cr /Applications/天枢.app
```

---

#### 可选：Developer ID 签名 + 公证（想彻底免提示再做，需付费账号）

> 配齐下面材料后，构建管线会自动签名 + 公证（含嵌套 Node/.node/esbuild），用户双击即开、无需 `xattr`。没配则自动退回上面的未签名流程，零副作用。

##### 准备材料（一次性）

1. 加入 Apple Developer Program（个人/公司账号，$99/年）。
2. 在钥匙串创建 **Developer ID Application** 证书（Xcode → Settings → Accounts → Manage Certificates，或 developer.apple.com → Certificates 下载 .cer 双击导入）。`security find-identity -v -p codesigning` 应能看到它。
3. 在 appleid.apple.com → 登录与安全 → App 专用密码，生成一个 **App-Specific Password**（用于公证，**不是**登录密码）。
4. 在 developer.apple.com → Membership 记下 **10 位 Team ID**。

##### 配置环境变量（写进 `desktop/.env`，已 gitignore）

四项缺一不可——前者负责签名，后三者负责公证：

- `APPLE_SIGNING_IDENTITY`：证书全名，如 `"Developer ID Application: Your Name (TEAMID)"`。
- `APPLE_ID`：Apple ID 邮箱。
- `APPLE_TEAM_ID`：10 字符团队 ID。
- `APPLE_PASSWORD`：App-Specific Password。

配好后照常 `bash scripts/sign-and-build.sh`——脚本会自检并打印「将签名 + 公证」；缺公证三项时会显式警告（产物只签名、未公证，下载后仍报损坏）。

##### 嵌套二进制签名（已自动处理）

天枢把 Node 运行时、`better_sqlite3.node` 等原生 `.node`、esbuild 二进制放在 `Contents/Resources/` 下。Tauri **只自动签标准位置（MacOS/Frameworks/PlugIns…）**，不签 Resources 里的这些 Mach-O，而 Apple 公证要求 bundle 内**每个** Mach-O 都签名。因此 `scripts/codesign-nested.js` 在 `beforeBuildCommand` 里、`tauri build` 组包前预签这些源二进制（签名随文件拷进 .app）。该脚本读同一个 `APPLE_SIGNING_IDENTITY`，未设则空操作。`entitlements.plist` 提供 V8/Node JIT 所需的 `allow-jit` / `allow-unsigned-executable-memory`（否则公证后启动即崩）。

### Windows

需要代码签名证书。在 CI secrets 中配置：

- `WINDOWS_CERTIFICATE`：Base64 编码的 `.pfx` 证书内容。
- `WINDOWS_CERTIFICATE_PASSWORD`：证书密码。

## 自动更新（GitHub Releases 托管）

天枢已接入 `tauri-plugin-updater`，采用 **GitHub Releases 托管** 方案：endpoint 指向
`https://github.com/<owner>/<repo>/releases/latest/download/latest.json`，安装包 + `.sig` 签名 +
`latest.json` 清单都作为 Release asset 上传，零额外运维。

### 1. 生成更新签名密钥对（仅首次）

```bash
cd desktop
npx tauri signer generate -w ~/.tauri/tianshu.key
```

输出：公钥（base64）+ 私钥（base64）+ 密码。

- **公钥** → 填进 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
  （替换占位 `REPLACE_WITH_PUBLIC_KEY_FROM_NPX_TAURI_SIGNER_GENERATE`）。
- **私钥 + 密码** → 写入本地 `desktop/.env`（已 gitignore，绝不入库），格式见 `.env.example`。
- CI 用 Repository Secrets：`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

### 2. 配置（已完成的部分）

- `tauri.conf.json`：`bundle.createUpdaterArtifacts: true`（构建时产出 `.sig`）、
  `updater.endpoints` 指向 GitHub Releases、`updater.pubkey` 待填公钥。
- `capabilities/default.json`：已加 `updater:default` + `process:default` 权限
  （否则前端 `check()` / `relaunch()` 被拒）。
- 前端：`UpdaterSection`（设置页）支持下载安装 + 进度 + 重启；
  `UpdateBanner`（启动时静默检查，有新版顶部弹横幅一键更新）。

### 3. 本地签名构建

```bash
cd desktop
bash scripts/sign-and-build.sh
```

脚本会 source `.env` 读私钥/密码，构建带 `.sig` 的安装包。

### 4. 发布到 GitHub Release（CI 自动）

标签推送 `v*` 触发 `build-macos.yml` / `build-windows.yml`：
1. 注入签名密钥 → `tauri build` 产出安装包 + `.sig`。
2. `softprops/action-gh-release` 上传 `.dmg` / `.exe` + `.sig` 到草稿 Release。
3. 合并产物后用 `gen-latest-json.js` 生成 `latest.json`：

```bash
node desktop/scripts/gen-latest-json.js \
  --version 0.1.0 \
  --notes "release notes" \
  --bundle-dir desktop/src-tauri/target/release/bundle \
  --download-base https://github.com/<owner>/<repo>/releases/download/v0.1.0 \
  > latest.json
```

4. 把 `latest.json` 上传到同一 Release，发布草稿。客户端即能拉到更新。

### latest.json 格式（Tauri v2）

```json
{
  "version": "0.1.0",
  "notes": "...",
  "pub_date": "2026-06-28T00:00:00.000Z",
  "platforms": {
    "darwin-aarch64": { "url": ".../天枢_0.1.0_aarch64.dmg", "signature": "..." },
    "darwin-x86_64":  { "url": ".../天枢_0.1.0_x64.dmg",    "signature": "..." },
    "windows-x86_64": { "url": ".../天枢_0.1.0_x64-setup.exe", "signature": "..." }
  }
}
```

> 注意：updater 的 `.sig` 是 Tauri 自己的更新签名（Ed25519），与 macOS notarization /
> Windows 代码签名是两回事。OS 签名见上文的签名配置段。

## CI 构建

仓库已配置两个 workflow：

- `.github/workflows/build-macos.yml`：标签推送 `v*` 时触发，产出 `.dmg` 与 `.app` + `.sig`，并发布到 GitHub Release。
- `.github/workflows/build-windows.yml`：标签推送 `v*` 时触发，产出 `.exe`、NSIS、MSI + `.sig`，并发布到 GitHub Release。

配置 Repository Secrets（`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）
后即可自动签名与发布更新。

## 注意事项

- `src-tauri/resources/node/` 与 `.tmp-node-runtime` 不会被提交到 git，构建时自动下载。
- 当前 `better-sqlite3` 的 native `.node` 由 `scripts/pack-native.sh` 按构建机架构复制。若需跨平台分发，需为目标平台准备对应的 native binary。
- Linux 安装包（AppImage/deb/rpm）尚未配置完整 CI，如需支持，可在 `tauri.conf.json` 的 `bundle.targets` 中追加对应 target。
