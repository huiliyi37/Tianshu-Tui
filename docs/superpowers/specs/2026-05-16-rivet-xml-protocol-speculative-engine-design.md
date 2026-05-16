# Rivet XML Protocol Layer + Speculative Pre-warming 设计

## 背景

用户目标：提升 Rivet TUI 终端模型开发能力，不降级于 Claude Code；利用 97% cache hit rate 差异化；将 XML 结构化嵌入底层架构，用 XML 给模型分区、识别边界、做协议化执行。

核心洞察（用户原话）：Markdown 适合给人读，XML 适合给模型分区、识别边界、做协议化执行。

当前 Rivet prompt 架构：
- System prompt (`static.ts`)：纯 Markdown，~1200 tokens，frozen per-session
- Volatile context (`volatile.ts`)：已经是 XML（`<context>`, `<environment>`, `<project-instructions>`, `<git-status>`, `<working-set>`, `<context-ledger>`）
- Tool definitions：Anthropic-style JSON schema，独立于 system prompt
- System prompt 中有重复的 tool summary（浪费 ~150 tokens）
- Fingerprint：SHA-256 of system prompt + tools，format-agnostic
- Cache hit rate：~97%（DeepSeek V4 prefix cache）

参考项目：
- TencentDB-Agent-Memory：分层记忆（L0-L3）+ 符号化短期记忆 + offload 模式
- Claude Code：XML sections（`<identity>` / `<rules>` / `<capabilities>` / `<response_style>`）
- Anthropic 官方推荐：XML tags 清晰分隔 prompt 的不同部分

---

## 设计哲学："XML 不是格式升级，是自动化基础设施"

XML 的价值不在于"模型更喜欢 XML"（DeepSeek 无特殊偏好），而在于：

1. **Section boundary 使自动化成为可能** — 当 prompt 有明确的 XML section 时，agent 可以做 section-level diff、intent extraction、speculative pre-warming
2. **协议化使跨模型兼容成为可能** — 同一 XML prompt 可以被 DeepSeek/Claude/Qwen 消费
3. **结构化使智能编排成为可能** — XML 属性携带元数据（salience、type、status），agent 可以基于属性做路由决策

---

## 调研发现摘要

### XML Prompt 工程

- Anthropic 官方推荐 XML 做 prompt 分区，Claude Code 实际使用 XML sections
- DeepSeek 对 XML 无特殊偏好，但"清晰 section boundary"确实有效
- Token 开销 ~3-8%，在 cached prefix 中被摊销
- 最优排序：identity → rules → capabilities → tools → [cache breakpoint] → dynamic context
- 嵌套限制 2 层

### Agent 编排模式

- 并行执行可减少 40-70% 延迟
- 投机预热可减少 25-40% 延迟
- Token-budget circuit breaker 防止 retry storm
- 子代理委托避免 context 膨胀
- 五层 compaction pipeline 支持 100+ turn sessions

### Rivet Prompt 现状

- System prompt 已 frozen per-session，97% cache hit
- Volatile context 已经是 XML
- 重复的 tool summary 浪费 ~150 tokens
- XML 重构不会显著提升 cache rate（已经 97%）
- 主要收益在跨模型兼容和 agent 侧自动化

### TencentDB-Agent-Memory

- 分层记忆：L0 对话 → L1 原子 → L2 场景 → L3 人格
- 符号化短期记忆（compact task canvas in-context）
- Offload 模式：raw logs 推出 context，符号引用留在 context
- 结构化分层比具体格式更重要

---

## 推荐方案

### 总体架构变化

```text
Before:
  System Prompt (Markdown, ~1200 tok)
    → frozen per-session
    → DeepSeek prefix cache (97% hit)
    → Text output → regex parse tool calls

After:
  System Prompt (XML sections, ~1250 tok)
    → frozen per-session
    → DeepSeek prefix cache (97%+ hit)
    → Text output → Intent Extraction → Speculative Pre-warm
                                            ↓
  Volatile Context (XML, enhanced)     PhaseTracker → Pre-read files
    → <tool-summary> wrapped             → Cache warm for next tool call
    → <compact-event> structured
    → <memory> with salience attributes
```

### XML System Prompt 结构

```xml
<identity>
你是「天枢」，一个拥有想象力与创造力的代码开发智能体。你的任务不是机械补全代码，
而是在理解用户意图、项目上下文与工程约束的基础上，主动设计更合理的架构、
发现隐藏风险、修复根因问题，并输出清晰、稳定、可维护、可扩展的实现方案。
</identity>

<rules>
  <rule name="verify-first">
  Before writing any code: check design docs, read existing code, search before creating.
  If a design doc says "Phase 1 must be read-only", do not add write capabilities.
  </rule>

  <rule name="before-implementing">
  Read relevant design/plan docs. Check .rivet.md. Use grep to find existing patterns.
  If a plan says "Phase 1 only does X", do exactly X.
  </rule>
</rules>

<tool-usage>
  <file-operations>
  read_file: inspect code before editing. Use offset/limit for long files.
  edit_file: targeted search-and-replace. Only if old_string is unique.
  write_file: new files or complete rewrites only.
  Never use Bash to read, write, search, or edit files.
  </file-operations>

  <shell>
  For build, test, git, npm, and system commands.
  Quote paths containing spaces. Prefer absolute paths.
  Never skip git hooks unless explicitly asked.
  </shell>

  <navigation>
  inspect_project → repo_map → glob → grep (progressive discovery)
  </navigation>
</tool-usage>

<workflow>
  <development-loop>
  1. Read relevant files and design docs before editing.
  2. Edit, then check with diff.
  3. Run typecheck + tests. Read failures before retrying.
  4. If a test was already failing before your change, note it.
  5. If a test you wrote fails, diagnose root cause.
  </development-loop>

  <tdd>
  When adding new functionality, write tests first.
  Tests use node:test + node:assert/strict.
  Test files: src/agent/foo.ts → src/agent/__tests__/foo.test.ts
  </tdd>
</workflow>

<security>
Never expose API keys, tokens, or secrets.
Validate file paths stay within the project directory.
Confirm before destructive commands.
</security>

<git>
Create new commits. Never amend. Format: feat/fix/refactor/docs/test/chore/perf.
Never force push to main/master. Check git status before committing.
</git>
```

### Volatile Context XML 增强

当前已有的 XML 保持不变，新增：

```xml
<context>
  <environment platform="darwin" cwd="/path" os="Darwin 25.4.0" />

  <project-instructions>
  ...rivet.md content...
  </project-instructions>

  <git-status>
  ...git status...
  </git-status>

  <working-set>
    <file>src/auth/middleware.ts</file>
  </working-set>

  <context-ledger health="healthy" api_safe="true" tokens="45000" max_tokens="128000" rounds="7" />

  <!-- NEW: structured tool summaries from microcompact -->
  <tool-history recent="3">
    <tool-summary tool="edit_file" target="src/auth.ts" status="success" tokens-saved="1200" />
    <tool-summary tool="run_tests" target="auth.test.ts" status="failed" error="timeout" />
    <tool-summary tool="bash" target="npm run typecheck" status="success" />
  </tool-history>

  <!-- NEW: compact event notification -->
  <compact-event tier="1" before-tokens="180000" after-tokens="45000" preserved="current-task,test-results" />

  <!-- NEW: session memory with salience -->
  <session-memory>
    <entry type="decision" salience="high">Chose middleware pattern over decorator for auth</entry>
    <entry type="error" salience="high">jest timeout on CI — use --forceExit flag</entry>
  </session-memory>
</context>
```

### 投机预热引擎

```text
Streaming Output → Intent Extractor → Pre-warm Cache
                                          ↓
                                    PhaseTracker
                                          ↓
                              ┌─────────────────────────┐
                              │ Phase-based pre-warming: │
                              │ coding → pre-read tests  │
                              │ testing → pre-parse output│
                              │ searching → warm grep idx │
                              └─────────────────────────┘
```

**Intent 提取规则**（从 streaming text 中 regex）：

| Pattern | Action |
|---------|--------|
| 文件路径 (`src/...`, `./...`) | 预读文件到内存缓存 |
| `npm test` / `run_tests` | 预解析 test framework |
| `git diff` / `git status` | 预执行 git 命令缓存结果 |
| `typecheck` / `tsc` | 预运行 tsc --noEmit |

**预热缓存生命周期**：
- 创建：intent 提取时
- 使用：下一个 tool call 命中时（跳过实际执行，直接返回缓存）
- 过期：30 秒未使用 或 文件被修改

---

## 与已有设计的关系

| 已有设计 | 本方案关系 |
|---------|-----------|
| Progressive Context Engine | XML `<tool-history>` 和 `<compact-event>` 是 ContextLedger 的 TUI 可见形态 |
| Glanceable Cockpit | PhaseTracker 同时驱动 SummaryBar 和投机预热 |
| Subagent Orchestration | XML 协议层为 work order 提供结构化格式 |
| P2.3 Harness Cockpit | CockpitState 可以从 XML volatile context 中直接提取数据 |

---

## 风险与应对

### 风险 1：DeepSeek 对 XML system prompt 响应质量下降

应对：
- Phase 1 做 A/B 测试：同一任务用 Markdown vs XML prompt，对比工具误用率
- 如果 XML 版本明显差，保留 Markdown 作为 DeepSeek 的 default
- XML 版本作为 Claude/Qwen 的 default

### 风险 2：投机预热命中率低

应对：
- 从高确定性场景开始（PhaseTracker 阶段转换）
- 监控命中率，< 30% 时降级为只在明确场景预热
- 预热是 best-effort，不影响正常执行路径

### 风险 3：XML token 开销

应对：
- System prompt XML 化增加 ~50-80 tokens（< 5%）
- `<tool-history>` 替代原有的纯文本 tool result summary，token 数相当
- 所有 XML 在 cached prefix 中，开销被摊销

### 风险 4：跨模型兼容性

应对：
- Phase 4 专门验证 Claude + Qwen
- Provider 抽象层可以 per-model 选择 prompt template
- XML 是最大公约数格式（所有主流模型都能消费）

---

## 规格自检

- **占位符检查**：无 TODO、待定
- **内部一致性**：XML 结构、投机预热、PhaseTracker 三者互相配合
- **范围检查**：聚焦 prompt 架构 + 投机预热，不涉及 TUI 重构或 agent loop 核心逻辑
- **模糊性检查**：XML schema 有精确示例；投机预热有明确的 pattern→action 映射；退出条件有量化指标

---

## 下一步

创建实施计划，按 Phase 1-4 拆分：
1. Phase 1：XML 化 System Prompt + 去重（3 天）
2. Phase 2：Volatile Context XML 增强（1 周）
3. Phase 3：投机预热引擎（1-2 周）
4. Phase 4：跨模型兼容验证（1 周）
