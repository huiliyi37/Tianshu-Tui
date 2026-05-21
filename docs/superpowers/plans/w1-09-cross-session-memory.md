# Wave 1 补充：天枢记忆系统设计

> 对标：Claude Code `/memory` 命令
> 定位：天枢独有的三层记忆架构

## Claude Code 的 /memory 做了什么

Claude Code 的记忆很简单：
- 用户说 `/memory`，模型把当前对话中的关键信息写入 `~/.claude/CLAUDE.md`
- 下次启动时自动加载
- 本质是：**模型主动写入 + 自动注入 system prompt**

## 天枢已有的记忆机制

天枢已经有三层记忆，但它们是分散的、对用户不可见的：

| 层 | 机制 | 存储 | 生命周期 | 用户可见 |
|----|------|------|----------|----------|
| 短期 | session-memory | `~/.rivet/sessions/<id>.memory.json` | 单 session | ✗ |
| 中期 | stigmergy (信息素) | `.rivet/pheromones.json` | 7-14 天半衰期 | ✗ |
| 长期 | dream (知识蒸馏) | `.rivet/knowledge/*.md` | 永久（8KB 上限） | ✗ |

问题：**用户不知道天枢记住了什么，也无法主动管理记忆。**

## 设计：统一记忆接口

### 核心理念

天枢的记忆不是"模型写笔记"——它是**认知沉淀**。三层记忆对应三种认知过程：

```
短期（session-memory）= 工作记忆 — 当前任务的上下文
中期（stigmergy）     = 肌肉记忆 — 文件级的经验直觉
长期（knowledge）     = 叙事记忆 — 项目级的知识和教训
```

### 用户接口

#### `/memory` — 查看记忆全景

```
╭─ 天枢记忆 ─────────────────────────────────────╮
│                                                  │
│  📝 当前 session (3 条)                          │
│    • "用户偏好 TypeScript strict mode"           │
│    • "当前任务：实现 chat mode"                   │
│    • "已确认：不做自动模式检测"                   │
│                                                  │
│  🧠 项目直觉 (5 个文件)                          │
│    src/agent/loop.ts        ⚠ fragile (0.7)     │
│    src/prompt/engine.ts     ✓ tested (0.9)      │
│    src/tools/bash.ts        ⚡ perf-critical     │
│                                                  │
│  📚 项目知识 (4 篇)                              │
│    agent.md    — agent loop 相关经验             │
│    prompt.md   — prompt 工程经验                 │
│    testing.md  — 测试相关经验                    │
│    ui.md       — TUI 渲染经验                    │
│                                                  │
│  命令: /memory add | /memory forget | /memory save │
╰──────────────────────────────────────────────────╯
```

#### `/memory save` — 模型主动沉淀（类似 Claude /memory）

模型在对话中发现重要信息时，可以主动调用（或用户触发）：

```
/memory save
```

触发模型回顾当前对话，提取值得记住的信息，写入对应层：
- 用户偏好 → session-memory（短期）
- 文件经验 → stigmergy（中期）
- 项目教训 → knowledge（长期）

#### `/memory add <内容>` — 用户手动添加

```
/memory add "这个项目不用 class，只用 interface + plain objects"
```

写入 knowledge 层（永久）。

#### `/memory forget <id>` — 删除记忆

```
/memory forget src/agent/loop.ts fragile
```

从 stigmergy 中删除指定信号。

#### `/memory search <query>` — 搜索记忆

```
/memory search "bash"
```

跨三层搜索，返回匹配的记忆条目。

### 模型自动记忆（核心差异）

Claude Code 需要用户主动 `/memory`。天枢的 dream 机制已经在 session 结束时自动蒸馏知识。

扩展：**模型在对话中也可以主动记忆**。

新增工具 `remember`：

```typescript
{
  name: 'remember',
  description: '将重要信息保存到项目记忆中。当你发现用户偏好、项目约定、或重要教训时使用。',
  input: {
    text: string,        // 要记住的内容
    layer: 'session' | 'project' | 'knowledge',
    file?: string,       // 如果与特定文件相关
  }
}
```

模型可以在任何时候调用 `remember`，不需要用户触发。这是天枢与 Claude Code 的核心区别：**记忆是主动的、持续的，不是被动的、一次性的。**

### 记忆注入策略

| 层 | 注入位置 | 注入条件 |
|----|----------|----------|
| session-memory | volatile stable block | 每轮都注入（当前行为） |
| stigmergy | sensorium.freshness 维度 | 间接影响 cognitive mirror |
| knowledge | volatile stable block | 每轮注入相关条目（通过 recall 搜索） |

**优化**：knowledge 层不全量注入。只注入与当前任务相关的条目（基于文件名匹配 + 关键词匹配）。

### 记忆容量管理

| 层 | 上限 | 淘汰策略 |
|----|------|----------|
| session-memory | 50 条 | FIFO（已实现） |
| stigmergy | 无硬上限 | 指数衰减（7-14 天半衰期） |
| knowledge | 8KB/文件 | 按条目边界截断（已实现） |

## 实现计划

### Task 1: remember 工具

创建 `src/tools/remember.ts`：
- 接收 text + layer + file
- session → appendSessionMemory
- project → stigmergy.deposit（需要映射 text 到 signal type）
- knowledge → 直接追加到 `.rivet/knowledge/user-notes.md`

### Task 2: /memory 命令族

修改 `src/tui/slash-commands.ts`：
- `/memory` — 渲染三层记忆面板
- `/memory save` — 触发模型回顾 + 自动提取
- `/memory add <text>` — 手动写入 knowledge
- `/memory forget <file> <signal>` — 删除 stigmergy 信号
- `/memory search <query>` — 跨层搜索

### Task 3: 记忆面板组件

创建 `src/tui/memory-panel.tsx`：
- 三层分组显示
- session-memory：最近 5 条
- stigmergy：按文件分组，显示活跃信号
- knowledge：列出文件名 + 首行摘要

### Task 4: 智能注入优化

修改 `src/prompt/volatile.ts`：
- knowledge 层不全量注入
- 基于当前 working-set 中的文件名，匹配相关 knowledge 条目
- 最多注入 3 条相关知识（控制 token）

### Task 5: 测试

- remember 工具测试（三层写入）
- /memory 命令测试
- 智能注入测试（相关性匹配）

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/tools/__tests__/remember.test.ts
npx tsx --test src/tui/__tests__/memory-panel.test.ts
```

## 与 Claude Code /memory 的区别

| 维度 | Claude Code | 天枢 |
|------|-------------|------|
| 触发方式 | 用户手动 `/memory` | 模型主动 + 用户手动 + session 结束自动 |
| 存储层级 | 单层（CLAUDE.md） | 三层（session/stigmergy/knowledge） |
| 生命周期 | 永久（手动删除） | 分层衰减（短期自动淘汰，长期永久） |
| 注入方式 | 全量注入 system prompt | 智能匹配，只注入相关条目 |
| 文件级记忆 | 无 | 有（stigmergy 标记文件属性） |
| 自动蒸馏 | 无 | 有（dream 机制，session 结束时提取） |

## 不做的事

- 不做跨项目记忆共享（每个项目独立）
- 不做记忆导入/导出（后续迭代）
- 不做记忆冲突解决（多 session 同时写入时 last-write-wins）
- 不做 LLM 驱动的记忆摘要（Phase 1 用模板，Phase 2 升级）
