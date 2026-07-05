# Design: `/permission` Slash Command for 天枢

> 参考 Kimi Code / Claude Code / Pi 的 permission 命令形态，为天枢设计一个运行时权限管理命令。
> 状态：设计稿 · 待评审 · 未实现

---

## 1. 参考系：Kimi Code / 同类 CLI 的 permission 命令

| 产品 | 命令形态 | 核心能力 |
|---|---|---|
| **Kimi Code** | `/permission` | 查看当前权限模式；切换 `yolo` / `auto` / `confirm`；管理 `allow` / `deny` 规则 |
| **Claude Code** | `/permissions` | 查看 active allow/deny rules；通过 `permissions.allow` / `permissions.deny` 配置白名单/黑名单 |
| **Pi (`pi-permissions`)** | 无内置命令，靠 `.pi/permissions.json` | `Tool(pattern)` 格式，`deny` 优先于 `allow`，支持 glob |

共同模式：

1. **模式切换**：全局策略（yolo / auto / confirm / manual）。
2. **规则覆盖**：按 tool + glob pattern 临时允许或禁止某类调用。
3. **即时生效**：改的是运行时配置，不需要重启会话。
4. **拒绝优先**：deny 规则永远赢过 allow。

---

## 2. 天枢现状

当前权限控制分散在三处：

| 位置 | 能力 | 不足 |
|---|---|---|
| `agent.config.approvalMode` | `auto-accept` / `auto-safe` / `suggest` / `manual` / `dangerously-skip-permissions` | 只能全局切换，没有 `/permission` 命令入口 |
| `/auto` slash 命令 | 在 `auto-safe` ↔ `manual` 之间切换 | 只覆盖两种模式，语义窄 |
| `config.permissions.allow` + `permissions.bash.allowlist` | tool 级白名单、bash 前缀白名单 | 无 deny 规则；无运行时增删接口 |
| `tool-pipeline.ts` | 综合 approval mode + allowlist + risk + sandbox 判断是否弹 approval | deny 规则未接入 |

---

## 3. 设计目标

1. 提供统一的 `/permission` 入口，替代并增强现有的 `/auto`。
2. 支持运行时查看、切换 approval mode。
3. 支持运行时添加/删除 `allow` / `deny` / `bash allowlist` 规则。
4. `deny` 规则优先级最高，可阻断任何 tool call。
5. 提供 `/permission test` 干跑验证规则匹配。
6. 不改动持久化配置文件格式时即可工作；可选支持写回 `.rivet-config.json`。

---

## 4. `/permission` 命令语法

```text
/permission                          # 查看当前模式 + 所有规则
/permission mode <mode>              # 切换 approval mode
/permission allow <tool> [k=v] ...   # 添加 allow 规则
/permission deny <tool> [k=v] ...    # 添加 deny 规则
/permission bash allow <prefix>      # 添加 bash 前缀白名单
/permission bash deny <prefix>       # 添加 bash 前缀黑名单（可选增强）
/permission remove allow|deny|bash <index_or_pattern>   # 删除规则
/permission reset                    # 清空本次会话所有运行时权限覆盖
/permission test <tool> <json>       # 干跑：当前规则下该调用会被怎么处理
```

### 4.1 示例

```text
/permission mode manual              # 切到全人工确认
/permission allow bash command="git status*"
/permission deny bash command="rm -rf *"
/permission allow write_file file_path="docs/*"
/permission bash allow npm run
/permission remove bash "npm run"
/permission test bash {"command":"git status --short"}
```

---

## 5. 数据模型扩展

### 5.1 配置层（`src/config/schema.ts`）

在 `permissionsSchema` 中增加 `deny`：

```ts
export const permissionsSchema = z.object({
  allow: z.array(permissionAllowRuleSchema).default([]),
  deny: z.array(permissionAllowRuleSchema).default([]),   // 新增
  bash: z.object({
    allowlist: z.array(z.string().min(1)).default([]),
    denylist: z.array(z.string().min(1)).default([]),      // 可选
  }).default({}),
}).default({})
```

`permissionAllowRuleSchema` 已支持 `tool` + `params` 的 glob 匹配，可直接复用。

### 5.2 运行时 overlay

新增 `src/agent/permissions-overlay.ts`：

```ts
export interface PermissionOverlay {
  allow: PermissionAllowRule[]
  deny: PermissionAllowRule[]
  bashAllow: string[]
  bashDeny: string[]
}

export function createPermissionOverlay(): PermissionOverlay {
  return { allow: [], deny: [], bashAllow: [], bashDeny: [] }
}
```

该 overlay 挂在 `AgentLoop.config.permissionsOverlay`（或 session 级 store），仅本次会话有效，不污染磁盘配置。

---

## 6. 与 tool-pipeline 的集成

在 `src/agent/tool-pipeline.ts` 的 `shouldAsk` 计算前加入 deny 检查：

```ts
// 1. 先检查 deny（最高优先级）
const deniedByConfig = isToolAllowed(tu.name, tu.input, deps.config.permissions?.deny)
const deniedByOverlay = isToolAllowed(tu.name, tu.input, deps.config.permissionsOverlay?.deny)
const bashDenied = tu.name === 'bash' && isBashCommandDenied(tu.input.command, ...)

if (deniedByConfig || deniedByOverlay || bashDenied) {
  const reason = `Permission denied: ${tu.name} matches a deny rule`
  callbacks.onToolResult(tu.id, tu.name, reason, true)
  return { toolResult: { type: 'tool_result', tool_use_id: tu.id, content: reason, is_error: true }, ... }
}

// 2. 再检查 allow / approval mode（现有逻辑）
const allowlisted = isToolAllowed(tu.name, tu.input, [
  ...(deps.config.permissions?.allow ?? []),
  ...(deps.config.permissionsOverlay?.allow ?? []),
])
const bashAllowlisted = ...
```

这样：

- `deny` 直接阻断并返回错误给模型。
- `allow` 仍用于跳过 approval。
- overlay 与配置文件合并，overlay 优先级相同（都是 allow 则任一命中即可）。

---

## 7. UI 输出示例

```text
/permission

当前模式: auto-safe（中风险以上弹 approval，低风险自动过）

Allow 规则（运行时 + 配置）：
  [config]  bash  command="git status*"
  [session] write_file  file_path="docs/*"

Deny 规则：
  [session] bash  command="rm -rf *"

Bash 前缀白名单：
  [config]  git, npm

说明：
  - deny 规则优先于 allow 和 approval mode。
  - 在 dangerously-skip-permissions 模式下 deny 仍然生效（fail-closed）。
```

---

## 8. 持久化策略

| 操作 | 默认行为 | 可选增强 |
|---|---|---|
| `/permission mode ...` | 仅改当前 session 的 `AgentLoop.config.approvalMode` | 加 `--save` 写回 `.rivet-config.json` |
| `/permission allow/deny ...` | 仅写入运行时 overlay | 加 `--save` 写回 `.rivet-config.json` |
| `/permission bash allow/deny ...` | 仅写入运行时 overlay | 加 `--save` 写回 `.rivet-config.json` |
| `/permission reset` | 清空 overlay | 不影响磁盘配置 |

建议第一阶段只做运行时覆盖，避免写配置文件的复杂度。

---

## 9. 实现步骤（如需落地）

### Phase 1: 模型扩展（0.5 天）

1. `src/config/schema.ts`：`permissionsSchema` 增加 `deny`、`bash.denylist`。
2. `src/agent/permissions.ts`：增加 `isToolDenied` / `isBashCommandDenied`。
3. `src/agent/permissions-overlay.ts`：新建运行时 overlay 类型。

### Phase 2: Tool-pipeline 接入 deny（0.5 天）

1. `src/agent/tool-pipeline.ts`：在 `shouldAsk` 前插入 deny 拦截。
2. `src/agent/loop.ts`：给 `AgentConfig` 挂载 `permissionsOverlay`，提供 `setPermissionOverlay` / `addAllowRule` / `addDenyRule` 等方法。

### Phase 3: `/permission` Slash 命令（1 天）

1. `src/tui/slash-commands.ts`：新增 `/permission` 命令解析与 handler。
2. 接入 `ctx.agent.setApprovalMode`、`ctx.agent.addAllowRule` 等运行时 API。
3. 输出格式化：模式、规则列表、test 结果。

### Phase 4: 测试（0.5 天）

1. `src/agent/__tests__/permissions.test.ts`：补充 deny 规则匹配测试。
2. `src/tools/__tests__/tool-pipeline-deny.test.ts`：验证 deny 规则直接阻断 tool call。
3. `src/tui/__tests__/slash-commands.test.ts`：验证 `/permission` 解析与输出。

### Phase 5: 回归（0.5 天）

- `npm run typecheck`
- 跑相关测试 + 手动验证 `/permission mode manual` / `/permission allow bash ...`

---

## 10. 与现有 `/auto` 的关系

- `/auto` 保留作为快捷方式，但内部改为调用 `/permission mode auto-safe` / `/permission mode manual`。
- 文档和 `/help` 中引导用户使用 `/permission` 做更细粒度控制。

---

## 11. 验收标准

- [ ] `/permission` 能显示当前 mode、allow/deny/bash 规则。
- [ ] `/permission mode <mode>` 即时生效。
- [ ] `/permission allow/deny <tool> <pattern>` 运行时生效，且 deny 优先。
- [ ] `/permission test` 能返回 `allow / deny / ask` 三种结果之一。
- [ ] deny 规则在 `dangerously-skip-permissions` 模式下仍然生效。
- [ ] 现有 `/auto` 行为不变。
- [ ] typecheck 无新增错误，新增测试全绿。

---

## 12. 风险与预案

| 风险 | 预案 |
|---|---|
| deny 规则误伤正常调用 | 提供 `/permission test` 让用户验证；deny 默认只在 session overlay，关闭即失效 |
| overlay 与 config 合并逻辑出错 | 保持 allow/deny 检查复用同一 `isToolAllowed`，只改规则来源 |
| `/auto` 与 `/permission mode` 状态不一致 | `/auto` 内部统一走 `/permission` 的 mode API |
| 模型看到 deny 错误后疯狂重试等价工具 | tool-pipeline 已记录 fingerprint，doom-loop 检测会限制重复 |

---

## 13. 关联代码

| 文件 | 说明 |
|---|---|
| `src/config/schema.ts` | `permissionsSchema`、`permissionAllowRuleSchema` |
| `src/agent/permissions.ts` | `isToolAllowed`、`isBashCommandAllowlisted` |
| `src/agent/tool-pipeline.ts` | approval 判断核心 |
| `src/agent/loop.ts` | `setApprovalMode` |
| `src/tui/slash-commands.ts` | slash 命令注册 |
| `src/tui/__tests__/slash-commands.test.ts` | slash 命令测试 |
