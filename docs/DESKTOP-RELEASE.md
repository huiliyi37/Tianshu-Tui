# 桌面版打包与发布流程（Windows）

> 面向协助发布桌面安装包的 agent / 维护者。读完即可独立完成「拉代码 → 打包 → 签名 → 发布 → 自动更新上线」全流程。

## 0. 全景：一次发布要做什么

```
拉最新代码 → 改版本号 → npm run build（runtime）
   → tauri build（编译 Rust + 打 NSIS/MSI + 产 .sig 签名）
   → gen-latest-json.js（产 latest.json 更新清单）
   → 上传 3 件套到 GitHub Release
   → 用户端 app 自动检测到更新
```

**关键约束（必须知道）**：
- 本仓库 GitHub Actions 因账号绑卡问题**不可用**，全程**本地打包 + 网页上传**。
- 自动更新**不依赖 Actions**——updater 客户端只读 release 上的 `latest.json`（公开 CDN），所以本地流程完全够用。
- 产物文件名、安装路径、tag、release 必须**版本号一致**，否则更新检测会出错。

---

## 1. 一次性环境准备（仅首次）

### 1.1 Node.js 24.1.0（不是 22！）

打包机必须是 **Node 24.1.0**。原因：sidecar 运行时锁死 `DEFAULT_NODE_VERSION = "24.1.0"`，`better-sqlite3` 必须编译成 ABI 137。构建机 Node 版本必须 == 目标 sidecar Node 版本，否则 `stage-runtime-deps.js` 的 zero-degrade 断言会 fail-hard（这是保护机制，**不是 bug**）。

```powershell
# 验证
node -v   # 必须是 v24.1.0
node -p process.versions.modules   # 必须是 137
```

> 旧版 `docs/WINDOWS-INSTALL.md` 写的是 Node 22+，**那是对用户的，打包机要用 24.1.0**。

### 1.2 签名密钥对（自动更新必需）

私钥丢了 = 自动更新永久失效，发不了新版本。**必须妥善备份**（U 盘 / 密码管理器）。

```powershell
cd desktop
npx tauri signer generate -w ~/.tauri/tianshu.key --ci
# 产出：
#   ~/.tauri/tianshu.key       私钥（永久凭证，绝不入 git！）
#   ~/.tauri/tianshu.key.pub   公钥
```

**配置两处**：

1. **公钥** → `desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`（整段 base64 替换）。
2. **私钥** → `desktop/.env`（已被 gitignore）：
   ```bash
   # 用 PATH 引用，私钥内容不入此文件、不入 git
   TAURI_SIGNING_PRIVATE_KEY_PATH=C:\Users\<你>\.tauri\tianshu.key
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=
   ```
   确认 `.gitignore` 含 `.env`（`git check-ignore desktop/.env` 应输出路径）。

> **密钥丢失恢复**：重新 `tauri signer generate` 生成新对，更新 pubkey，**但已装旧版的用户无法自动更新到新密钥签的包**（公钥对不上）。所以**别丢**。

### 1.3 确认 `createUpdaterArtifacts: true`

`tauri.conf.json` 第 30 行附近必须为 `true`，否则不产 `.sig`。当前已开启，别关。

### 1.4 bundled busybox（2.12.0+ 引入，首次必准备）

2.12.0 起，安装包内置 **busybox-w32**（Windows 上的 POSIX shell + coreutils，让用户免装 Git for Windows）。`fetch-shell-runtime.js` 在 build 时从 `frippery.org` 下载 busybox 到 `resources/shell/win-x86_64/busybox.exe`。

**⚠️ 国内打包坑**：`frippery.org` 被墙（SSL 握手 reset），build 时下载必然失败。

**解法：手动放 busybox 到缓存路径，build 时 `fetch-shell-runtime.js` 命中缓存跳过下载。**

```bash
# 1. 用 VPN/代理下载 busybox-w32 64位（约 700KB）
#    源：https://frippery.org/busybox/busybox64.exe（注意：文件名是 busybox64.exe，不是带版本号）
#    或从任何可信源拿到 PE32+ x86-64 的 busybox-w32
mkdir -p desktop/src-tauri/resources/shell/win-x86_64
cp <下载的 busybox.exe> desktop/src-tauri/resources/shell/win-x86_64/busybox.exe

# 2. 验证（必须是 PE32+ x86-64，>1MB）
file desktop/src-tauri/resources/shell/win-x86_64/busybox.exe
# 应输出：PE32+ executable (console) x86-64
desktop/src-tauri/resources/shell/win-x86_64/busybox.exe echo ok
# 应输出：ok
```

> busybox 是**可选功能**（`bundled_busybox_path` 返回 None 时 sidecar 回退系统 shell），但 `tauri.conf` 的 `resources` 引用了 `resources/shell` 目录，**目录必须有内容 build 才不报错**。所以必须放 busybox（或至少放个占位文件）。
>
> 注意：这个目录是 git 未跟踪的（产物），仓库里只有 `.gitkeep` 占位。

---

## 2. 日常打包流程

### 2.1 拉最新代码

```bash
git fetch origin
git rebase origin/main   # 或 git merge origin/main
# 检查远程领先本地多少：git rev-list --count HEAD..origin/main
```

### 2.1b 补装 npm 依赖（每次合并新版本必做！）

**高频踩坑**：开发那边 sync 新版本时，`package.json` 经常新增依赖（如 `@tauri-apps/plugin-autostart`、`plugin-opener` 等），但 sync 只提交 `package.json`，**不会自动跑 `npm install`**。直接 build 会报 `Cannot find module '@tauri-apps/plugin-xxx'`（TS2307），白等几分钟才失败。

```bash
cd desktop
npm install   # 每次 fetch/merge 后必跑，补装新增依赖
# 同理，主仓库根目录也补一下（runtime 依赖）
cd .. && npm install
```

> Rust 依赖（Cargo.toml）不用手动装——`tauri build` 会自动 `cargo fetch`。

### 2.2 改版本号

版本号涉及**四处**，必须同步：

| 位置 | 说明 |
|------|------|
| `desktop/src-tauri/tauri.conf.json` 的 `"version"` | 决定安装包文件名、app 内版本 |
| git tag（`v0.0.x`）| release 命名 |
| GitHub Release tag | 上传时选/建 |
| `gen-latest-json.js --version` | latest.json 里的版本 |

```bash
# 例：发 0.0.4
# 改 tauri.conf.json: "version": "0.0.4"
```

### 2.3 杀残留进程（释放文件锁）

```bash
taskkill //IM tianshu-desktop.exe //F
taskkill //IM node.exe //F
```

### 2.4 重新构建 runtime（src/ 改了才需要）

```bash
npm run build
# 末尾看到 "Build success" 即成功
```

### 2.5 签名打包（核心）

**⚠️ Windows 踩坑（已验证）**：
- `tauri build` 的内置签名在 Windows 上读不到空密码 env var（`TAURI_SIGNING_PRIVATE_KEY` 在子进程丢失），会报 "A public key has been found, but no private key" → 不产 `.sig`。
- `build-signed.ps1`（项目自带的两步法脚本）理论上绕开了这个问题，但实测它的**签名步骤会卡住/超时**（PowerShell 下 `npx tauri signer sign` 仍丢失 env 或交互卡死）。
- **最可靠的方式：直接 build 出裸包（createUpdaterArtifacts 自然产 .sig 失败也无妨），再手动 `tauri signer sign` 显式传 `--private-key-path` + `--password ""`。**

```bash
cd D:/Tianshu-Tui/desktop

# Step 1: tauri build（createUpdaterArtifacts: true 时会试图内置签名，
#         失败也无所谓——只要 build 出 setup.exe 就行，签名我们手动补）
npx tauri build
# 末尾会报缺私钥的 error，但 Finished 2 bundles 已经产出 setup.exe/msi，忽略即可

# Step 2: 手动签名（显式传密钥路径 + 空密码，绝不卡交互）
npx tauri signer sign \
  --private-key-path ~/.tauri/tianshu.key \
  --password "" \
  "src-tauri/target/release/bundle/nsis/Tianshu_2.x.x_x64-setup.exe"
npx tauri signer sign \
  --private-key-path ~/.tauri/tianshu.key \
  --password "" \
  "src-tauri/target/release/bundle/msi/Tianshu_2.x.x_x64_zh-CN.msi"
```

成功标志：
```
# Step 1 末尾（error 可忽略，重点是 Finished 2 bundles）：
Finished 2 bundles at:
    ...nsis\Tianshu_2.x.x_x64-setup.exe
    ...msi\Tianshu_2.x.x_x64_zh-CN.msi

# Step 2 每个文件：
Your file was signed successfully, You can find the signature here:
    ...Tianshu_2.x.x_x64-setup.exe.sig
```

> **不要用** `build-signed.ps1`：实测它的签名步骤会卡住/超时。手动 `tauri signer sign --private-key-path ... --password ""` 是最可靠的。

### 2.6 清理 bundle 目录残留（重要！）

`target/release/bundle/` 会堆积历史版本的 setup.exe。`gen-latest-json.js` 用 `readdirSync().find()` 匹配第一个，**残留的旧文件会先被匹配到（它没 .sig）导致报错**。

```bash
cd desktop/src-tauri/target/release/bundle
# 删掉所有非当前版本的 setup.exe / msi
rm -f nsis/*-setup.exe nsis/*.sig msi/*.msi msi/*.sig   # 清干净
# 然后重新跑 2.5 只会产当前版本的包
```

> 更稳妥：每次打包前清空 bundle 目录，避免历史污染。

### 2.7 生成 latest.json 更新清单

```bash
cd D:/Tianshu-Tui
node desktop/scripts/gen-latest-json.js \
  --version 0.0.x \
  --notes "本次更新说明" \
  --bundle-dir desktop/src-tauri/target/release/bundle \
  --download-base https://github.com/huiliyi37/Tianshu-Tui/releases/download/v0.0.x \
  > desktop/src-tauri/target/release/bundle/latest.json
```

**验证 latest.json 的 url 字段**——必须是纯文件名，**不能含本地路径**（`desktop\src-tauri\...`）：
```json
"url": "https://.../releases/download/v0.0.x/Tianshu_0.0.x_x64-setup.exe"  ✅
"url": "https://.../releases/download/v0.0.x/desktop\...\Tianshu_..."        ❌ 脚本路径 bug
```

> 如果 url 含本地路径，是 `gen-latest-json.js` 的 Windows 路径 bug（已修，entry() 里 `replace(/\\/g,'/')`）。

---

## 3. 上传到 GitHub Release

### 3.1 网页上传（当前唯一可用方式）

`gh` CLI 未安装，走网页：

1. https://github.com/huiliyi37/Tianshu-Tui/releases/edit/v0.0.x（已存在）或 `/releases/new`（新建 tag）
2. **删掉** Assets 里所有旧文件
3. 拖入**三个文件**（缺一不可）：
   ```
   desktop/src-tauri/target/release/bundle/nsis/Tianshu_0.0.x_x64-setup.exe   ← 安装包
   desktop/src-tauri/target/release/bundle/nsis/Tianshu_0.0.x_x64-setup.exe.sig ← 签名
   desktop/src-tauri/target/release/bundle/latest.json                          ← 更新清单
   ```
4. 发布

### 3.2 关键：v0.0.x 必须是 latest release

updater endpoint 是 `releases/latest/download/latest.json`。所以当前版本 release 必须：
- **非草稿**（draft 不算 latest）
- **非预发布**（prerelease 不算）
- 是**时间最新的**

上传后确认该 release 显示 "Latest"。

---

## 4. 验证自动更新闭环

```bash
# 1. latest.json 能访问吗
curl -s https://github.com/huiliyi37/Tianshu-Tui/releases/latest/download/latest.json | head -20

# 2. url 指向的安装包能下载吗
curl -sI https://github.com/huiliyi37/Tianshu-Tui/releases/download/v0.0.x/Tianshu_0.0.x_x64-setup.exe | grep -i "HTTP\|content-length"
```

两个都 200 = 闭环通。用户端 app 下次启动会自动检测更新。

---

## 5. 提交代码改动

每次发布通常伴随代码改动（版本号、修复、脚本）。提交 push：

```bash
git add desktop/src-tauri/tauri.conf.json desktop/scripts/gen-latest-json.js ...
git commit -m "chore(desktop): bump version 0.0.x; ..."
git push origin main
```

> 若 push 报 non-fast-forward（远端有新提交）：`git fetch && git rebase origin/main` 后重试。rebase 无冲突（改不同文件）则自动完成。

---

## 6. 常见坑速查

| 症状 | 原因 | 解决 |
|------|------|------|
| build 报 "缺 TAURI_SIGNING_PRIVATE_KEY" | 后台 source .env 没传给子进程 | 单条命令 `export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/tianshu.key)"` |
| 没 .sig 产出 | 私钥没注入 | 同上 |
| gen-latest-json 报"缺少签名文件" | bundle 目录有旧版本残留先被匹配 | 清空 bundle 目录重打 |
| latest.json url 含本地路径 | 脚本 Windows 路径 bug | `entry()` 加 `.replace(/\\/g,'/')`（已修） |
| MSI 报 LGHT0311 / codepage 错误 | 产品名含中文 + MSI 默认西欧 codepage | `bundle.windows.wix.language = "zh-CN"`（已配） |
| sidecar 报 EISDIR: lstat 'D:' | `\\?\` verbatim 路径前缀 | lib.rs 的 `strip_verbatim_prefix()`（已修） |
| build 在 stage-runtime-deps 失败 ABI 不匹配 | 构建机 Node ≠ 24.1.0 | 装回 Node 24.1.0 |
| better-sqlite3 退化成 nullDb | native 加载失败 | 见 `src/repo/native-resolver.ts`，构建用 zero-degrade 断言保证 |

---

## 7. 文件清单（发布前核对）

发布一个版本，本地应产出：

```
desktop/src-tauri/target/release/bundle/
├── nsis/
│   ├── Tianshu_0.0.x_x64-setup.exe        ← 上传
│   └── Tianshu_0.0.x_x64-setup.exe.sig    ← 上传
└── latest.json                             ← 上传（在 bundle/ 根，不在 nsis/）
```

上传这三个到 release，自动更新就生效了。

---

## 附：当前打包机配置（2026-07）

- Node：v24.1.0（系统默认，MSI 装在 `C:\Program Files\nodejs`，ABI 137）
- 密钥：`~/.tauri/tianshu.key`（私钥，pubkey `198A2F01...`，备份在维护者处）
- `.env`：`desktop/.env`（gitignore，`TAURI_SIGNING_PRIVATE_KEY_PATH` 引用私钥）
- busybox：`desktop/src-tauri/resources/shell/win-x86_64/busybox.exe`（手动放，VPN 下载）
- 版本：2.13.0，productName `Tianshu`（安装路径英文，窗口标题保留中文「天枢」）
- Git 集成：runtime 侧 env-check 检测+引导（v2.13.0+），**不是打包内置 git 二进制**
