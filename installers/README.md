# 天枢一键安装 (Tianshu One-Click Installer)

解决「天枢桌面版打不开 / 无窗口」问题的**一键包装安装器**：
自动检查并安装 / 更新 **WebView2 Runtime**，然后自动运行天枢安装包完成安装。
用户只需双击运行一次。

## 使用方法

1. 把天枢安装包（`Tianshu_3.6.0_x64-setup.exe`）放到**本文件夹**，或放到 `C:\Users\<你的用户名>\Downloads\`（脚本会自动查找）
2. 双击 **`安装天枢.cmd`**
3. 弹出 UAC 提示时点「是」（需要管理员权限安装 WebView2）
4. 脚本自动执行：
   - **步骤 1**：检查 WebView2 Runtime 是否已安装、版本是否满足
   - **步骤 2**：缺失或过旧 → 用官方引导器静默安装 / 更新到最新常青版（已就绪则跳过）
   - **步骤 3**：启动天枢安装包，在弹出的安装向导中完成安装
5. 看到「全部完成」即结束

## 常见问题

**Q: 提示未找到天枢安装包?**
把安装包复制到本文件夹即可（脚本会优先找本文件夹，其次 Downloads）。

**Q: 天枢已经装了，只是打不开/无窗口?**
本工具定位是「安装时确保 WebView2 就绪」。若天枢已装但打不开，请使用桌面「天枢修复工具」文件夹里的修复脚本，或手动到微软官方页安装 WebView2 常青版。

**Q: WebView2 安装失败?**
脚本会给出返回码并提示。可手动访问 https://developer.microsoft.com/microsoft-edge/webview2/ 下载 Evergreen 常青版安装后重试。

**Q: 装完提示需要重启?**
安装包返回码 3010 表示安装成功但系统需重启生效，重启后再打开天枢即可。

## 高级用法（可选）

直接以管理员运行 PowerShell：

```powershell
# 只检查并报告，不安装任何东西（验证用）
.\install-tianshu.ps1 -DryRun

# 即使 WebView2 已装且够新，也强制更新到最新
.\install-tianshu.ps1 -ForceUpdate

# 指定最低可接受版本（低于它才更新）
.\install-tianshu.ps1 -MinVersion 100.0.0.0

# 手动指定安装包 / 引导器路径
.\install-tianshu.ps1 -SetupExe "D:\setup.exe" -WebView2Bootstrap "D:\MicrosoftEdgeWebView2Setup.exe"
```

## 文件清单

- **安装天枢.cmd** —— 双击入口（自动请求管理员权限，调用下方脚本）
- **install-tianshu.ps1** —— 核心逻辑（检查 → 安装/更新 WebView2 → 运行安装包）
- **MicrosoftEdgeWebView2Setup.exe** —— 微软官方 WebView2 引导器（如删除，脚本会自动从官方下载）

## 说明

- WebView2 安装到系统级位置需要管理员权限，因此入口脚本会自动请求 UAC 提权。
- 检查依据：注册表 `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv` 值（WebView2 Runtime 版本）。
- 引导器是微软官方 Evergreen 版，运行 `/silent /install` 会把 WebView2 装到 / 更新到最新稳定版。
