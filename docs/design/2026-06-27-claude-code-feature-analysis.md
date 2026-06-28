# Claude Code 特性分析与天枢移植建议

> 2026-06-27 · 分析 `claude-code-haha`(Claude Code 泄露源码本地修复版),识别可移植到天枢 TUI / 桌面端的特性

## 1. Claude Code 架构概览

Claude Code 是 **Bun + Ink 6 (React 19)** 的 TUI 应用,代码量极大(REPL.tsx 874KB、main.tsx 785KB)。核心子系统:

| 子系统 | 代码量 | 说明 |
|--------|--------|------|
| `buddy/` | ~70KB | **抽卡式伴生体**(species/rarity/stats/gacha) |
| `vim/` | ~50KB | **完整 vim 模式**(operators/motions/textobjects) |
| `hooks/useTurnDiffs.ts` | 214 行 | **每轮 diff 统计**(per-turn file changes) |
| `outputStyles/` | ~100 行 | **用户自定义输出风格**(markdown → system prompt) |
| `keybindings/` | ~120KB | **完整快捷键系统**(context-aware + 用户可配) |
| `context/notifications.tsx` | 240 行 | **通知队列**(priority + invalidation + fold) |
| `memdir/` | ~500 行 | **结构化记忆系统**(MEMORY.md + frontmatter) |
| `cost-tracker.ts` | 324 行 | **成本追踪**(per-model + API duration + lines) |
| `hooks/useTypeahead.tsx` | **207KB** | **巨型自动补全**(文件/命令/skill/历史) |
| `coordinator/` | ~600 行 | **协调器模式**(multi-agent 编排 DSL) |
| `native-ts/file-index/` | — | **文件索引**(Rust 加速的文件名模糊搜索) |
| `hooks/useVoiceIntegration.tsx` | 97KB | **语音集成**(STT + keyterms + 连续对话) |

## 2. 可移植特性(按 ROI 排序)

### Tier A — 高价值、天枢缺失、可直接做

#### 2.1 每轮 Diff 统计(Turn Diffs)

**Claude Code 的实现**:`useTurnDiffs.ts` 追踪每个 turn 内的文件编辑(edit_file/write_file 工具结果),聚合成 `TurnDiff`:
```typescript
type TurnDiff = {
  turnIndex: number
  userPromptPreview: string  // 用户输入预览
  timestamp: string
  files: Map<string, TurnFileDiff>  // 每个文件的 hunks
  stats: { filesChanged, linesAdded, linesRemoved }
}
```
在每个 turn 结束时,底部显示 `+12 -3 in 2 files`,用户一眼知道这轮改了多少。

**天枢现状**:ChangesTab 显示工作树全部 diff,但不按 turn 分割。GlanceBar 只显示累计 cost/token,不显示本轮改动量。

**移植方案**:
- **TUI**:在 turn 结束时,GlanceBar 区域显示本轮 diff stat `本轮: +12 -3 (2 files)`。数据从 tool_use 结果的 structuredPatch 提取(已有)。
- **桌面**:ReviewPanel 的 Review tab 底部增加 per-turn diff 摘要条。

**工作量**:TUI 2h,桌面 2h。**收益**:用户每轮知道改了什么,不必切 ChangesTab。

#### 2.2 用户自定义输出风格(Output Styles)

**Claude Code 的实现**:用户在 `.claude/output-styles/*.md` 放 markdown 文件,每个文件变成一个"输出风格",内容作为 system prompt 追加。用 `/output-style <name>` 切换。

**天枢现状**:有星域人格系统(star-domain),但没有用户自定义的"输出风格"。星域是预设的,用户不能自己定义。

**移植方案**:
- 新增 `.rivet/output-styles/*.md` 目录,每个 md 文件 = 一个输出风格
- 新增 `/output-style` slash 命令切换
- 风格内容通过 promptEngine 注入 system prompt 的 appendix 区块
- 与星域正交:星域管"决策风格",输出风格管"表达风格"

**工作量**:3h。**收益**:用户可定制 agent 的表达方式(简洁/详细/中文/英文/代码优先)。

#### 2.3 Vim 模式(Vim Mode)

**Claude Code 的实现**:`vim/` 目录有完整的 vim operators(delete/change/yank/paste) + motions(word/line/paragraph/search) + textobjects(word/sentence/paragraph/quote)。通过 `useVimInput` hook 接入输入框。

**天枢现状**:输入框是普通的 readline 式编辑,无 vim 模式。对 vim 用户的肌肉记忆完全不友好。

**移植方案**:
- **TUI**:移植 `vim/operators.ts` + `vim/motions.ts` + `vim/textObjects.ts` 到 `src/tui/vim/`,接入 input-handler.ts 的按键处理
- **桌面**:Composer 的 textarea 加 `useVimInput` 模式(Cmd+I 切换 vim/insert)
- 纯逻辑(operators/motions/textObjects)可直接拷贝,适配层重写

**工作量**:TUI 1 天(移植 + 适配),桌面 1 天。**收益**:vim 用户不用学新编辑方式。

#### 2.4 结构化记忆系统(MemDir)

**Claude Code 的实现**:`memdir/` 维护一个 `MEMORY.md` 文件,带 frontmatter(类型/标签/过期)。有自动截断(200 行 / 25KB cap)、自动记忆写入、相关性检索。比天枢的 pheromone 系统更结构化。

**天枢现状**:有 pheromone 信号 + session memory + project knowledge,但分散在三个系统里,没有统一的结构化入口。

**移植方案**:
- 合并 pheromone + session memory + project knowledge 到统一的 `.rivet/MEMORY.md`
- 带 frontmatter 分类(架构决策/调试启发式/用户偏好/项目约定)
- `/memory` 命令增加结构化操作(add/search/forget)
- 自动截断 + 相关性排序(避免 MEMORY.md 无限膨胀)

**工作量**:1-2 天(涉及合并三个现有系统)。**收益**:记忆系统结构化,跨会话知识不丢失。

### Tier B — 中价值、可参考设计

#### 2.5 通知队列(Priority Notifications)

**Claude Code 的实现**:`notifications.tsx` 有 4 级优先级(low/medium/high/immediate)、invalidation(新通知可以作废旧通知)、fold(同 key 通知合并)。

**天枢现状**:桌面端用 sonner toast(TUI 无通知系统),但都是 flat 的,没有优先级/合并/作废。

**移植方案**:
- **桌面**:给 sonner 包一层 priority wrapper(immediate 打断当前,high 优先显示)
- **TUI**:新增 notification overlay,在 GlanceBar 下方显示,带优先级和超时

**工作量**:桌面 1h,TUI 3h。**收益**:通知不堆积,重要的先看到。

#### 2.6 完整快捷键系统(Keybindings)

**Claude Code 的实现**:`keybindings/` 有完整的用户可配置快捷键系统:17 个 context(Global/Chat/Autocomplete/Task/...)、用户 `keybindings.json` 自定义、快捷键校验、快捷键提示。

**天枢现状**:快捷键全部硬编码在 `use-global-shortcuts.ts`。用户不能自定义。

**移植方案**:
- 新增 `.rivet/keybindings.json` 用户配置文件
- 快捷键按 context 分组(workspace/review/composer/overlay)
- `/keybindings` 命令显示当前绑定 + 编辑入口
- 这也是对标文档 Gap 6(keymap + 设置深挖)的方案

**工作量**:1-2 天。**收益**:用户可定制快捷键,对标 VS Code。

#### 2.7 抽卡式伴生体 → 星域角色

**Claude Code 的实现**:`buddy/` 有 18 种 species(duck/cat/dragon/octopus/...) × 5 级 rarity(common→legendary) × 随机属性(STR/DEX/INT/...)。基于 userId 确定性生成("抽卡"),用 ASCII art sprite 渲染在 TUI 角落。

**天枢的适配**:这个设计与我们已设计的**星域角色可视化**文档高度契合。但 Claude Code 的 buddy 是"宠物"隐喻(鸭子/猫),天枢应该用**北斗七星**隐喻:
- species → 星位(天枢/破军/天府/...)
- rarity → 星等(1-5 等,按亮度)
- stats → 星域属性(结构化/探索性/验证优先/创造性/速度)
- sprite → 程序化符印(我们的设计文档已有方案)

**移植方案**:参考 buddy 的 **确定性生成 + 随机属性** 机制,但用星域数据替换 species/rarity。直接参考我们已写的星域可视化设计文档。

**工作量**:已估(设计文档 2-3 天)。**收益**:差异化护城河。

### Tier C — 低优先级/重实现

| 特性 | Claude Code | 天枢现状 | 移植价值 |
|------|------------|---------|---------|
| 巨型 typeahead(207KB) | 文件/命令/skill/历史 全融合补全 | 桌面有 slash 补全,TUI 有 `/` 补全 | 低(天枢按需补全更轻量) |
| coordinator 模式 | 600 行 DSL 编排多 agent | 已有 team-orchestrator + work-order | 低(已实现等价物) |
| voice 集成(97KB) | STT + keyterms + 连续对话 | 桌面有语音输入,TUI 无 | 中(TUI 可做) |
| token estimation | API count-tokens 精确计数 | 本地估算 | 低(精度差异小) |

## 3. 不建议移植的

| 特性 | 原因 |
|------|------|
| Ink 6 渲染引擎 | 天枢已有 T9 ANSI 引擎 + 桌面 React,不需要 Ink |
| Anthropic SDK 集成 | 天枢用自研 pi-ai 多 provider 抽象 |
| GrowthBook A/B 测试 | 天枢不需要 feature flag 服务 |
| OpenTelemetry 遥测 | 天枢有自己的 logger + stats 面板 |
| AWS Bedrock 集成 | 天枢用 DeepSeek/OpenAI 兼容 API |
| Recovery CLI | 天枢已有降级模式 |

## 4. 推荐执行顺序

| 优先级 | 特性 | 目标端 | 工作量 | 理由 |
|--------|------|--------|--------|------|
| **P0** | 每轮 Diff 统计 | TUI + 桌面 | 4h | 信息透明度,立即有感知 |
| **P0** | 输出风格 | TUI | 3h | 用户可定制表达,与星域正交 |
| **P1** | Vim 模式 | TUI + 桌面 | 2 天 | vim 用户刚需 |
| **P1** | 结构化记忆 | TUI | 1-2 天 | 合并三个分散系统 |
| **P1** | 通知队列 | 桌面 + TUI | 4h | 通知不堆积 |
| **P2** | 快捷键系统 | TUI + 桌面 | 1-2 天 | 对标 Gap 6 |
| **P2** | 星域角色(参考 buddy) | 桌面 | 2-3 天 | 已有设计文档 |
