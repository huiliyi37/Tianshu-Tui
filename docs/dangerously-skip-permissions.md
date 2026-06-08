# Dangerously Skip Permissions（全授权审批跳过）

Rivet 支持类似 Claude Code `--dangerously-skip-permissions` 的全授权模式，用于开发者长期无人值守执行任务时跳过所有交互式审批提示。

## 模式总览

| 模式 | 配置值 | 行为 |
|---|---|---|
| 智能安全 | `auto-safe` | 默认推荐：低风险可自动通过，高风险仍询问；bash 写操作仍询问，除非 allowlist 命中。 |
| 手动 | `manual` | 按工具自身 `requiresApproval` 判断，需要时询问。 |
| 自动接受 | `auto-accept` | 跳过常规审批，但历史兼容语义下不保证显式覆盖所有硬安全分支。 |
| 全授权跳过 | `dangerously-skip-permissions` | 跳过审批 gate 的所有确认弹窗，包括高风险命令、bash 写操作、工具自身审批要求。 |

## 临时启用

```bash
rivet --dangerously-skip-permissions
```

等价别名：

```bash
rivet --dangerously-skip-approvals
```

也可以显式指定：

```bash
rivet --approval-mode dangerously-skip-permissions
```

这些 CLI 参数只影响当前进程，不写入配置文件。

## 持久启用

最容易给用户配置的方式：

```bash
rivet config set-approval dangerously-skip-permissions
```

恢复默认智能安全模式：

```bash
rivet config set-approval auto-safe
```

也可以手动编辑 `~/.rivet/config.json` 或项目 `.rivet-config.json`：

```json
{
  "agent": {
    "approval": "dangerously-skip-permissions"
  }
}
```

配置优先级仍是：运行时 CLI overlay > 项目 `.rivet-config.json` > 用户 `~/.rivet/config.json` > 内置默认值。

## 安全边界

`dangerously-skip-permissions` 只跳过交互式审批，不移除 Rivet 的其它安全结构：

- 工具自身的路径校验、参数校验仍执行。
- `deliver_task` 的 ownership / verification gate 仍在工具执行逻辑内生效。
- reliability degraded/minimal 模式的硬阻断仍在审批 gate 之前生效。
- checkpoint、file history、trace、evidence、risk telemetry 仍记录。
- bash 工具实现层已有的执行/超时/环境清理逻辑仍生效。

因此这个模式不是“禁用安全系统”，而是“开发者明确授权跳过人工确认”。它适合受信任仓库、受信任工作区、长任务无人值守开发；不建议在陌生代码仓库或不可信 prompt 输入下默认开启。
