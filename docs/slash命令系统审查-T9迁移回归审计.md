# Slash 命令系统审查报告 — T9 UI 迁移后的回归审计

> 审查范围：T9 ANSI UI 切换 (4da99cf) → HEAD 的所有 slash 命令相关变更
> 审查日期：2026-06-12

---

## 一、变更清单

| Commit | 变更 | 影响文件 |
|--------|------|---------|
| `4da99cf` | T9 ANSI UI 切换为主入口 | `main.ts`, `slash-commands.ts` (+10/-0), `tsup.config.ts` |
| `938c71f` | 移除旧入口残留 | `main-ansi.ts` → 删除, `main.tsx` → 降级 |
| `781df1f` | 暴露 /review /plan /plan-mode 到命令面板 | `slash-commands.ts`, `command-palette.tsx` |
| `b291b54` | slash 命令列表支持 ↑↓ 选择 + Tab 补全 | `slash-commands.ts` (HELP_TEXT), T9 `app.ts` |
| `07163eb` | slash 命令列表按输入相关性排序 | T9 `format/slash-hint.ts` |

---

## 二、架构变更分析

### 旧架构 (React/Ink)

```
main.tsx → App.tsx → CommandPalette → handleSlashCommand (直接调用)
                                              ↓
                                    ctx.onModelSwitch → useMemo 重建 AgentLoop
```

### 新架构 (T9 ANSI)

```
main.ts → TuiApp → InputHandler → submitSlashCommand
                    ↓
              SlashRouter.route()
                    ↓
              handleSlashCommand (共享) + resolveAppPromptInput
                    ↓
              ctx.onModelSwitch → switchAgentRuntime() 原地更新 ctx.agent
```

### 架构差异点

| 维度 | 旧 (React/Ink) | 新 (T9 ANSI) | 风险 |
|------|---------------|-------------|------|
| /model handler | 在 main.tsx 的 useCallback 中 | 在 SlashRouter 的 onModelSwitch 闭包中 | **中** — 闭包捕获的 ctx 引用 |
| 模型切换 | useMemo 触发 React 重渲染 → 重建 AgentLoop | switchAgentRuntime() 原地替换 ctx.agent | **低** — 逻辑同构 |
| 命令路由 | App.tsx → handleSlashCommand 直接 | SlashRouter → handleSlashCommand 委托 | **低** — 适配器模式 |
| 上下文传递 | React props/refs | 闭包 + MutableRef 适配器 | **中** — ref 兼容层 |

---

## 三、逐命令回归检查

### /model — ⚠️ 潜在风险

**代码路径**：
```
用户输入 "/model v4-flash"
→ TuiApp.submitSlashCommand("/model v4-flash")
→ SlashRouter.route("/model v4-flash")
→ resolveAppPromptInput → null (非透传命令)
→ handleSlashCommand(ctx)
→ case '/model': ctx.onModelSwitch('v4-flash')
→ switchAgentRuntime(ctx, 'v4-flash')
→ createAgentRuntime({ provider: prov, modelId: found.id, ... })
→ ctx.agent = agent (原地替换)
→ app.setModelInfo(res.modelName, res.contextWindow) (刷新 GlanceBar)
```

**风险点**：
1. `buildAllProviders()` 从 `ctx.config.provider.providers` 构建，但 `availableModels` 从 `ctx.provider.models` 构建 — 两者来源不同
2. 当请求的 model 不在当前 provider 而在其他 provider 时，`switchAgentRuntime` 可以正确跨 provider 查找
3. 但 `/model list` 显示的模型列表来自 `allProviders`，如果某个 provider 的 models 为空，该 provider 不显示

**测试覆盖**：❌ **零覆盖** — 35 个 slash-commands 测试中无 `/model` 测试

### /review — ✅ 无回归

- `resolveAppPromptInput` 正确将 `/review` 和 `/review max` 映射为 deliver_task 指令
- `handleSlashCommand` 中 `/review` 返回 `false`（透传 agent）— 与旧行为一致

### /plan — ✅ 无回归

- `/plan <feature>` 透传 agent（返回 false）
- `/plan close <file> --tasks <range>` 映射为 plan_close workflow
- 测试覆盖良好（5 个测试）

### /team — ✅ 无回归

- `/team <task|plan>` 和 `/team max <task>` 透传 agent
- workflow 解析正确

### /domain — ✅ 无回归

- 测试覆盖充分（6 个测试）
- 与旧 React 路径逻辑一致

### /status — ⚠️ banditState 依赖

- T9 路径中 `banditState` 来自 `ctx.refs.banditState`
- 如果 `ctx.refs` 未初始化 banditState 字段，将始终显示 "(no bandit state available)"
- 非阻塞性退化

### /exit, /quit — ✅

- SlashRouter 直接处理，不依赖 handleSlashCommand
- 调用 `ctx.shutdown()` 执行完整清理

### /clear — ✅

- SlashRouter 直接处理，ANSI 清屏

### /cockpit — ⚠️ T9 降级

- T9 中 `setCockpitPanel` 是 noop
- `/cockpit` 命令返回 true 但无可见效果
- 非阻塞性退化（T9 没有 cockpit overlay）

---

## 四、测试覆盖缺口

| 命令 | 测试数 | 缺口 |
|------|--------|------|
| /model | **0** | **完全缺失** — 需要补充 list/switch/error 三个场景 |
| /status | **0** | 缺失 — banditState 路径未覆盖 |
| /exit | **0** | 缺失 — 需要集成测试 |
| /verbose | 1 | 基本覆盖 |
| /domain | 6 | 良好 |
| /plan | 5 | 良好（resolveAppPromptInput 侧） |
| /team | 3 | 良好（resolveAppPromptInput 侧） |

**总计**：35 个测试中，/model 和 /status 的关键路径完全无覆盖。

---

## 五、需要关注的死代码/废弃路径

| 路径 | 状态 |
|------|------|
| `main-ink.tsx` 旧的 handleModelSwitch useCallback | 已在 `938c71f` 中移除 |
| `main.tsx` (Ink 版本) | 降级但保留，不再作为主入口 |
| `surfacePush/surfacePop` | T9 中设为 undefined，handleSlashCommand 中 `/cockpit`、`/scroll` 依赖它们 — T9 路径下这些命令降级为文字提示 |
| `setCockpitPanel` | T9 中 noop |

---

## 六、判定

### 未发现阻断性回归

- typecheck 通过（0 错误）
- 现有 35 个 slash-commands 测试全部通过
- 架构迁移路径清晰，适配器层逻辑正确

### 存在的风险

| 风险 | 严重性 | 建议 |
|------|--------|------|
| `/model` 零测试覆盖 | **高** | 补充 3 个测试：list/switch/error |
| `/model list` 的 availableModels 与 allProviders 来源不一致 | **中** | 统一为 allProviders 或增加当前 provider 高亮 |
| banditState 可能为空导致 /status 无数据 | 低 | 增加 fallback 提示或确保 refs.banditState 初始化 |
| T9 下 cockpit/scroll 等 overlay 命令降级为文本 | 低 | 已知限制，非回归 |
| `/model` 切换后旧 agent 的残留回调 | 低 | `abort()` + 世代守卫已覆盖 |

### 关于 "/model 切换不了" 的诊断

如用户在实际运行中遇到 `/model` 无法切换，建议排查：
1. 检查 `~/.rivet/config.json` 中 provider 配置是否正确
2. 检查 `/model list` 是否能显示模型列表 — 如果不能，问题在 provider 配置加载
3. 检查 `/model <name>` 时是否打印了错误信息 — SlashRouter 会 catch 异常并显示

---

*审查基于 git diff 4da99cf^..HEAD 的完整变更 + 源码阅读 + typecheck + 35 个测试运行。*
