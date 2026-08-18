# 天枢 Tianshu — VS Code / Cursor 编程智能体

天枢是为 DeepSeek 前缀缓存深度优化的全功能编程智能体。本扩展把完整的天枢 agent 带进 VS Code 与 Cursor：侧栏座舱对话、编辑落地即出原生红绿 diff、bash 在可见终端执行、变更审查与一键回滚——一切智能在 `rivet` 内核（sidecar 进程），扩展只做呈现与落地，行为与 CLI 完全同源。

## 功能

- **座舱对话**：流式回复、思考折叠、工具执行卡、审批卡；运行中输入自动作为插话在下一工具边界注入
- **原生编辑审查**：agent 改文件的瞬间，编辑器内出红绿 diff 装饰 + CodeLens「接受 / 拒绝」；拒绝即恢复原文并告知 agent
- **可见终端**：agent 的 bash 命令在名为「天枢」的真实终端里跑，exitCode 与输出照常回传推理
- **行内编辑**：选中代码按 `Cmd/Ctrl+Shift+K`，输入指令，编辑经原生 diff 通路落地
- **变更审查**：TreeView 列出任务基线以来的全部文件变更，原生双栏 diff，双步确认回滚
- **@file 提及**：输入 `@` 补全工作区文件，或直接拖拽文件进输入框
- **会话连续**：会话数据存 `~/.rivet/`，与 CLI / 桌面端共享——插件里开的会话可在终端 `rivet` 里续跑，反之亦然

## 快速开始

1. 安装本扩展
2. 打开一个工作区，点击活动栏的天枢图标——首次使用会自动下载天枢运行时（约 60MB，sha256 校验）；已装 `rivet` CLI 或在设置 `tianshu.cliPath` 指定路径则直接复用
3. 配置模型：终端运行 `rivet config setup deepseek`（或其他提供商）
4. 开始对话

## 工作原理

```
VS Code / Cursor 扩展宿主
 ├─ sidecar 启动器 → spawn `rivet serve`（127.0.0.1 + 随机 Bearer token，每工作区一实例）
 ├─ 座舱 webview（React）── HTTP/SSE ──→ sidecar（天枢内核）
 └─ 委托执行器：apply_edit → WorkspaceEdit + 红绿 diff；terminal_exec → 可见终端
```

- 扩展内不实现任何 agent 逻辑，智能全部在内核——防止行为分叉
- sidecar 只绑 127.0.0.1，Bearer token fail-closed
- Remote / WSL / SSH 场景下 sidecar 随扩展宿主跑在远端

## 设置项

| 设置 | 说明 |
|------|------|
| `tianshu.cliPath` | rivet CLI 可执行文件路径（留空自动探测 PATH） |
| `tianshu.serverPort` | sidecar 端口（0 = 自动选择空闲端口） |

## 数据目录

会话、知识库、缓存指标等存放在 `~/.rivet/`（Windows 为 `%LOCALAPPDATA%\.rivet`），与 CLI / 桌面端共享。

## 许可

Apache 2.0 · 源码见 [GitHub](https://github.com/huiliyi37/Tianshu-Tui)
