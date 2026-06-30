# 天枢沙箱与权限模型

天枢的权限设计遵循**默认最小权限 + 按操作动态授权**的原则。它通过两层机制保护你的工作区与系统：

1. **内核级命令沙箱** —— 限制 shell 命令的文件系统写范围
2. **工具级审批与路径校验** —— 控制哪些工具、哪些路径、哪些命令可以执行

本文档说明这两层机制的具体限制、配置方式与故障排查。

---

## 1. 内核级命令沙箱

天枢在运行 shell 命令时，会尝试把它包在一个内核级文件系统沙箱里。沙箱的核心目标是：**命令可以读得很宽，但写只能落在工作区 + 临时目录 + 工具缓存里**。

### 1.1 平台后端

| 平台 | 后端 | 是否需要额外安装 |
|------|------|------------------|
| macOS | `sandbox-exec`（Seatbelt） | 系统自带 |
| Linux | `bubblewrap`（优先）/ `firejail` | 建议安装 `bubblewrap` |
| WSL | 复用 Linux 后端 | 建议在 WSL 内安装 `bubblewrap` |
| 原生 Windows | 无轻量级内核 FS 沙箱 | 无需安装，但保护较弱 |

启动时，如果当前平台没有可用后端，天枢会在 stderr 打印警告，例如：

```
[sandbox] 无可用沙箱后端：当前无写边界。Linux 装 bubblewrap，Windows 走 WSL。
```

### 1.2 默认可写范围

沙箱允许写入以下目录：

- 当前工作目录（`cwd`，即你启动天枢的目录）
- 系统临时目录：`/tmp`、`/private/tmp`、`/var/folders`（macOS）
- 常见工具缓存：
  - `~/.npm`、`~/.cache`、`.pnpm-store`、`.yarn`、`.npm-cache`
  - `~/.cargo`、`go`、`~/.rustup`
  - `~/.bun`、`~/.deno`
  - `~/.gradle`、`~/.m2`
  - `~/Library/Caches`（macOS）
- 用户通过审批流程**显式授予**的目录（见第 2 节）

### 1.3 扩展可写目录

如果某些命令必须写到工作区外（例如自定义构建目录、全局依赖位置），可以通过环境变量追加：

```bash
export RIVET_SANDBOX_WRITABLE="/opt/my-build:/var/log/my-project"
rivet
```

多个路径用 `:` 分隔（POSIX）。

### 1.4 关闭沙箱

```bash
RIVET_NO_SANDBOX=1 rivet
```

关闭后启动会明确警告：无写边界，回滚是唯一安全网。**不建议在陌生仓库或不可信输入下关闭**。

---

## 2. 路径边界与外出授权

除了内核沙箱，所有文件工具（`read_file`、`write_file`、`edit_file`、`glob`、`grep`、`diff` 等）还会经过 `validatePathSafe` 校验。

### 2.1 默认边界

- **默认只能访问项目目录内**的文件
- 使用 `..`、绝对路径指向项目外的路径会被拒绝
- 对路径进行 `realpathSync` 规范化，防止通过符号链接逃逸

### 2.2 外出授权

当 agent 确实需要访问项目外目录时，会弹审批请求。批准后，天枢会记录一个**目录子树授权**：

- `read` 授权：允许读取该目录及其子目录
- `write` 授权：允许读写该目录及其子目录

授权默认仅在**当前会话**生效。如果勾选“记住此授权”，会按工作区持久化到：

```
~/.rivet/path-grants-<slug>.json
```

这个文件按工作区隔离，**不会泄漏到其它项目**。

### 2.3 在 dangerously-skip-permissions 下

如果你启用了 `dangerously-skip-permissions`（见第 3.1 节），天枢会**自动记录**外出路径授权，不再弹窗。这等价于你一次性授权了所有当前需要的目录，但路径校验本身仍在执行。

---

## 3. 审批模式与规则

天枢的审批配置位于 `~/.rivet/config.json` 或项目 `.rivet-config.json` 的 `agent.approval` 字段。

### 3.1 审批模式

| 模式 | 行为 |
|------|------|
| `auto-safe`（默认） | 低风险/无风险工具自动执行；高风险命令弹审批 |
| `manual` | 任何需要审批的工具都弹窗确认 |
| `suggest` | 只给出建议，不阻塞执行 |
| `auto-accept` | 自动批准常规审批请求 |
| `dangerously-skip-permissions` | 跳过所有交互式审批弹窗 |

切换方式：

```bash
# 临时（当前进程）
rivet --dangerously-skip-permissions

# 持久
rivet config set-approval dangerously-skip-permissions

# 恢复默认
rivet config set-approval auto-safe
```

更多细节见 [`docs/dangerously-skip-permissions.md`](dangerously-skip-permissions.md)。

### 3.2 规则优先级

当一条工具调用到达审批 gate 时，判断顺序如下：

1. **`deny` 规则** —— 永远优先，即使 `dangerously-skip-permissions` 也阻断
2. **`bash.denylist` 前缀** —— 按命令前缀永远禁止
3. **`allow` 规则 / `bash.allowlist` 前缀** —— 命中则跳过审批
4. **审批模式 + 风险评级** —— 决定是否弹窗

### 3.3 规则配置示例

```json
{
  "permissions": {
    "allow": [
      { "tool": "bash", "params": { "command": "git status*" } },
      { "tool": "write_file", "params": { "file_path": "docs/*" } }
    ],
    "deny": [
      { "tool": "bash", "params": { "command": "rm -rf *" } }
    ],
    "bash": {
      "allowlist": ["git status", "npm run"],
      "denylist": ["rm -rf", "sudo"]
    }
  }
}
```

> 配置优先级：运行时 CLI 参数 > 项目 `.rivet-config.json` > 用户 `~/.rivet/config.json` > 内置默认值。

### 3.4 bash 写审批的特殊逻辑

当真实内核沙箱**已激活**时，工作区内的 bash 写操作被视为“沙箱 + 回滚”安全，通常不需要再弹审批。只有当：

- 沙箱未激活（原生 Windows、未装 bwrap 的 Linux/WSL、或 `RIVET_NO_SANDBOX=1`）
- 命令不在 allowlist
- 且命令具有写副作用

才会触发 bash 写审批。

---

## 4. 风险评级

每个工具调用都会经过风险评级：`none | low | medium | high`。

### 4.1 强制 high 风险（会弹审批）

以下命令模式会被判定为高风险：

- `rm -rf` / `rm -fr`
- `git reset --hard`
- `git clean -f`
- `git push --force` / `--force-with-lease`
- `drop table`
- `pkill -9/-KILL/-f`
- `sudo + rm/chmod/chown/dd/mkfs/mount/umount/systemctl/shutdown/reboot/passwd/useradd...`
- `chmod 777` 等全开权限
- `wget/curl ... | sh/bash`
- `shutdown/reboot/halt/poweroff`
- `npm publish/unpublish`
- doom-loop 保护期间的破坏性 git 操作
- 目标路径是绝对路径或包含 `..` 的项目外路径

### 4.2 medium 风险

- 访问项目外绝对路径
- 某些高权限但无直接破坏性的命令

### 4.3 auto-safe 下的自动通过条件

在 `auto-safe` 模式下，如果同时满足：

- sensorium 置信度足够高
- 风险等级为 `none` 或 `low`
- 不是 bash 写操作（或已被 allowlist/沙箱覆盖）

则可以自动批准，无需弹窗。

---

## 5. 其它硬性限制

| 限制 | 说明 |
|------|------|
| `maxTurns` | 默认 50 回合，防止无限循环 |
| SSRF 保护 | 逐跳 DNS + 私有 IP 拦截，作用于每次重定向 |
| 敏感文件拒绝 | `.env`、`credentials.*`、`*key*`、`*token*` 禁止读取/提交 |
| 符号链接环保护 | `realpath` + 访问集，防止循环软链接 |
| 文件级撤销 | 每次写/编辑前创建版本化备份 |
| Git 检查点 | 每回合首次修改前自动创建检查点，可回滚 |
| Worker 隔离 | 子 agent 在独立工作目录/上下文中运行，有工具白名单和超时 |
| 可靠性模式 | 当检测到反复失败/死循环时，会降级为更保守的执行策略 |

---

## 6. 常见场景与配置建议

### 6.1 我信任这个仓库，想减少弹窗

```bash
rivet config set-approval auto-accept
```

这仍会执行 deny 规则、路径校验、风险阻断，只是不弹确认窗。

### 6.2 我需要 agent 写项目外的某个目录

第一次访问该目录时，天枢会弹审批请求，选择“允许并记住”即可。也可以在启动前预授权：

```bash
export RIVET_SANDBOX_WRITABLE="/path/to/dir"
rivet
```

### 6.3 我在原生 Windows 上，想获得真正沙箱

原生 Windows 没有内核 FS 沙箱。建议：

- 在 WSL 中运行天枢（自动复用 Linux bwrap 边界）
- 或接受“回滚兜底”模式，并对高风险操作保持 `manual` 审批

### 6.4 某个命令总被误拦截

检查是否命中了 `DANGEROUS_BASH_PATTERNS`。如果命令确实安全且常用，可以加入 `bash.allowlist`：

```bash
rivet config set bash.allowlist "your-safe-prefix"
```

> 注意：`deny` 规则和 `bash.denylist` 优先级高于 allowlist，无法通过 allowlist 绕过。

---

## 7. 故障排查

### 沙箱看起来没生效

1. 检查启动日志是否有 `[sandbox]` 警告
2. Linux/WSL 用户检查是否安装了 `bubblewrap`：
   ```bash
   which bwrap
   ```
3. macOS 用户检查 `sandbox-exec` 是否存在：
   ```bash
   which sandbox-exec
   ```

### 命令报 “Path outside project directory”

- 如果确实需要访问该路径，在弹窗中选择“允许并记住”
- 或使用 `RIVET_SANDBOX_WRITABLE` 预授权

### 弹窗太多

- 对信任仓库使用 `auto-accept` 模式
- 将常用安全命令加入 `bash.allowlist`
- 确保内核沙箱已激活（macOS/Linux/WSL），这样工作区内 bash 写操作不会反复弹窗

---

## 8. 总结

天枢的沙箱与权限模型可以概括为：

> **默认最小权限，显式动态授权，deny 规则永远优先。**

- 写文件：默认只能写项目目录
- 执行命令：默认受内核沙箱约束写范围
- 危险命令：无论模式如何，deny 规则和硬编码风险模式都会拦截
- 外出访问：必须经用户授权或显式配置
- 网络：通常放行（build/test/git 需要）

如果你需要更激进的无人值守执行，请逐步提高权限（`auto-safe` → `auto-accept` → `dangerously-skip-permissions`），而不是直接关闭沙箱。
