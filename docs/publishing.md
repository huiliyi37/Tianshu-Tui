# 发布 Tianshu TUI 到 npm

## 前置条件

- npm 账号：`huiliyi37`
- Granular Access Token 已配置在 `~/.npmrc`（`npm_wi...`），勾了 **Bypass 2FA**，`npm publish` 不再需要输入验证码
- 不要把这个 token 发给任何人或提交到 git

## 发布步骤

```bash
# 1. 改版本号（package.json 里的 version）
#    确保比 npm 上当前版本高，否则 publish 会拒绝
npm version patch   # 2.9.0 → 2.9.1
# 或手动: npm version minor / npm version major

# 2. 构建
npm run build

# 3. 发布（token 已绕过 2FA，一键完成）
npm publish

# 4. 推送 tag 到 GitHub
git push origin main --tags
```

## 用户端更新

用户通过 `npm install -g tianshu-tui` 安装后，TUI 每次启动会异步检查 npm registry 是否有新版本（24h 缓存）。

有新版本时显示：
```
⬆️  Update available: 2.9.0 → 2.9.1. Run /update to upgrade.
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

## 注意事项

- `npm publish` 前确保 `npm run build` 已执行，否则用户装到的是旧 dist
- `prepublishOnly` 脚本会在 publish 前自动跑 build，但手动确认更安全
- 如果 token 过期或失效，去 https://www.npmjs.com/settings/huiliyi37/tokens 重新生成
- `package.json` 里的 `files` 字段控制了哪些文件会被打包发布，不要往里加敏感文件
