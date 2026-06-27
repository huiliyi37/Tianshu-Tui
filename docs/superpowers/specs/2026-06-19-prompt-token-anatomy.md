# Prompt Token 构成分析：天枢 vs Claude Code

> 日期：2026-06-19  
> 数据来源：天枢 session `df66c781` 首调 25.7K tokens；Claude Code v2.1.177 (Piebald-AI 2026-06-12 提取)

## 1. 天枢首次调用 ~25.7K tokens 分解

### 1.1 系统提示（Static System Prompt）— ~2.0-2.5K tokens

`src/prompt/static.ts` 中 `BASE_PROMPT` 122 行中文 XML 分段：

| 段落 | 内容 | 估算 tokens |
|------|------|------------|
| `<identity>` | 天枢身份、核心能力、中文回复 | ~200 |
| `<beliefs>` | 异议、风险、模糊回复处理 | ~150 |
| `<stance>` | 推进风格、犯错/被质疑的姿态 | ~150 |
| `<rules>` ×4 | evidence-scope / external-source-verification / self-verification / git-context-first | ~500 |
| `<tool-usage>` | 读写/并行/防循环/扇出范围/路径 | ~350 |
| `<workflow>` | 理解→规划→开发循环→测试 | ~200 |
| `<security>` | 密钥、破坏性命令硬闸门 | ~250 |
| `<shared-worktree>` | 多会话共享、deliver_task 交付 | ~100 |
| `<git>` | 提交规范 | ~50 |
| `<delegation>` | 委派边界、大结果 artifact | ~150 |
| `<output-style>` | 三项交付报告、输出纪律 | ~200 |
| `<calibration>` | 模型校准（DeepSeek/mimo/glm 专属） | ~50 |
| **合计** | | **~2,000-2,500** |

### 1.2 工具定义（Tools JSON Schema）— ~11-15K tokens

**Default registry（24 个）+ Interactive 追加（14 个）= 38 个工具**

Default registry（`src/tools/default-registry.ts`）:

| # | 工具名 | Schema 大小 |
|---|--------|------------|
| 1 | `apply_patch` | 小 |
| 2 | `import_resource` | 中 |
| 3 | `read_file` | **大**（~2.5K chars, 长 description） |
| 4 | `write_file` | 中 |
| 5 | `plan_close` | 小 |
| 6 | `plan_submit` | 中 |
| 7 | `bash` | 中（~550 chars） |
| 8 | `edit_file` | 中 |
| 9 | `hash_edit` | 中 |
| 10 | `grep` | 中（~900 chars） |
| 11 | `glob` | 中 |
| 12 | `diff` | 小 |
| 13 | `run_tests` | 大（~800 chars） |
| 14 | `git` | **大**（多 subcommand） |
| 15 | `todo` | 中 |
| 16 | `web_fetch` | 中 |
| 17 | `inspect_project` | 大 |
| 18 | `repo_map` | 中-大 |
| 19 | `related_tests` | 中 |
| 20 | `read_section` | 中 |
| 21 | `file_info` | 小 |
| 22 | `request_path_access` | 小 |
| 23 | `skill` | 中 |
| 24 | `leave_mark` | 小 |

Interactive 追加（`src/bootstrap.ts`）:

| # | 工具名 | Schema 大小 |
|---|--------|------------|
| 25 | `delegate_task` | **大**（authority enum 含 10 星域 ID） |
| 26 | `undo` | 中 |
| 27 | `delegate_batch` | 大 |
| 28 | `team_orchestrate` | 大 |
| 29 | `council_convene` | 大 |
| 30 | `recall_capsule` | 中 |
| 31 | `ask_user_question` | 小 |
| 32 | `repo_graph` | 中 |
| 33 | `semantic_search` | 中 |
| 34 | `web_search` | 中 |
| 35 | `plan_task` | 大 |
| 36 | `deliver_task` | **大**（~1.5K chars） |
| 37 | `recall` | 中 |
| 38 | `remember` | 中 |

可选 gated（默认关）:

- `desktopTools` +7: create_document / create_spreadsheet / create_image / create_presentation / create_pdf / export_file / open_path
- `browserTool` +1: browser
- LSP +2: goto_definition / find_references

平均每工具 ~300-500 tokens（含 name + description + JSON schema parameters），38 个合计 **~11-15K tokens**。

### 1.3 Frozen Volatile Context — ~3-6K tokens

会话启动时冻结，`src/prompt/volatile.ts` 中 `buildStableVolatileBlock()` 构建：

| 块 | 本仓库估算 | Cap | 说明 |
|----|-----------|-----|------|
| `<environment>` | ~30 tok | - | session 常量（OS/shell/cwd） |
| `<locus>` | ~50 tok | - | cwd 与项目关系 |
| `<project-instructions>` | **2.5-3K tok** | 无 cap | AGENTS.md (~76行) + .rivet.md (~74行) 全文 |
| `<project-memory>` | 0-800 tok | 3K chars | `.rivet/knowledge/memory.jsonl` |
| `<seed-capsule>` | 0-800 tok | 3K chars | 常驻胶囊 + guardrails |
| `<codebase-index>` | 0-1K tok | 4K chars | MeridianDB 索引 |
| `<session-memory>` | 0-200 tok | - | 首轮一般为空 |
| **合计** | **~3-6K** | | |

### 1.4 Dynamic Appendix（首轮）— ~0.5-2K tokens

首轮最少，`buildDynamicAppendix()` 按 salience 排序输出：

| 块 | 首轮估算 | Salience |
|----|---------|----------|
| `<git-status>` | ~200-500 tok | 0.7 |
| `<star-domain>` | ~100-300 tok | 0.8 |
| `<progress>` | ~50-200 tok | 0.6 |
| 其余（tool-history / plan / skills / cross-session） | 0-500 tok | 变化 |
| **合计** | **~0.5-2K** | |

### 1.5 用户消息 — ~50-500 tokens

取决于用户输入长度。

### 1.6 Token 占比

```
工具 definitions    ~11-15K   (45-55%)   ← 最大开销
Frozen volatile     ~3-6K     (15-25%)
Static prompt       ~2-2.5K   (8-10%)
Dynamic appendix    ~0.5-2K   (3-8%)
用户消息            ~0.1-0.5K (1-2%)
─────────────────────────────────────────
合计                ~17-26K
```

## 2. Claude Code 首次调用 ~27-31K tokens 分解

数据来源：Piebald-AI 提取 v2.1.177（2026-06-12）+ 社区实测。

### 2.1 系统提示 — ~2.3-3.6K tokens

110+ 条独立指令片段，按条件组装：

| 类别 | Token 数 | 说明 |
|------|---------|------|
| Task execution | ~600 | 12 条指令，每条 30-100 tok |
| Tool usage policy | ~550 | 优先用内置工具而非 shell |
| Code style / conventions | ~400 | 缩进、注释、格式规范 |
| Safety / security | ~300 | 密钥、破坏性操作 |
| Conditional sections | 0-1,300 | 按 session 配置动态加载 |
| **合计** | **~2,300-3,600** | |

### 2.2 工具定义 — ~14-17.6K tokens

23+ 内置工具，单工具 token 开销明显大于天枢：

| 工具 | Token 数 |
|------|---------|
| TodoWrite | 2,161 |
| TeammateTool | 1,645（仅 team 模式） |
| Bash (git workflow) | 1,558 |
| SendMessageTool | 1,205（仅 team 模式） |
| Agent/Task tool | 931 |
| Read | ~440 |
| Write | ~300 |
| Edit | ~400 |
| Grep | ~350 |
| Glob | ~250 |
| 其他（~15个） | ~5,000-8,000 |
| **合计** | **~14,000-17,600** |

优化手段：**ToolSearch 延迟加载**——低频工具的 description 不随 prompt 发送，模型通过 `ToolSearch` 按需获取。

### 2.3 项目上下文 — ~0.5-5K tokens

| 组件 | Token 数 |
|------|---------|
| CLAUDE.md | 500-5,000（项目级） |
| MEMORY.md | 400-800 |
| 全局 CLAUDE.md | 300-1,000 |
| **合计** | **~500-5,000** |

### 2.4 MCP 工具（可变）

每个 MCP server 增加 **10,000-20,000 tokens**，含完整 schema。

### 2.5 基线实测

```
裸跑（/tmp，无项目配置）:   27,169 tokens
有项目配置:                 30,919 tokens
差值:                        3,750 tokens（CLAUDE.md + memory + skills + MCP）
```

## 3. 对比矩阵

| 维度 | 天枢（Rivet） | Claude Code | 差异 |
|------|-------------|-------------|------|
| 系统提示 | ~2-2.5K（中文 XML） | ~2.3-3.6K（英文片段式） | 天枢略小，CJK tokenize 效率低但文本更短 |
| 工具数 | 38 interactive / 25 headless | 23+（可扩展） | **天枢多 65%** |
| 单工具均值 | ~300-400 tok | ~600-700 tok | Claude 单工具 description 更详细 |
| 工具总 token | ~11-15K | ~14-17.6K | 天枢少 2-5K（schema 更精简） |
| 项目上下文 | ~3-6K（AGENTS.md/index/capsule） | ~0.5-5K（CLAUDE.md/MEMORY.md） | 天枢偏高（project-instructions 无 cap） |
| 首调总计 | **~17-26K** | **~27-31K** | 天枢基线更低 |
| 工具占比 | ~55% | ~55% | 一致——工具是两边最大杠杆 |

## 4. 优化杠杆

按 ROI 排序：

### P0: 工具 schema 精简（潜在节省 3-5K tokens）

- 38 个工具中，`delegate_batch`、`team_orchestrate`、`council_convene` 的 description 包含完整的 authority enum 和使用说明。合并或精简可省 ~2K。
- `read_file` description (~2.5K chars) 是单工具最大开销，可压缩到 ~1K chars 不影响模型理解。
- 参考 Claude Code 的 ToolSearch 模式：低频工具（`leave_mark`、`import_resource`、`request_path_access`、`undo`）的 description 可延迟注入。

### P1: project-instructions cap（潜在节省 1-2K tokens）

- `<project-instructions>` 当前无 cap，AGENTS.md + .rivet.md 全文注入 ~2.5-3K tokens。
- 增加 **8K chars cap**（~2K tokens），超限时只保留关键段落。或引入摘要机制。

### P2: Headless 模式工具裁剪

- Headless（`src/main.ts`）仅需 default 25 工具 + `deliver_task`，已比 interactive 省 ~5K。
- Worker profile 可按 `toolWhitelist` 进一步裁剪（当前已实现）。

### P3: 工具分级注册（ToolSearch 模式）

- 仿 Claude Code 实现延迟工具发现：核心工具（read/write/edit/bash/grep/glob/git/run_tests）常驻，其余通过 `discover_tool` 按需加载。
- 估算：核心 15 工具 ~5K tokens，省去 23 个非核心工具 ~7K tokens。代价是模型需多一次调用才能使用低频工具。

## 5. 运行时诊断命令

天枢内置诊断：

| 命令 | 输出 |
|------|------|
| `/debug prompt` | system prompt 字符数 + 工具名列表 |
| `/debug context-payload` | volatile 各段 chars/tokens 分段报告 |
| `/debug fingerprint` | system/tools/stableVolatile SHA256 |
| `/debug cache` | API prompt_tokens vs 本地 estimate |

Claude Code 内置：

| 命令 | 输出 |
|------|------|
| `/context` | 各组件 token 使用量 |
| `/cost` | 累计费用和 token 统计 |

## 6. Token 估算逻辑差异

| 维度 | 天枢 | Claude Code |
|------|------|-------------|
| 估算方法 | 统一 `chars/4`（`CHARS_PER_TOKEN = 4`，未区分 CJK，导致中文场景低估 ~40%） | Anthropic tokenizer 精确计数 |
| UI 开销预估 | `sysTokens + toolCount×50 + 400`（**低估 5-8K**） | 精确计数 |
| 压缩阈值 | 基于低估的 overhead → 可能延迟压缩 | 基于精确计数 |
| prefix fingerprint | `SHA256(system + tools + stableVolatile)` 三元组 | cache_control 标记 |

> **勘误（2026-06-19 审查）**: 原文描述 "chars/4（ASCII）、chars/1.5（CJK）" 不准确。
> 代码实际只用 `CHARS_PER_TOKEN = 4`（见 `src/compact/context-collapse.ts` L19），
> 未对 CJK 做区分。这意味着 CJK 密集的 prompt（如本项目 static.ts）的 token
> 估算偏低约 40%，是压缩阈值延迟触发的一个已知偏差来源。
