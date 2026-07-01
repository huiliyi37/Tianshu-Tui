# 调试模式：Windows cmd.exe 的 `chcp 65001 > nul` 前缀导致命令静默失败（严重）

> 修复 commit `fae77cbc`。严重级：在**沙箱 / WSL / 受限 Windows 环境**下，凡走 `cmd.exe` 分支的命令（bash 工具 + 后台 job）全部静默失效——用户宣传/试用阶段的高频阻塞点。

## 现象特征

- Windows 用户报告「天枢跑什么命令都没输出」「bash 工具用不了」
- 表面：命令返回但 stdout 为空；有时 `exit=1`，有时被后续逻辑掩盖成欺骗性 `exit=0`
- 只在没装 Git Bash、fallback 到 `cmd.exe` 的机器上出现（沙箱、WSL 里的 Windows、精简系统）
- 装了 Git Bash 的机器不复现（走 `kind: 'bash'` 分支，不加 chcp）→ 容易漏测

## 根因

`src/tools/bash.ts` 和 `src/tools/job-store.ts` 的 `cmd` 分支给命令注入了前缀：

```
commandToRun = `chcp 65001 > nul && ${command}`
```

意图是把 cmd 控制台代码页切到 UTF-8（65001）以正确显示中文。问题出在 `> nul`：

- `nul` 是 Windows 的空设备，但在**沙箱 / WSL / 受限环境**下，把 `nul` 作为**重定向目标**不可访问；
- `cmd.exe /c "chcp 65001 > nul && echo hello"` → 前半段重定向失败，`chcp` 返回非 0；
- `&&` 短路 → 真正的命令 `echo hello` 根本不执行；
- 净效果：`exit=1` + 空 stdout，后续所有命令连锁静默失败。

## 修复

移除前缀，命令直接传给 cmd —— 因为编码问题**早已被 `WinStreamDecoder` 兜住**，chcp 本就冗余：

```
// 修复前
commandToRun = `chcp 65001 > nul && ${command}`
// 修复后
commandToRun = command
```

`src/platform.ts::WinStreamDecoder` 在**首个数据块**用 `isUtf8Buffer(chunk)` 探测编码，命中就 `utf-8`、否则 `gbk` 解码。即无论 cmd 输出是 UTF-8 还是 GBK 都能正确解码，不依赖 `chcp` 预先切页。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/tools/bash.ts` | cmd 分支移除 `chcp 65001 > nul &&` 前缀，命令直接执行 |
| `src/tools/job-store.ts` | 同步移除相同前缀（后台 job 走同一坑） |
| `src/platform.ts` | 更新 `ShellCommand.kind` 注释：cmd 走 WinStreamDecoder 自动探测，非 chcp |

## 验证

7 项实测全部 `exit=0` 且 stdout 正确：`echo hello`、`dir /b`、`whoami`、`python --version`、`node --version`、`git --version`、链式命令。`npm run typecheck` + bash/job-store/updater 相关测试绿。

## 教训（可复用）

- **别用 `> nul` 丢弃输出当作无害操作**：`nul` 作为重定向目标在受限环境不可写，会让整条 `&&` 链断在起点。要静默 chcp，用 `chcp 65001 >nul 2>&1` 也救不了根本——干脆别 chcp，让解码层兜。
- **编码问题优先在解码层解决，不要在命令层塞控制台副作用**：`chcp` 是全局控制台状态副作用，脆弱且平台相关；`WinStreamDecoder` 的按块自动探测是纯读取侧、无副作用、跨环境稳。
- **Git-Bash-first 会掩盖 cmd 分支的 bug**：本仓库 Windows 优先 Git Bash，开发机大多装了 Git Bash → cmd 分支长期缺真实覆盖。改 Windows shell 逻辑时，必须专门在**只有 cmd** 的环境验证。
- 参考：对齐了外部 Windows 实测可用的参考包；同一主题的 shell 指引设计见 `docs/Windows命令行兼容-指引随真实shell走.md`。
