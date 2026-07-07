# Security Policy · 安全策略

## 报告漏洞 · Reporting a Vulnerability

请**不要**通过公开 issue 报告安全漏洞。
Please do **not** report security vulnerabilities through public issues.

优先使用 GitHub 私密漏洞报告(仓库 Security 标签页 → Report a vulnerability),我们会在 72 小时内响应。
Use GitHub's private vulnerability reporting (Security tab → Report a vulnerability). We aim to respond within 72 hours.

## 受支持版本 · Supported Versions

只有最新的 minor 版本接收安全修复(npm `tianshu-tui@latest` 与桌面端最新 Release)。
Only the latest minor release receives security fixes (npm `tianshu-tui@latest` and the latest desktop release).

## 安全模型要点 · Security Model

天枢作为本地运行的编码 agent,内置以下防线(详见 [沙箱与权限](docs/user-guide-sandbox-permissions.md)):

- **路径边界**:所有文件工具经 `validatePath` 强制项目目录边界,拒绝 `..` 穿越与符号链接逃逸;插件工具的路径参数同样经过 `validatePathSafe` 校验。
- **敏感文件拒绝**:`.env`、`credentials.*`、`*key*`、`*token*` 等禁止读取与提交。
- **破坏性命令门禁**:`rm -rf`、force push、`DROP/TRUNCATE` 等需显式确认;三档权限模式(Manual / Auto / YOLO)统一管理。
- **插件安全**:插件安装强制 `npm install --ignore-scripts`(禁止 postinstall 任意代码);manifest entry 路径禁止逃逸插件目录;插件工具不得静默覆盖内置工具;安装前展示权限声明。
- **网络防护**:web 工具逐跳 DNS 解析 + 私有 IP 拦截(SSRF 防护),作用于每次重定向。

以上任一防线的绕过都属于有效漏洞,欢迎报告。
A bypass of any of the above is a valid vulnerability — reports welcome.
