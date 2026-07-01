# Windows 命令行兼容:指引随真实 shell 走

## 一句话

Windows 下给模型的「该用什么命令行语法」的指引,**跟随真实解析出的 shell**(Git Bash / PowerShell / cmd),而不是一律假设 PowerShell。对齐 Claude Code 的真实做法:检测到哪个 shell,就让模型用那个 shell 的语法,**不做翻译**。

## 背景:Claude Code 实际怎么做的(纠正常见误解)

社区常说「Claude Code 做了 Windows/bash 兼容」,容易误读成「让 PowerShell 模仿 bash」。真相相反——他们在 v2.1.84 ~ v2.1.126 期间:

- **抛弃了 Git-Bash 翻译垫片**(那个把 `C:\Users` 翻成 `/c/Users` 的 MSYS 中间层,是路径/编码错误的根源);
- 加了**原生 PowerShell 工具**,直接起 `pwsh.exe`/`powershell.exe`,不翻译、不垫片(v2.1.84);
- Git Bash 变成**可选**,没装就用 PowerShell(v2.1.120);
- PowerShell 提升为**主 shell**(v2.1.126);
- 配套做了 **PowerShell 专属的解析加固**(如 `git diff -- file` 的裸 `--` 不再被误判成 `--%` 停止解析符;PS 5.1 下带引号+空格的参数改成弹确认而非自动放行)。

核心思路:**检测到哪个 shell,就告诉模型用哪个 shell 的语法,绝不翻译。**

## 我们之前的问题

架构本来就对齐:`src/platform.ts` 的 `resolveShellCommand` 早就是「Windows 优先 Git Bash → 没有就 PowerShell(直接 spawn)→ 再 cmd」,并用 `kind: 'bash' | 'powershell' | 'cmd' | 'sh'` 标注 shell 族。

但提示词有个**反向 bug**:`src/prompt/volatile.ts` 里那段 shell 指引,只要 `process.platform === 'win32'` 就**无条件**告诉模型「shell 是 PowerShell/cmd」。可一旦装了 Git Bash(我们的首选),实际跑的是 bash,这时给模型的是反的指引,诱导它发错语法。

## 设计与改动

### 1. 指引跟随 `getShellCommand().kind`

`src/prompt/volatile.ts` 新增导出纯函数 `windowsShellNote(kind)`,按 shell 族产出不同指引:

| kind | 注入内容要点 |
|------|-------------|
| `bash` | Git Bash(POSIX):`ls`/`cat`/`grep`/`&&`/管道/`2>/dev/null` 可用;Windows 宿主,路径用正斜杠或加引号;Python 可能是 `python`/`py`。 |
| `powershell` | PS 语法速查:环境变量 `$env:NAME`;丢弃错误 `2>$null`;PS 5.1 无 `&&`(用 `;` 或判 `$LASTEXITCODE`);`Remove-Item -Recurse -Force`;`Test-Path`;`is not recognized as cmdlet` = 换工具勿重试。 |
| `cmd` | `dir`/`type`/`%VAR%`;`ls`/`cat` 不存在;现代 cmd 支持 `&&`;丢弃 `2>nul`。 |
| `sh`(Unix) | 不注入。 |

`getShellCommand()` 进程内缓存、会话内固定 → 注入仍是 session-static,**前缀缓存安全**(留在 frozen 段)。

### 2. PowerShell 命令规范化加固

`src/platform.ts` 新增 `rewritePowershellNullRedirect()`:把模型(偏 bash/cmd 习惯)在 PowerShell 下误写的 `2>nul`、`2>/dev/null` 归一成 `2>$null`,避免默默生成名为 `null` 的垃圾文件。仅服务 `kind: 'powershell'` 路径,在 `src/tools/bash.ts` 的 powershell 分支调用。

**范围克制**:只做重定向归一这类安全改写,**不做 bash→PowerShell 整体翻译**——那正是 Claude Code 试过后抛弃的脆弱方案。

### 3. 可选:强制 PowerShell 开关

环境变量 `RIVET_USE_POWERSHELL=1`(对齐 `CLAUDE_CODE_USE_POWERSHELL_TOOL`):即使探测到 Git Bash 也跳过、直接用 PowerShell。**默认不变**,仍优先 Git Bash——因为我们的模型(DeepSeek/Codex)偏 bash,Git-Bash-first 最稳;此开关给想用原生 cmdlet 的进阶用户。

## 为什么不把 PowerShell 提为默认主 shell

Claude Code v2.1.126 把 PS 提为主 shell,是因为 Claude 模型对 PS 语法足够熟。我们的模型更熟 bash,默认走 Git Bash(有则用)兼容性更好、命令失败率更低。所以我们走「hybrid」:有 Git Bash 用 bash,没有才原生 PowerShell,并在 PowerShell 下把指引和加固补齐。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/prompt/volatile.ts` | 新增 `windowsShellNote(kind)`;注入改为按 `getShellCommand().kind` 选择 |
| `src/platform.ts` | 新增 `rewritePowershellNullRedirect()`;`resolveShellCommand` 加 `RIVET_USE_POWERSHELL` 开关 |
| `src/tools/bash.ts` | powershell 分支调用 `rewritePowershellNullRedirect` |
| `src/__tests__/platform-shell.test.ts` | 强制 PS 开关 + 重定向归一测试 |
| `src/prompt/__tests__/volatile.test.ts` | `windowsShellNote` 三态指引 + 注入与纯函数一致性测试 |

## 验证

`npm run typecheck` + 跑 `src/__tests__/platform-shell.test.ts`、`src/prompt/__tests__/volatile.test.ts`、`src/tools/__tests__/bash.test.ts`。

## 相关：cmd 分支的 `chcp 65001 > nul` 严重坑（已修复 `fae77cbc`）

cmd 分支曾注入 `chcp 65001 > nul && <cmd>` 想切 UTF-8 代码页，但 `> nul` 在沙箱/WSL/受限 Windows 下重定向失败 → `&&` 短路 → 命令根本不执行（空 stdout / exit=1），凡 fallback 到 cmd 的机器全线静默失败。已移除该前缀，改由 `WinStreamDecoder` 首块自动探测 GBK/UTF-8。详见 `.rivet/knowledge/debug-windows-cmd-chcp-nul.md`。
