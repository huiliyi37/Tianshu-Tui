# Wave 1 任务文档：Session Replay

> 任务编号：W1-07
> 优先级：高
> 预估：单 session，1.5 小时
> 前置依赖：无

## 目标

将 session 的完整决策链可视化回放。用户可以回顾任何历史 session 的每一步：模型想了什么、做了什么、为什么这么做。

## 背景

已有基础：
- `src/agent/session-persist.ts` — JSONL 格式持久化（~/.rivet/sessions/）
- `src/tui/history.ts` / `history-replay.ts` — 历史相关组件已存在
- `src/agent/trace-store.ts` — 工具执行 trace（开始/结束/耗时/状态）

## 设计

### 回放视图

```
$ tianshu --replay <session-id>

  ╭─ Session Replay: abc123 (2026-05-21 14:30) ─╮
  │                                              │
  │  Turn 1/15                    [←] [→] [q]   │
  │                                              │
  │  User: "实现 chat mode"                      │
  │                                              │
  │  Model thinking:                             │
  │    需要修改 prompt/engine.ts 和 agent/loop   │
  │                                              │
  │  Actions:                                    │
  │    read_file src/prompt/engine.ts    ✓ 2.1s  │
  │    read_file src/agent/loop.ts       ✓ 1.8s  │
  │                                              │
  │  Model response:                             │
  │    "我先读取了相关文件..."                    │
  │                                              │
  ╰──────────────────────────────────────────────╯
```

### 数据源

从 JSONL session 文件解析：
- 每条消息的 role、content、tool_use、tool_result
- thinking blocks（如果模型支持）
- trace events（工具执行耗时和状态）

### 导航

- `←` / `→` — 前后翻页（按 turn）
- `j` / `k` — 上下滚动当前 turn 内容
- `q` — 退出
- `/` — 搜索（在所有 turn 中搜索关键词）
- `s` — 摘要视图（只显示每轮的 action 列表）

## 实现计划

### Task 1: Session 解析器

创建 `src/replay/session-parser.ts`：
- 读取 JSONL 文件
- 解析为 `ReplayTurn[]` 结构
- 每个 turn 包含：userMessage, thinking, toolCalls[], modelResponse

```typescript
interface ReplayTurn {
  index: number
  userMessage: string
  thinking?: string
  toolCalls: Array<{
    name: string
    input: Record<string, unknown>
    output: string
    duration: number
    status: 'passed' | 'failed'
  }>
  modelResponse: string
  timestamp: number
}
```

### Task 2: Replay TUI 组件

创建 `src/tui/replay-view.tsx`（Ink 组件）：
- 接收 `ReplayTurn[]`
- 渲染当前 turn 的完整内容
- 键盘导航（←→ 切换 turn，jk 滚动）
- 搜索功能

### Task 3: CLI 入口

修改 `src/main.tsx`：
- `--replay <session-id>` 参数
- 查找 session 文件 → 解析 → 渲染 replay view
- `--replay list` 列出所有可回放的 session

### Task 4: 摘要视图

在 replay-view 中添加摘要模式（`s` 键切换）：
- 只显示每轮的 tool calls 列表
- 快速浏览整个 session 的行动轨迹

### Task 5: 测试

- session-parser 测试（各种 JSONL 格式）
- replay-view 组件测试（渲染 + 导航）

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/replay/__tests__/session-parser.test.ts
npx tsx --test src/tui/__tests__/replay-view.test.ts
```

## 不做的事

- 不做实时回放（不是视频播放，是静态浏览）
- 不做 session 对比（两个 session 并排对比）— 后续迭代
- 不做 session 编辑（不能修改历史）
- 不做 session 分享（导出为 HTML 等）— 后续迭代
