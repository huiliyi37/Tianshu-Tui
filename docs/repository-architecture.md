# 仓库架构与多设备发布拓扑

> 记录天枢项目的三仓库/三设备开发与发布架构。
> 最后更新：2026-07-01

## 1. 仓库/设备总览

```
┌─────────────────────────────────────────────────────────────────┐
│                      GitHub 远端                                 │
│            huiliyi37/Tianshu-Tui (开源仓库)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ 源码 (main)   │  │ Releases     │  │ npm: tianshu-tui     │   │
│  │              │  │ v0.0.5 桌面端 │  │ 2.11.0              │   │
│  │              │  │ latest.json  │  │                      │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
└─────────┼─────────────────┼─────────────────────┼───────────────┘
          │                 │                     │
    ┌─────┴─────┐    ┌──────┴──────┐    ┌─────────┴─────────┐
    │   sync    │    │ 上传 asset  │    │   npm publish     │
    └─────┬─────┘    └──────┬──────┘    └─────────┬─────────┘
          │                 │                     │
┌─────────┴─────────────────┴─────────────────────┴─────────────────┐
│                        本地设备                                     │
│                                                                     │
│  ┌─── Mac (开发机) ───────────────────────────────────────────┐    │
│  │  开发仓库: /Users/banxia/app/deepseek-tui/opencode-tui      │    │
│  │  开源仓库: /Users/banxia/app/Tianshu                        │    │
│  │  职责: 开发 + 构建 TUI + 打包 Mac 桌面端 + npm 发布          │    │
│  │  角色: 主开发环境                                            │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌─── Windows PC (打包机) ─────────────────────────────────────┐   │
│  │  路径: D:\Tianshu-Tui                                        │   │
│  │  职责: 打包 Windows 桌面端 (NSIS/MSI) + 签名 + 上传 Release   │   │
│  │  Node: 24.1.0 (ABI 137)                                     │   │
│  │  角色: Windows 发布站                                        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

| 标识 | 路径 | 设备 | 职责 |
|------|------|------|------|
| 开发仓库 | `/Users/banxia/app/deepseek-tui/opencode-tui` | Mac | 日常开发、TUI 构建、Mac 桌面打包 |
| 开源仓库 | `/Users/banxia/app/Tianshu` | Mac | 公开源码镜像、npm 发布入口 |
| Windows 打包机 | `D:\Tianshu-Tui` | Windows PC | Windows 桌面端打包、签名、上传 |

## 2. 数据流向

```
开发仓库 (opencode-tui)
    │
    │  scripts/sync-to-public.sh
    │  筛选公开文件，排除 .rivet/internal/、遥测、私密配置
    ▼
开源仓库 (Tianshu)
    │
    ├── git push → GitHub huiliyi37/Tianshu-Tui (源码)
    │
    ├── npm publish → npm registry (tianshu-tui)
    │     └── TUI 用户 /update 自动更新
    │
    └── 构建产物由各平台分别上传到 GitHub Releases
          │
          ├── Mac:  .app.tar.gz + .sig  ─┐
          ├── Win:  .exe + .sig          ├── v0.0.x Release
          └── 通用: latest.json          ─┘
                │
                └── 桌面端 Tauri updater 自动更新
                    (darwin-aarch64 / darwin-x86_64 / windows-x86_64)
```

## 3. 工作流

### 3.1 日常开发 → 同步到开源仓库

```bash
# 在开发仓库中开发...
# 完成后同步:
cd /Users/banxia/app/deepseek-tui/opencode-tui
bash scripts/sync-to-public.sh
```

该脚本将公开文件从开发仓库同步到开源仓库，排除内部知识库、遥测数据、私密配置。

### 3.2 TUI 版本发布（Mac 上完成）

```bash
cd /Users/banxia/app/Tianshu

# 1. 确保开源仓库已同步最新代码
git pull origin main

# 2. 改版本号
npm version patch  # 或 minor / major

# 3. 构建 + 发布（prepublishOnly 自动跑 build）
npm publish

# 4. 推送 tag
git push origin main --tags
```

TUI 用户通过 `/update` 命令或启动时自动检查 npm registry 获取更新。

### 3.3 Mac 桌面端打包（Mac 上完成）

```bash
cd /Users/banxia/app/deepseek-tui/opencode-tui/desktop

# 1. 改版本号: src-tauri/tauri.conf.json → "version"
# 2. 构建 TUI runtime
npm run build

# 3. 签名并构建
bash scripts/sign-and-build.sh

# 4. 生成 latest.json
node scripts/gen-latest-json.js \
  --version 0.0.x \
  --bundle-dir src-tauri/target/release/bundle \
  --download-base https://github.com/huiliyi37/Tianshu-Tui/releases/download/v0.0.x

# 5. 上传到 GitHub Release (gh CLI 或网页)
gh release upload v0.0.x \
  src-tauri/target/release/bundle/macos/Tianshu.app.tar.gz \
  src-tauri/target/release/bundle/macos/Tianshu.app.tar.gz.sig \
  src-tauri/target/release/bundle/latest.json \
  --repo huiliyi37/Tianshu-Tui --clobber
```

### 3.4 Windows 桌面端打包（Windows PC 上完成）

详见 `docs/DESKTOP-RELEASE.md`。核心流程：

```powershell
# 1. 拉最新代码
git pull origin main

# 2. 改版本号 (四处同步)

# 3. 构建 runtime
npm run build

# 4. 打包 (可选一键脚本)
powershell -ExecutionPolicy Bypass -File desktop/scripts/build-signed.ps1

# 5. 生成 latest.json
node desktop/scripts/gen-latest-json.js --version 0.0.x ...

# 6. 网页上传到 GitHub Release
```

### 3.5 多平台 Release 协调

当 Mac 和 Windows 都要发同一个版本时：

1. 先由一方上传 `latest.json`（或双方协商合并）
2. `latest.json` 需同时包含三个平台的条目（`darwin-aarch64`、`darwin-x86_64`、`windows-x86_64`）
3. 后上传的一方用 `gh release upload --clobber` 覆盖 `latest.json`，确保三平台完整
4. 推荐用 `gen-latest-json.js` 生成后再手动合并平台条目

当前 `latest.json` 结构（v0.0.5）：

```json
{
  "version": "0.0.5",
  "platforms": {
    "darwin-aarch64": { "url": "...Tianshu.app.tar.gz", "signature": "..." },
    "darwin-x86_64":  { "url": "...Tianshu.app.tar.gz", "signature": "..." },
    "windows-x86_64": { "url": "...Tianshu_0.0.5_x64-setup.exe", "signature": "..." }
  }
}
```

## 4. 自动更新链路

### 4.1 TUI 端 (`src/tui/updater.ts`)

```
启动 → checkForUpdate()
  ├── 优先: npm registry (tianshu-tui latest)
  ├── 回退: GitHub Releases API (/releases/latest)
  └── 缓存: 本地 24h 缓存，跳过重复请求

有更新 → 显示 "⬆️ Update available: x → y. Run /update to upgrade."
/update → npm install -g (全局安装) 或 git pull (源码安装)
```

### 4.2 桌面端 (Tauri updater)

```
启动 → GET https://github.com/.../releases/latest/download/latest.json
  → 比对本地版本 vs latest.json 的 version
  → 匹配当前平台 (darwin-aarch64 / darwin-x86_64 / windows-x86_64)
  → 下载 .app.tar.gz (Mac) 或 .exe (Windows)
  → 验证签名 → 安装
```

## 5. 关键约束

- **Node 版本**：打包机必须 Node 24.1.0 (ABI 137)，用户端 Node 22+ 即可
- **签名密钥**：`~/.tauri/tianshu.key` 是桌面端自动更新的根凭证，丢失 = 自动更新永久失效
- **latest.json**：必须含所有活跃平台的条目，缺少平台 = 该平台用户看不到更新
- **npm token**：`~/.npmrc` 中配置 Granular Access Token（Bypass 2FA），不提交到 git
- **sync-to-public.sh**：从开发仓库同步到开源仓库时，自动过滤内部文件，不要手动拷贝源码目录

## 6. 相关文档

- `docs/DESKTOP-RELEASE.md` — Windows 桌面端打包详细流程
- `docs/publishing.md` — npm 发布流程
- `desktop/scripts/gen-latest-json.js` — latest.json 生成脚本
- `scripts/sync-to-public.sh` — 开发→开源同步脚本
- `src/tui/updater.ts` — TUI 自动更新实现
