# 工具门控：生效修复 + headless 对齐 + 逃生口落地

> 关联提交：`0d46d34c`（tier 定义/schema）→ `dfcf9931`（接线+逃生口骨架）→ `b9364810`（P0 对齐+集成测试）→ 本次（生效修复/headless/逃生口真实化）。

## TL;DR

门控在本次之前**基本是空操作**：构造期把主控工具过滤到 CORE，但 MCP/LSP 异步初始化后调用的 `agent.updateTools()` 会**重新拉全量**，毫秒内把门控整个还原。headless 路径则压根没过滤。本次把门控收敛到唯一入口、让 `updateTools` 尊重门控，门控**首次真正生效**；同时把逃生口 `/tools enable` 从"只打印建议"做成"真实挂载 + provider-aware 缓存代价提示"。

## 根因：为什么门控此前不生效

```
构造期 createAgentRuntime → toolDefinitions 过滤到 CORE → promptEngine 起步是门控的 ✓
        ↓ (步骤 13, 异步)
initializeMcp(...).then(() => agent.updateTools())   ← updateTools 旧实现拉 getDefinitions() 全量
initializeLsp(...).then(() => agent.updateTools())   ← 再次全量
        ↓
promptEngine.staticCtx.tools = 全量(~38-40 + MCP)   ← 门控被还原，EXTENDED 全回来了
```

- `initializeMcp` 即使没有任何 MCP server 也会 resolve 并触发 `updateTools()` → 几乎每次 TUI 启动都会还原。
- headless（`main.ts`）不走 MCP/LSP 初始化，但它直接 `toolDefinitions: toolRegistry.getDefinitions()`（未过滤）→ 同样全量。

结论：旧实现里，门控对主控**实际可见工具数没有产生持久影响**。

## 本次改动

### 1. 唯一过滤入口 `gateToolDefinitions`（`src/agent/tool-tiers.ts`）

把"构造期过滤"和"updateTools 重建"统一到同一个纯函数，杜绝两处语义漂移。

- **语义改为 deny-list（关键决策）**：只摘 `EXTENDED_SET` 内的工具；CORE 与**一切未分类工具（MCP / LSP / 自定义注册）原样保留**。
  - 旧实现是 allow-list（只留 CORE），会把用户显式装配的 **MCP 工具误删** —— 这是不可接受的回归。
  - allow-list 仍保留为显式覆盖路径：当域级 `mainToolTier` 或 config `coreTools` 给定时启用（用户显式接管，自负 MCP 被摘的后果）。
- `exempt = extraCore ∪ mountedExtras`（config 永久挂回 + 运行时逃生口挂回）对两档都放行。

### 2. 门控集中到 `createAgentConfig`（覆盖三条路径）

TUI / server / headless 都经过 `createMainAgentConfigInput → createAgentConfig`。把过滤放在这一处，三条路径自动一致：

- `create-agent-config.ts`：线程 `toolGating`，构造期用 `gateToolDefinitions` 过滤，返回 `toolGating` + `prefixCacheStrategy`（逃生口量化缓存代价用）。
- `bootstrap.ts`：删除原先会误删 MCP 的 allow-list IIFE，改为传全量。
- `main.ts`（headless，#2）：无需改动——经 `config: cfg` 自动获得门控，与 TUI 对齐。

### 3. `updateTools` 尊重门控（`src/agent/loop.ts`）

```ts
private gatedToolDefinitions(): ToolDefinition[] {
  // gateToolDefinitions(全量, { ...门控配置, mountedExtras })
}
updateTools(): void {
  this.config.promptEngine.updateTools(this.gatedToolDefinitions())
}
```

这是根因修复：MCP/LSP 注册后的 `updateTools()` 不再还原 EXTENDED。

### 4. 逃生口真实化（#1）

- `AgentLoop.enableTool(name)`：校验"已注册 + 属 EXTENDED" → 加入 `mountedExtras` → `updateTools()`。在 **turn 边界**由 slash 触发（不进 tool-loop，不破坏 turn 内前缀缓存时序，见 `turn-cache-timing.test.ts`）。
  - 返回结构化状态：`mounted` / `already-active` / `not-extended` / `unknown` / `gating-off`。
  - **provider-aware**：`prefixCacheStrategy === 'none'` → `cacheImpact: 'none'`；`deepseek-native` / `anthropic-cache-control` → `cacheImpact: 'prefix-invalidated'`（下次请求整前缀缓存 MISS，一次性）。
- `slash-commands.ts` `/tools enable <name>`：渲染上述状态 + 缓存代价文字；`/tools` 列表标注已挂载的 EXTENDED。

### 5. 由"门控真生效"暴露并修复的悬空引用

static prompt L80 指示模型使用 `recall_capsule`，但它原在 EXTENDED → 真门控后从主控消失，造成 prompt 指向调不到的工具。按 P0 既定规则（**static 引用的工具必须常驻 CORE**，与 `request_path_access`/`skill` 同源），把 `recall_capsule` 移到 CORE，并加防回归守卫。

## 测试

- 新增 `src/agent/__tests__/tool-gating-escape-hatch.test.ts`（15 例）：
  - `gateToolDefinitions`：disabled 全量 / deny-list 保留 MCP / extraCore / mountedExtras / coreOverride 切 allow-list / domainTier 优先。
  - `AgentLoop`：getActiveToolNames 反映门控 / **updateTools 不再还原 EXTENDED（根因回归守卫）** / enableTool 全状态机 + provider-aware。
- 回归全绿：tool-tiers(17→部分更新)、turn-cache-timing(21)、slash-commands(43)、kernel-budget(7)。

## 遗留与设计偏差

1. **`apply_patch` / `import_resource` 仍在 EXTENDED**。早前 review 曾要求 `apply_patch→CORE`，未应用。门控真生效后，codex 系模型在主控将没有 `apply_patch`（但有 `edit_file`/`hash_edit`）。是否移回 CORE 是分类决策，待拍板。
2. **全量 `tsc --noEmit` 当前不可用作闸门**：并发工作树有大量与本改动无关的既有破损（`default.ts` 缺字段、`serve.ts` serverLogger、compaction-controller、memory.ts 等）。本次用 per-file node:test + LSP lint 验证自身改动均干净。
3. **per-domain `mainToolTier` 仍是 dead path**：`gateToolDefinitions` 已预留 `domainTier` 入参，接入"域检测 → 传入 domainTier"即可激活。
4. 逃生口为**一步挂载**（无二次确认）：slash 命令本身已是显式动作，缓存代价以文字明确打出。
