# P0 会话渲染优化：消息类型分离 + 工具调用折叠

> **Wave 13 · Session Rendering Overhaul**
> 基于三个项目（Claude Code / DeepSeek-TUI / Rivet）的对比探查

---

## 1. 问题陈述

Rivet 当前的会话 UI 存在两个核心缺陷：

1. **消息类型扁平化** — `LogEntry` 只有 4 种类型（text/tool/checkpoint/evidence），用户输入、助手回复、系统消息全部映射为 `type:'text'`，无法按角色应用不同视觉样式
2. **工具调用全平铺** — 每个工具调用独立渲染，10+ 次连续工具调用无折叠，占据大量屏幕空间

## 2. 竞品关键发现

### 2.1 Claude Code

**消息体系**：30+ 独立消息组件，通过 `switch(message.type)` 分发。核心视觉元素：
- 用户消息：背景色 + XML 内容分发（bash stdout、command、memory 等子类型）
- 助手消息：`⏺` 黑圆前缀 + `⎿` 缩进 + Markdown 渲染
- 系统消息：`※`/`✻` Unicode 前缀 + dimColor

**工具折叠**：两层 pipeline
- 层 1 `groupToolUses`：同消息内相同工具 >= 2 个自动分组
- 层 2 `collapseReadSearchGroups`：跨消息连续 Read/Search 工具折叠为一行摘要
- 折叠后："Searched 3 patterns, Read 5 files" + Ctrl+O 展开
- 工具自身声明 `isCollapsible` 接口

### 2.2 DeepSeek-TUI

**消息体系**：`HistoryCell` 枚举（10+ 变体），每种有独立 glyph + 颜色：
- User：`▎` 左竖线 + 绿色文本
- Assistant：`●` 蓝色呼吸脉冲 + 天蓝色标签
- Thinking：暖铜色 `…` + 12% 背景色 tint + 时长
- Tool：9 种 ToolFamily（Read `▷`、Patch `◆`、Run `▶`、Find `⌕`、Delegate `◐`…）

**工具折叠**：
- Card Rail 分组：相邻 tool cell 自动画 `╭│╰` 左侧 rail，零间距
- ExploringCell 聚合：并发 read_file/grep 合并为一个 "Workspace" cell
- 智能行选择：error > warning > path 重要性排序，非简单截断
- Calm Mode：`show_thinking`/`verbose`/`show_tool_details`/`calm_mode`/`low_motion` 五档独立开关

### 2.3 值得借鉴的设计共性

| 设计点 | Claude Code | DeepSeek-TUI | Rivet 应采纳 |
|--------|-------------|-------------|-------------|
| 消息按角色独立类型 | switch 分发 | HistoryCell 枚举 | LogEntry 扩展 |
| 工具 verb-glyph 分类 | — | 9 种 ToolFamily | 采纳，简化版 |
| 连续工具折叠 | 两层 pipeline | Card Rail + ExploringCell | 单层渲染时分组 |
| 前缀符号体系 | ⏺ ⎿ ※ ✻ | ▎ ● … ╭│╰ | 建立统一符号表 |
| 折叠后摘要 | 计数 + 文件路径 | verb-glyph + 状态 | 计数 + 工具名摘要 |

## 3. 设计决策

### D1: LogEntry 类型扩展

**当前**：`'text' | 'tool' | 'checkpoint' | 'evidence'`

**扩展为**：

```typescript
type LogEntryType =
  | 'user_message'       // 用户输入
  | 'assistant_message'  // 助手文本回复
  | 'tool'               // 工具调用结果（已有）
  | 'tool_group'         // 折叠的工具调用组
  | 'checkpoint'         // 检查点（已有）
  | 'evidence'           // 证据（已有）
  | 'system'             // 系统消息（错误、提示）
```

**附加字段**：

```typescript
interface LogEntry {
  type: LogEntryType
  id: string
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number        // NEW: 所属 turn 编号
  children?: LogEntry[]      // NEW: tool_group 的子条目
}
```

**为什么不在创建时做工具分组**：分组是视觉概念。工具完成顺序可能与发起顺序不同（并发），在渲染时分组更灵活。`tool_group` 类型仅用于渲染后处理。

### D2: 视觉符号体系

借鉴两个项目，建立 Rivet 的符号表：

| 角色 | 前缀 | 颜色（pastel 主题） | 说明 |
|------|------|---------------------|------|
| 用户消息 | `❯` | `#a8e6cf` (mint) | 用户输入行 |
| 助手消息 | `●` | `#d4a5f5` (lavender) | 助手回复头部 |
| 工具（运行中） | `◦` | `#ffdac1` (peach) | spinner 态 |
| 工具（成功） | `·` | `#b5ead7` (soft green) | 完成态 |
| 工具（失败） | `·` | `#ff9aa2` (coral) | 错误态 |
| 系统消息 | `⌁` | `#8585a0` (dim) | 错误/提示 |
| 折叠工具组 | `▸` | `#8585a0` (dim) | 折叠指示器 |

### D3: 工具分组策略

采用**渲染时分组**（非数据层分组），类似 DeepSeek-TUI 的 Card Rail：

**触发条件**：
- 同一 `turnNumber` 内连续 >= 3 个 `type:'tool'` 条目
- 被非 tool 条目（user_message/assistant_message）中断

**折叠展示**：
```
▸ 5 tool calls: read_file x3, edit_file x1, bash x1 — Enter to expand
```

**展开后**：显示完整 ToolCard 列表，带 `╭│╰` 左侧 rail

**阈值**：>= 3 个连续工具才折叠，1-2 个保持独立展示

### D4: 工具分类体系

简化版 ToolFamily（5 种，覆盖 Rivet 全部工具）：

```typescript
type ToolFamily = 'read' | 'write' | 'run' | 'find' | 'other'

const TOOL_FAMILIES: Record<string, { family: ToolFamily; glyph: string; verb: string }> = {
  read_file:     { family: 'read',  glyph: '▷', verb: 'read'   },
  glob:          { family: 'find',  glyph: '⌕', verb: 'find'   },
  grep:          { family: 'find',  glyph: '⌕', verb: 'find'   },
  bash:          { family: 'run',   glyph: '▶', verb: 'run'    },
  edit_file:     { family: 'write', glyph: '◆', verb: 'patch'  },
  write_file:    { family: 'write', glyph: '◆', verb: 'write'  },
  run_tests:     { family: 'run',   glyph: '▶', verb: 'test'   },
  delegate_task: { family: 'run',   glyph: '▶', verb: 'delegate' },
}
```

### D5: 不做的事（YAGNI）

- **不实现**虚拟滚动/窗口化（Ink Static 的增量 diff 在当前规模足够）
- **不实现**两层折叠 pipeline（Claude Code 的 groupToolUses + collapseReadSearch，单层够用）
- **不实现**XML 内容分发（Claude Code 的 UserTextMessage 子类型路由，Rivet 不需要）
- **不实现**跨消息折叠（只折叠同一 turn 内的连续工具）
- **不重构** pushStatic 的批量优化（当前规模不构成瓶颈）

## 4. 文件变更清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `src/tui/user-message.tsx` | 用户消息渲染组件 |
| `src/tui/system-message.tsx` | 系统消息渲染组件 |
| `src/tui/tool-group.tsx` | 工具折叠组渲染组件 |
| `src/tui/tool-family.ts` | 工具分类定义 + glyph 映射 |
| `src/tui/group-logs.ts` | 渲染时 LogEntry 分组逻辑 |
| `src/tui/__tests__/tool-family.test.ts` | 工具分类测试 |
| `src/tui/__tests__/group-logs.test.ts` | 分组逻辑测试 |
| `src/tui/__tests__/user-message.test.ts` | 用户消息组件测试 |
| `src/tui/__tests__/system-message.test.ts` | 系统消息组件测试 |
| `src/tui/__tests__/tool-group.test.ts` | 工具组组件测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/tui/log-state.ts` | LogEntry 类型扩展 + turnNumber/children 字段 |
| `src/tui/app.tsx` | renderStaticEntry 分发 + handleSubmit 类型 + onTurnComplete 类型 + 分组渲染 |
| `src/tui/tool-card.tsx` | 集成 ToolFamily glyph + 颜色 |
| `src/tui/theme.ts` | 新增 userColor / assistantColor / systemColor |
| `src/tui/history-replay.ts` | 消息类型映射更新 |
| `src/tui/__tests__/log-state.test.ts` | 新类型测试 |
| `src/tui/__tests__/history-replay.test.ts` | 更新类型映射测试 |

## 5. 数据流（改造后）

```
用户输入
  → pushStatic({ type: 'user_message', content, turnNumber })
  
助手 streaming
  → BlockStreamWriter → setStreamingText()
  → onTurnComplete → pushStatic({ type: 'assistant_message', content, turnNumber })

工具调用
  → onToolResult → pushStatic({ type: 'tool', toolName, content, turnNumber })

渲染管线
  staticItems → groupByTurn() → groupedItems
    → renderStaticEntry()
      case 'user_message'     → <UserMessage />
      case 'assistant_message' → <StreamOutput /> (已有，加前缀)
      case 'tool'             → <ToolCard /> (已有，加 glyph)
      case 'tool_group'       → <ToolGroup /> (新建)
      case 'system'           → <SystemMessage /> (新建)
```

## 6. 风险评估

| 风险 | 缓解 |
|------|------|
| LogEntry 类型扩展导致 history-replay 不兼容 | 回放时将旧 'text' 类型智能映射为新类型 |
| 工具分组逻辑引入渲染 bug | 纯函数 + 充分测试，不依赖 React 状态 |
| 新组件增加 bundle 体积 | 每个组件 < 50 行，Ink 组件极轻量 |
| theme.ts 新增颜色影响现有主题 | 新颜色从现有 ColorSet 推导，不引入新色值 |
