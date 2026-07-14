# 2026-07-15 浏览器与 Computer Use 工作流闭环

## 背景

主控「不知道怎么调用浏览器 / computer use」是四层设计叠加的结果，不是单一 bug：

1. **Schema 层**：`browser_debug` / `computer_use` 都在 EXTENDED 层，默认被 `gateToolDefinitions` 从主控工具列表滤掉——模型根本看不到。
2. **Prompt 层**：static prompt 的 `<tool-usage>` 与 `<workflow>` 验证段没有任何浏览器/桌面自动化指引。
3. **引导层**：`getVisualToolsAvailable` 漏掉 `browser_debug`（它可用时 render-verify 仍走「缺少视觉验证工具」降级文案）；`self-verify` 不把浏览器截图算 ground-truth 验证（截图验证了还被催「跑测试」）。
4. **Worker 层**：11 个星域 `toolWhitelist` 不含 `computer_use`——delegate 路径拿不到桌面自动化能力。

## 变更

### 暴露策略（混合）

- **`browser_debug` 升入 CORE**（`tool-tiers.ts`，CORE 25→26）：UI 渲染验证闭环主工具，主控恒可见。`browser`（一次性 headless，默认未注册）标注为退役候选。
- **`computer_use` 保持 EXTENDED + 任务感知自动挂载**：新 hook `computer-use-mount-hook.ts`（afterPerception）检测用户意图含桌面 GUI 关键词（原生应用名、「打开/点击应用/窗口」等中英模式）→ 调 `AgentLoop.enableTool('computer_use')` 并经 advisory 告知模型。**严格限制 turn ≤ 1**（挂载翻 tool fingerprint，早期挂载缓存代价最小）；每会话至多一次；`RIVET_COMPUTER_USE_AUTOMOUNT=0` 禁用。
- **星域白名单**：11 个内置域统一加入 `computer_use`（fail-closed 语义不动）。

### Prompt 指引（一次改到位）

- static `<tool-usage>` 新增「浏览器与桌面自动化分工」段：`web_fetch/web_search`=读内容、`browser_debug`=本地 web 联调与视觉验证主工具、`computer_use`=原生 GUI 兜底（EXTENDED 需挂载）+ 审批边界提示。
- `<workflow>` ⑤验证段补 UI 分支：改 UI 文件 → 交付前 browser_debug 截图 + console 无错。
- 文曲域 `systemPromptSuffix` 加「看见你雕琢的东西」——美学判断落在渲染结果上。
- worker prompt：allowed tools 含 browser_debug/computer_use 时附一行使用要点。

### Hook 修复与验证判定

- `getVisualToolsAvailable`（loop-factory）补 `browser_debug`。
- `toolTargetFromInput`：browser_debug/browser/computer_use 的 target 改为 `action (+url/app)`（范围刻意限定——git/plan 的 action 不受影响），信息素区分度与验证判定共用。
- `self-verify` `isVerifyCall`：`browser_debug` 的 screenshot/snapshot/console/network(_detail) 与 `computer_use` 的 snapshot 计为 ground-truth 验证；open/navigate/click 是操作不计。
- render-verify advisory 带具体动作序列（open → navigate → screenshot）与挂载方法；deliver_task 的 `detectMissingVisualVerify` 文案同步。

### 桌面端与 CLI 呈现

- `browser-mirror.ts`：识别 `computer_use` 的 CDP 导航（`Navigated to "<title>" — <url>` 族）与截图 artifact（括号形式 id）；BrowserPanel 不再只镜像 browser_debug。
- `BrowserPanel` 空态改为可操作引导：输入 dev server URL 一键把「打开并检查」prompt 发进 composer（复用 `onSendPrompt`）。
- `ToolGroup` 的富渲染分支覆盖 computer_use：截图内联 + 可访问性树按行分级着色。
- `humanizeToolInput` 加 computer_use case（`action url|app · text`），不再 JSON dump。
- **walkthrough 扩展**：记录器覆盖 `browser_debug` 步骤（action、URL、截图 artifact、失败原因），`WalkthroughStep` 新增可选 `tool` 字段（缺省=computer_use，旧数据兼容）。
- **CLI 截图可见性**：browser_debug/computer_use 截图除 artifact 外**落一份真实 PNG**（`<artifact>.raw` 旁的 `.png`），browser_debug 结果尾注 `Saved: <path>`——纯 ANSI 终端用户可直接打开。

## 缓存影响

- **CORE 集 + static prompt + 星域 suffix 变更 = tool/prompt fingerprint 翻转**：升级后每会话首请求一次性全前缀 miss，属版本升级预期成本；已集中在本版本一次改完，不分波碎改。
- computer_use 自动挂载只在 turn 0-1 窗口触发，挂载时前缀尚短，miss 代价最小；窗口过后永久停用。

## 回归

- 新增/更新测试：tool-tiers CORE 断言、computer-use-mount-hook 触发/不触发/窗口/幂等、self-verify 浏览器验证判定、star-domain 白名单、tool-target action 提取、walkthrough browser_debug 步骤、browser-mirror computer_use 解析。
- 门禁：根 `typecheck` ✓、desktop `typecheck` ✓、desktop `build` ✓、desktop test 363 ✓、根全量 test ✓。
- 已知遗留（stash 基线验证均为改动前已存在，与本轮无关）：`volatile.test.ts` 的 plan-mode 文案断言（/父目录/）、`health-route.test.ts` 的 fail-closed 用例、`ask-user-question-endturn.test.ts` 的 multi-select 用例。
