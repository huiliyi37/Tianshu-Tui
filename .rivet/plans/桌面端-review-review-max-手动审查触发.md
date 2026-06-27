# 桌面端 /review /review max 手动审查触发

# 桌面端 /review /review max 手动审查触发

## 问题

桌面端 agent 用 `git commit` 直接提交，绕过了 `deliver_task` 的审查门禁（L2/L3）。当前桌面端没有 `/review` 入口——用户无法手动触发审查。

用户的决策：审查从自动门禁变为**用户手动触发**。桌面端 agent 保持自由提交能力，用户在需要时通过 `/review` 或 `/review max` 触发审查。

## 方案

在桌面端 `ThreadView.tsx` 的 `commands` 数组中添加 `/review` 和 `/review max` 两个命令。命令通过 `onSend` 发送 prompt 给 agent，agent 调用 `deliver_task` 执行审查。prompt 模板复用 TUI `slash-commands.ts` 中已验证的文本。

### 改动范围（2 文件）

**1. `desktop/src/surfaces/ThreadView.tsx`**

在 `commands` useMemo 数组中添加两条命令：

```typescript
{
  name: '/review',
  desc: 'L2 审查 · 对手变更',
  run: () => onSend('Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="L2". This triggers L2 adversarial verifier.'),
},
{
  name: '/review max',
  desc: 'L3 审查 · 编队 5 审查员',
  run: () => onSend('Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="L3". This triggers L3 Review Squadron (5 inspectors).'),
},
```

**2. `desktop/src/lib/__tests__/composer-commands.test.ts`**

补测试：`/review` 和 `/review max` 能被 `filterCommands` 正确匹配。

### 为什么安全

- 纯 UI 层新增——不改 agent loop、不改 server 路由、不改 deliver_task 工具
- prompt 文本是 TUI 已验证的模板（`slash-commands.ts:243-250`），只是搬运
- `/review max` 含空格——`detectSlash` 在遇到空格时返回 null（`composer-commands.ts:38`），所以 `/review max` 不会触发 slash 补全冲突，它会作为完整的 PlusMenu 命令项执行
- 审查结果通过 agent 流式输出正常展示，不需要新 UI 组件

### 认知影响

无。这不改变 agent 的行为约束或提示词。`/review` 命令发送的 prompt 指示 agent 调用已有的 `deliver_task` 工具——agent 已知道如何执行审查。

## 验证

- `npx tsc --noEmit` 通过
- `composer-commands.test.ts` 新增测试通过
- 手动路径：打开 PlusMenu → 看到 `/review` 和 `/review max` → 点击 → agent 开始审查

## 风险

低。纯前端 UI 层新增两个命令项，无后端改动。
