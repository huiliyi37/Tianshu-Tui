# 天枢桌面版近期任务与 Windows 分包指南

> 记录 2026-06-27 前后完成的桌面端 4 组提交，以及后续 Windows 分包的扩展思路。

---

## 一、近期提交总览

```text
d01acaf9 insights: worker runtime panel with model/provider/usage and cost breakdown
8ea37831 desktop: Git graph, artifact preview, voice input, and surface navigation
db88ffda desktop: regenerate full Tauri icon set from source
f62680f6 desktop: packaging, distribution, and CI setup
```

### 1.1 packaging, distribution, and CI setup

- 修正 `tauri.conf.json` 的 `beforeBuildCommand`/`frontendDist`，使其指向 Vite 产出目录。
- 在 `bundle.targets` 中启用 `dmg`、`nsis`、`msi`。
- 引入 `@tauri-apps/plugin-updater`，在 `src-tauri/src/lib.rs` 注册 updater 插件。
- 构建期通过 `desktop/scripts/fetch-node-runtime.{js,sh}` 下载官方 Node 二进制，并打包到 `src-tauri/resources/node/<os>-<arch>/`。
- sidecar 启动时按 `RIVET_SIDECAR_CMD` → 打包资源 → 系统路径 → PATH 的顺序查找 Node。
- 添加 macOS / Windows 两个 GitHub Actions workflow（`.github/workflows/build-macos.yml`、`.github/workflows/build-windows.yml`），按 `v*` 标签触发构建。
- 新增 `desktop/DISTRIBUTION.md` 与 `desktop/.env.example`。

### 1.2 regenerate full Tauri icon set from source

- 以 `desktop/src-tauri/icons/icon-source.png` 为源，生成完整的 Tauri 图标集：
  - macOS：`icon.icns`
  - Windows：`icon.ico`
  - 通用 PNG：`icon.png`、`128x128.png`、`128x128@2x.png` 等
  - Android：`android/mipmap-*/ic_launcher*.png`
  - iOS：`ios/AppIcon-*.png`
- 删除旧的占位 `app-icon.png`。

### 1.3 Git graph, artifact preview, voice input, and surface navigation

- **Git 分支图**：新增 `desktop/src/surfaces/GitSurface.tsx`，后端提供 `GET /git/graph`。
- **Artifact 预览**：`ReviewPanel` 支持 `markdown` / `html` artifact 的 sandboxed iframe 预览，带 rendered/raw 切换。
- **语音输入**：`Composer` 增加麦克风按钮，使用 Web Speech API 进行语音转文字。
- **Surface 导航**：Rail、ProjectSidebar、`App.tsx`、快捷键（Cmd+1..7）、Command Palette 全部接入 `git` 与 `insights` 两个新 surface。

### 1.4 insights: worker runtime panel

- **后端 enrichment**：
  - `WorkerResult` 扩展 `model` / `provider` / `usage` 字段。
  - `coordinator.ts` 在 worker / hands / 重试 / Flash→Pro 升级 / 失败降级路径上把实际调用的模型与用量写回结果。
  - `delegate-task` / `delegate-batch` / `team-orchestrate` 在 terminal `DelegationActivity` 回调中填充这些字段。
  - `session-manager.ts` 转发到 `delegation` 事件流。
- **价格表与计费**：
  - `modelConfigSchema` 增加 `pricing`（input/output/cacheRead/cacheWrite/reasoning，每 1M tokens USD）。
  - 内置 preset（DeepSeek / GLM / MiMo / MiniMax / Codex）提供占位价格。
  - 新增 `src/utils/pricing.ts`：`computeUsageCost`、`findModelPricing`、`formatCost`、`formatTokens`。
- **Insights API**：新增 `GET /sessions/:id/insights`，返回 totals、cacheHitRate、per-worker、per-model、per-provider 聚合。
- **前端面板**：新增 `desktop/src/surfaces/InsightsSurface.tsx`，展示总成本、总 tokens、worker 数、缓存命中率及三张明细表。

---

## 二、Windows 分包策略

当前 Windows 产物有三种形态：

| 产物 | 路径 | 用途 |
|---|---|---|
| 便携 exe | `src-tauri/target/release/天枢.exe` | 无需安装，直接运行 |
| NSIS 安装包 | `src-tauri/target/release/bundle/nsis/天枢_*.exe` | 在线下载式安装程序 |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/天枢_*.msi` | 企业静默部署/组策略 |

### 2.1 当前已支持的 Windows 构建

在 Windows 构建机或 CI 上执行：

```bash
cd desktop
node scripts/fetch-node-runtime.js
npm run tauri:build
```

`tauri.conf.json` 中已配置：

```json
"bundle": {
  "targets": ["dmg", "nsis", "msi"],
  "windows": {
    "nsis": { "installMode": "both" },
    "msi": { "installMode": "both" }
  }
}
```

### 2.2 后续按架构分包

Tauri v2 默认会按当前构建机架构产出。若要为 Windows 提供 x64 与 arm64 两个独立安装包，需要：

#### 2.2.1 在 CI 中显式指定 target

```yaml
# .github/workflows/build-windows.yml 片段
strategy:
  matrix:
    include:
      - target: x86_64-pc-windows-msvc
        arch: x64
      - target: aarch64-pc-windows-msvc
        arch: arm64

steps:
  - uses: actions/checkout@v4
  - uses: dtolnay/rust-toolchain@stable
    with:
      targets: ${{ matrix.target }}
  - run: cd desktop && node scripts/fetch-node-runtime.js
  - run: cd desktop && npm run tauri:build -- --target ${{ matrix.target }}
```

#### 2.2.2 Node 运行时按架构下载

`fetch-node-runtime.js` 已按 `process.arch` 默认下载当前架构。CI 交叉编译时需要传入目标架构：

```bash
# 构建 x64 包时
NODE_ARCH=x64 node scripts/fetch-node-runtime.js

# 构建 arm64 包时
NODE_ARCH=arm64 node scripts/fetch-node-runtime.js
```

需要扩展脚本以支持 `NODE_ARCH` 环境变量覆盖（目前脚本可能已读取 `process.arch`，视实现而定）。

#### 2.2.3 产物命名区分架构

Tauri 默认命名不自动带架构后缀，可通过 CI 重命名或在 `tauri.conf.json` 中使用变量：

```json
"bundle": {
  "windows": {
    "nsis": {
      "installerHooks": "./installer-hooks.nsh"
    }
  }
}
```

更简单的做法是在 CI 中重命名：

```yaml
- run: mv "desktop/src-tauri/target/${{ matrix.target }}/release/bundle/nsis/天枢_*.exe" "天枢-${{ matrix.arch }}.exe"
```

### 2.3 减小安装包体积：分包与可选组件

#### 2.3.1 把 Node 运行时作为可选下载

当前 Node 二进制（约 100MB）被打包进每个安装包。若想让基础安装包更小，可：

1. 不在 `src-tauri/resources/node/` 放二进制，改为首次启动时检测并下载。
2. sidecar 启动逻辑（`src-tauri/src/lib.rs`）在找不到打包 Node 时，从 CDN 下载到 `app_data_dir/node-runtime/<os>-<arch>/`。
3. 这样安装包可减小约 100MB，但首次启动需联网。

#### 2.3.2 按功能分包

Tauri 本身不支持一个 app 的功能级分包，但可以通过以下方式模拟：

- **插件化 native 依赖**：把 `better-sqlite3`、AST parser 等大体积 native 模块做成按需下载的 sidecar 或动态库。
- **可选语言模型**：模型文件本身不应随安装包分发，始终通过配置指向云端 API。
- **分渠道发布**：
  - `tianshu-full.exe`：含 Node 运行时，离线可用。
  - `tianshu-slim.exe`：不含 Node 运行时，首次启动下载。

### 2.4 Windows 代码签名

未签名时 Windows 会提示「Microsoft Defender SmartScreen」。

#### 2.4.1 EV / 标准代码签名证书

在 CI Secrets 中配置：

- `WINDOWS_CERTIFICATE`：Base64 编码的 `.pfx` 证书。
- `WINDOWS_CERTIFICATE_PASSWORD`：证书密码。

Tauri 会自动读取这些环境变量并签名 NSIS / MSI。

#### 2.4.2 替代方案：Azure Trusted Signing

若使用 Azure Trusted Signing（类似 Apple 公证）：

1. 在 Azure 创建 Trusted Signing Account 与 Certificate Profile。
2. 安装 `azuresigntool` 或 `signpath`。
3. 在 Tauri 的 `bundle.windows.nsis` / `bundle.windows.msi` 中禁用自动签名，改为构建后调用：

```bash
AzureSignTool sign \
  -kvu https://<vault>.vault.azure.net \
  -kvi $AZURE_CLIENT_ID \
  -kvs $AZURE_CLIENT_SECRET \
  -kvc $CERT_PROFILE_NAME \
  -tr http://timestamp.digicert.com \
  -v "src-tauri/target/release/bundle/nsis/天枢_*.exe"
```

### 2.5 从 macOS 交叉编译 Windows

Tauri 官方不支持从 macOS 直接交叉编译 Windows。推荐方案：

1. **CI 构建**：用 GitHub Actions 的 `windows-latest` runner。
2. **本地测试**：使用 Parallels / VMware / UTM 跑 Windows 虚拟机。
3. **容器方案**：使用 `dockcross/windows-static-x64` 等交叉编译容器，但 Tauri 依赖 Windows SDK，实际可行性低。

### 2.6 更新与多架构分发

自动更新 JSON 需要区分架构与平台：

```json
{
  "version": "v0.0.2",
  "notes": "...",
  "pub_date": "2026-06-27T00:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "...", "url": "https://cdn/天枢_0.0.2_aarch64.dmg" },
    "darwin-x86_64": { "signature": "...", "url": "https://cdn/天枢_0.0.2_x64.dmg" },
    "windows-x86_64": { "signature": "...", "url": "https://cdn/天枢_0.0.2_x64-setup.exe" },
    "windows-aarch64": { "signature": "...", "url": "https://cdn/天枢_0.0.2_arm64-setup.exe" }
  }
}
```

CI 构建后，由发布脚本合并各平台产物并生成上述 JSON，上传到 CDN。

---

## 三、遗留与后续 TODO

- [ ] Windows ARM64 CI runner 可用后，在 `build-windows.yml` 中加入 `aarch64-pc-windows-msvc` 矩阵。
- [ ] 为 `fetch-node-runtime.js` 增加 `NODE_ARCH` / `NODE_PLATFORM` 环境变量覆盖，支持交叉编译。
- [ ] 评估是否把 Node 运行时改为首次启动下载，以减小安装包体积。
- [ ] 配置真实代码签名证书（EV 或 Azure Trusted Signing）并关闭 SmartScreen 提示。
- [ ] 配置 updater CDN endpoint 与 Ed25519 公钥。
- [ ] Linux 安装包（AppImage / deb / rpm）如需要，追加到 `bundle.targets` 并补充 CI。
