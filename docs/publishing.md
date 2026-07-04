# 发布 Tianshu TUI

## 双仓库结构

本项目有两个仓库：

- **开发仓库**：`/Users/banxia/app/deepseek-tui/opencode-tui`（私有，完整历史、测试、设计文档）
- **开源仓库**：`/Users/banxia/app/Tianshu`（对应 GitHub `huiliyi37/Tianshu-Tui`，只发布源码和产物）

开发仓库用 `scripts/sync-to-public.sh` 把可公开的内容同步到开源仓库。

## 前置条件

- npm 账号：`huiliyi37`
- Granular Access Token 已配置在 `~/.npmrc`（`npm_wi...`），勾了 **Bypass 2FA**，`npm publish` 不再需要输入验证码
- 不要把这个 token 发给任何人或提交到 git

## 发布步骤

```bash
# 1. 在开发仓库改版本号（package.json 里的 version）
#    确保比 npm 上当前版本高，否则 publish 会拒绝
npm version patch   # 2.11.1 → 2.11.2
# 或: npm version minor / npm version major

# 2. 构建（publish 时 prepublishOnly 也会自动跑，但手动确认更安全）
npm run build

# 3. 发布到 npm（token 已绕过 2FA，一键完成）
npm publish

# 4. 同步到开源仓库并推送
bash scripts/sync-to-public.sh
cd /Users/banxia/app/Tianshu
git add -A
git commit -m "chore(release): $(node -p "require('./package.json').version")"
git push

# 5. 推送开发仓库的 tag（可选，如果你希望开发仓库的 tag 也到远端）
cd /Users/banxia/app/deepseek-tui/opencode-tui
git push origin main --tags
```

## 同步脚本说明

`scripts/sync-to-public.sh` 用 rsync 把以下内容同步到开源仓库：

- `src/`（排除 `__tests__/` 和 `*.test.ts`）
- `scripts/`（排除部分内部诊断脚本）
- `desktop/`（排除构建产物和测试）
- `docs/seed-capsule*.md`、`docs/stars/`、`docs/brand/assets/`
- `.rivet/knowledge/`
- `README.md`、`README.en.md`、`CLAUDE.md`、`.rivet.md`、`AGENTS.md`、`.rivet/SELF`、`.rivet-config.json`、`tsconfig.json`、`tsup.config.ts`、`package.json`
- `runtime-assets/`（排除 `node_modules/`）
- `.github/`（排除 `ISSUE_TEMPLATE/`、`dependabot.yml`）

**不会同步**：`.cursor/`、`.rivet/plans/`、`.rivet/sessions/`、`docs/design/`、`docs/teamtask/` 等内部资料。

## 用户端更新机制

用户通过 `npm install -g tianshu-tui` 安装后，TUI 每次启动会异步检查 npm registry 是否有新版本，**缓存 1 小时**。

有新版本时显示：
```
⬆️  Update available: 2.11.1 → 2.11.2. Run /update to upgrade.
```

用户在 TUI 内输入 `/update` 即可自动升级并重启。

环境变量 `RIVET_NO_UPDATE_CHECK=1` 可关闭启动检查。

## 更新链路

```
npm publish
    → npm registry 更新 latest 标签
    → 用户下次启动 TUI → fetchNpmLatestVersion("tianshu-tui")
    → semver 比较 → 有新版本 → 显示 banner
    → /update → npm install -g tianshu-tui@latest → restart
```

源码安装（git clone）的用户走 `git pull && npm install && npm run build` 路径，不经过 npm。

## 排查：另一台电脑没收到更新横幅

按优先级检查：

1. **1 小时缓存还没过期**
   - 在另一台电脑删缓存后重启：
     ```bash
     # macOS/Linux
     rm ~/.rivet/update-check.json
     npx tianshu-tui

     # Windows PowerShell
     Remove-Item "$env:LOCALAPPDATA\.rivet\update-check.json"
     npx tianshu-tui
     ```

2. **安装来源不是 npm 全局**
   - 源码安装会查 GitHub releases，需要对应 release 存在
   - 本地项目依赖不会自动更新，会提示手动执行

3. **网络问题**
   - 测试能否访问 npm registry：
     ```bash
     curl https://registry.npmjs.org/tianshu-tui/latest
     ```

4. **更新检查被关闭**
   - 检查环境变量：
     ```bash
     echo $RIVET_NO_UPDATE_CHECK
     ```

5. **当前版本已经是最新**
   - 检查当前版本：
     ```bash
     npx tianshu-tui --version
     ```

## 注意事项

- `npm publish` 前确保 `npm run build` 已执行，否则用户装到的是旧 dist
- `prepublishOnly` 脚本会在 publish 前自动跑 build，但手动确认更安全
- 如果 token 过期或失效，去 https://www.npmjs.com/settings/huiliyi37/tokens 重新生成
- `package.json` 里的 `files` 字段控制了哪些文件会被打包发布，不要往里加敏感文件
- `dist/` 和 `.cursor/` 在 `.gitignore` 中，但 npm 会按 `files` 字段包含 `dist/`，所以不影响发布

## 多机协作与冲突处理

当多台机器（如 macOS 开发机 + Windows 打包机）都往开源仓库推送时，会出现 `[rejected] main -> main (fetch first)`。

### 开源仓库路径

| 机器 | 路径 |
|------|------|
| macOS 开发机 | `/Users/banxia/app/Tianshu` |
| Windows 打包机 | （按 Windows 实际路径） |

远程：`https://github.com/huiliyi37/Tianshu-Tui.git`（`origin` → `main`）

### macOS 端：拉取远端新提交并合并

```bash
cd ~/app/Tianshu

# 1. 拉取远端（Windows 可能已推送了新提交）
git fetch origin
git log main..origin/main --oneline   # 预览远端多了什么

# 2. 合并（通常无冲突，因为两边的改动分属不同目录）
git merge origin/main

# 3. 如果有冲突，解决后继续
# git add <冲突文件> && git commit

# 4. 推送合并结果
git push origin main
```

### 合并后：反向同步到开发仓库

开源仓库拉到的 Windows 端改动（如 desktop 构建脚本修复），需要同步回开发仓库。从开源仓库 `desktop/` 和 `.github/` 目录手动拷贝回开发仓库对应位置，然后在开发仓库提交：

```bash
cd /Users/banxia/app/deepseek-tui/opencode-tui

# 示例：反向同步 desktop 构建脚本
cp ~/app/Tianshu/desktop/scripts/build-mac.sh desktop/scripts/
cp ~/app/Tianshu/desktop/scripts/fetch-node-runtime.js desktop/scripts/
# ... 其他有变更的文件

git add -A
git commit -m "sync: 从开源仓库反向同步 desktop 构建脚本更新"
```

> **注意**：反向同步是手动操作，只拷贝真正有变更的文件。不要跑 `sync-to-public.sh` 的逆向，那会把开源仓库的测试排除、目录裁剪等策略反向应用到开发仓库，造成文件丢失。

### 权限问题（macOS）

如果 `git fetch`、`git push` 或 `rsync` 报 `Operation not permitted`，说明终端没有被授予「完全磁盘访问权限」：

**系统设置 → 隐私与安全性 → 完全磁盘访问权限** → 把终端（Terminal.app / iTerm）加进去并开启。授权后重新执行命令即可。
