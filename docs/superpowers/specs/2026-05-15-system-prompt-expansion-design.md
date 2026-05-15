# Rivet System Prompt 架构优化

**日期**: 2026-05-15
**基于**: deep-brainstorm 三轮分析 + 3 路并行 Scout 调研
**状态**: Phase 1 已实施

---

## 一、核心发现

### Scout 1: Claude Code prompts.ts
- 结构: 多个独立 section（intro → doing tasks → actions → tools → tone → output）
- 使用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分隔缓存/动态内容
- 采用 "policy bullets + embedded examples" 模式，不是 multi-shot
- 最大块: Doing tasks (~25%), Using tools (~18%), Dynamic sections (~20%)

### Scout 2: Claude Code Tool Prompt Sizes
- BashTool: ~5,000 tokens（git protocol、sandbox、quoting）
- FileReadTool: ~800 tokens（offset/limit、image support）
- FileEditTool: ~650 tokens（old_string 唯一性、indentation）
- 格式: 简短描述 → IMPORTANT 警告 → Usage/Instructions 规则 → 嵌入式示例

### Scout 3: DeepSeek API Cache Behavior
- **cache_control: ephemeral 被忽略** — DeepSeek /anthropic 端点不处理此字段
- 最小缓存阈值: 64 tokens
- Token 级别前缀匹配（非字节级）
- System prompt 作为前缀缓存的一部分（非独立缓存层）

## 二、架构决策

### 选定方案: V2(示例驱动) + V4(分层组织) 组合

灭绝:
- V3(中文特化): 因果链断裂 — DeepSeek V4 英文训练数据远多于中文
- V1(渐进): 纯规则无示例 — 对 tool_use 准确率提升有限

### 最终架构

```
system prompt (分层组装, ~2000+ tokens):
├── Layer 0: static.ts BASE_PROMPT (~800 tokens)
│   ├── 身份 + 环境
│   ├── Core Behavior (4 rules)
│   ├── Code References (file_path:line_number)
│   ├── File Operations (with tool priority)
│   ├── Shell Commands (IMPORTANT warning)
│   ├── Search Strategy
│   ├── Output Rules
│   ├── Security
│   └── Git Protocol
│
├── Layer 1: tool_prompts/ (~3000 tokens, 按需注入)
│   ├── bash.md: IMPORTANT 警告 + Usage + Git Protocol + Examples
│   ├── read.md: 绝对路径要求 + offset/limit + 截断说明
│   ├── write.md: edit_file 优先 + 父目录创建
│   └── edit.md: 先读后改 + old_string 唯一性
│
└── Volatile (注入 user message, 不在 system 中)
    └── git status + .rivet.md + working set
```

### 关键修正: volatile 注入方式

DeepSeek 忽略 cache_control → volatile 不能放 system block。
修正: volatile 作为独立 user message 注入在每个 user input 之前。

```
Turn 1: [system, user(<context>), user("hello")]
Turn 2: [system, user(<context>), user("hello"), assistant, user(<context>), user("read")]
```

前缀结构完全一致 → 缓存命中区间最大化。

## 三、实施结果

### 已修改

| 文件 | 变更 | 大小 |
|------|------|------|
| `src/prompt/static.ts` | BASE_PROMPT 从 ~200 → ~800 tokens | ~2800 B |
| `src/prompt/engine.ts` | system 从 SystemBlock[] → 纯 string; volatile 注入改为独立 user msg | — |
| `prompts/tools/bash.md` | 新增: Bash 工具 prompt | 1180 B |
| `prompts/tools/read.md` | 新增: Read 工具 prompt | 715 B |
| `prompts/tools/write.md` | 新增: Write 工具 prompt | 566 B |
| `prompts/tools/edit.md` | 新增: Edit 工具 prompt | 588 B |

### System Prompt 指标

| 指标 | 优化前 | 优化后 | 倍数 |
|------|--------|--------|------|
| System prompt 文本 | ~200 tokens | ~800 tokens | 4x |
| Tool prompts (文件) | 0 | ~3000 tokens | — |
| 缓存锚点总计 | ~350 tokens | ~800 tokens (可扩至 4000+) | 2.3x+ |
| 规则数量 | 4 条 | 8 sections, 20+ rules | 5x |
| 示例数量 | 0 | 8 (embedded) | — |

### 验证

- 32/32 测试通过
- TypeScript strict: 0 errors
- tsup build: 成功
- 指纹测试: 13/13（SHA-256 指纹不变 = 缓存一致性保持）

## 四、下一步

### Phase 2: Tool prompt 集成
- 将 prompts/tools/*.md 注入到 tool definitions 的 description 中
- 修改 ToolRegistry 加载 per-tool prompt 文本

### Phase 3: 完整分层 + Mode System
- base → personality → mode(code/ask/plan) → approval → tools
- 每个 mode 有独立的 tool 可用集合和规则覆盖
