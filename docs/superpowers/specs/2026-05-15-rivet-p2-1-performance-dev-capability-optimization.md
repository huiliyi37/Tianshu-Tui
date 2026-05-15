# P2.1：Rivet 性能层与开发能力层优化建议

## 背景

前一份方向文档将 Rivet 的差异化定位收敛为 **Trust Cockpit + Open Model Capability Lab**。这能解决“为什么用户选择 Rivet”的问题，但还不足以保证 Rivet 在真实开发任务中不弱于 Claude Code、opencode 等主流工具。

P2.1 这份文档补充两条硬主线：

1. **性能层：** 让终端交互、长上下文、工具流、缓存成本和失败恢复足够稳定。
2. **开发能力层：** 让模型真的能更可靠地理解 repo、修改代码、运行测试、诊断失败并安全回滚。

核心判断：

> 差异化设计必须建立在真实开发能力和稳定性能之上。否则 Trust Cockpit 会变成漂亮外壳，而不是能力放大器。

---

## P2.1 总目标

Rivet 在 P2.1 阶段要达到三类可感知结果：

1. **输入不卡：** 用户输入、流式输出、thinking、工具 stdout/stderr、状态栏刷新互不拖累。
2. **上下文不浪费：** prefix cache 稳定，token accounting 增量化，工具输出不会污染长会话。
3. **开发闭环可靠：** 能找上下文、能小步编辑、能跑测试、能解释失败、能回滚、能说明哪些结果已验证。

---

# 一、性能层优化建议

## 1. 建立性能基线

不要只凭主观体感优化。建议新增固定 perf smoke 测试，用于每次重要修改后比较。

### 建议指标

| 指标 | 建议目标 |
|---|---|
| TUI 输入延迟 | p95 < 50ms |
| 首 token 时间 | 拆分 API latency / prompt build / network |
| streaming 渲染频率 | 控制在约 20fps，不按 token 数无限重绘 |
| thinking 渲染频率 | 低于正文，折叠时不持续渲染全部内容 |
| 工具输出更新频率 | stdout/stderr chunk 批处理，不逐 chunk 重绘 |
| prompt build 时间 | 长会话下不随消息数线性恶化 |
| token 估算时间 | 新增消息 O(1)，compact/replace 时才重算 |
| cache hit rate | 长期可见，可解释 cache miss 原因 |
| compaction 耗时 | smart compact / micro compact 两级兜底 |
| abort 响应时间 | Ctrl+C 后 < 200ms 停止本地等待和网络 retry sleep |

### 建议任务集

新增一个轻量脚本，例如 `scripts/perf-smoke.ts` 或后续 CLI 命令 `rivet bench`，固定覆盖：

- 短回复任务
- 长 streaming 输出任务
- 高频 thinking delta 任务
- 大 stdout/stderr 工具任务
- 多工具调用任务
- 100+ 消息长会话任务
- Ctrl+C 中断恢复任务

成功标准不是一次跑得快，而是每次优化后能比较趋势。

---

## 2. 消除 event loop 阻塞

性能层最优先原则：

> 所有非必要信息都允许 stale，但不能阻塞输入。

### 需要迁移到后台或缓存的工作

- git branch / git status
- repo map refresh
- session checkpoint
- token accounting 重算
- compaction
- history load / append
- large file summarize
- benchmark / diagnostics

### 目标行为

用户输入路径只做轻量状态更新。git status、repo index、cache diagnostics 等信息可以先显示旧值，再后台刷新。

建议 volatile context 使用 stale cache：

- 首次显示旧值或 checking 状态。
- 后台刷新 git 状态。
- 缓存 1-3 秒。
- git 慢或失败时继续使用旧值。
- 不因为 volatile context 采集失败而阻塞用户请求。

---

## 3. TUI 渲染分层

避免 token、thinking delta、stdout chunk 触发整个 App 高频重绘。

建议拆成五个刷新层：

1. **Input layer**
   - 最高优先级。
   - 永远不被 streaming、tool output、status 刷新拖慢。

2. **Streaming text layer**
   - 30-50ms flush 一次。
   - 只渲染当前可见文本，不每个 token setState。

3. **Thinking layer**
   - 100-200ms flush 一次。
   - 折叠时只更新摘要和计数，不持续渲染全部 reasoning 文本。

4. **Tool output layer**
   - stdout/stderr 先进 buffer。
   - UI 只显示摘要、最后 N 行、运行时间、退出码、truncated marker。

5. **Status layer**
   - cache hit、token、cost、model、branch 等 500-1000ms 刷新一次即可。

核心原则：

> TUI 默认显示状态摘要，而不是全部数据。

---

## 4. 工具输出管线三层化

工具输出是最容易拖垮 TUI 和上下文质量的来源。建议引入统一的 Tool Output Store。

### 三层表示

1. **Raw output**
   - 完整 stdout/stderr。
   - 写入 session/log 或临时文件。
   - 用于用户展开、debug、失败样本。

2. **Model output**
   - 给模型看的压缩版。
   - 包含 command、exit code、耗时、前 N 行、后 N 行、关键错误摘要。
   - 防止大输出污染上下文。

3. **UI output**
   - 给用户看的摘要版。
   - 默认只显示状态、最后 N 行和截断提示。
   - 用户需要时再展开。

### 预期收益

- TUI 不被大输出刷爆。
- 模型上下文更干净。
- 长会话成本下降。
- 失败时仍可追溯完整输出。

---

## 5. Prefix cache 稳定性强化

Rivet 的性能护城河应继续围绕 DeepSeek V4 prefix cache 和长上下文成本控制。

建议将 prompt 明确分成四层：

```text
L1 Frozen System Prompt
  长期不变，最大化 prefix cache

L2 Stable Tool Definitions
  工具名、description、schema 稳定排序
  fingerprint 完整检测

L3 Session Summary / Project Memory
  低频变化，可压缩

L4 Volatile Context
  git status、cwd、dirty files、date
  单独 user message 注入，不污染 prefix
```

### 重点优化

- tool definitions 稳定排序。
- fingerprint hash 不只包含 tool name，还包含 description + schema。
- volatile context 不进入 system prompt。
- prompt build 输出可解释 cache miss 原因。
- 新增 debug 命令：
  - `rivet debug prompt`
  - `rivet debug fingerprint`
  - `rivet debug cache`

---

## 6. Token accounting 增量化

长会话下不要每轮全量扫描 messages。

建议 `SessionContext` 内维护：

```text
estimatedInputTokens
estimatedOutputTokens
estimatedToolTokens
estimatedSummaryTokens
```

新增消息时增量加，`replaceMessages()` / compact 后再重算一次。

### 预期收益

- auto compact 判断 O(1)。
- status bar 不扫全历史。
- cost estimate 更稳定。
- 长会话不会越聊越慢。

---

## 7. Compaction 分层

不要只做一种“旧消息总结”。开发代理需要按内容类型 compact。

### 建议四层 compaction

1. **Micro compact**
   - 本地截断旧工具输出。
   - 不调用模型。
   - 快速兜底。

2. **Tool-result compact**
   - 专门压缩工具输出。
   - 保留 command、exit code、关键错误、文件路径。

3. **Semantic session compact**
   - 用模型总结旧对话。
   - 保留用户目标、已改文件、测试结果、未解决问题。

4. **Checkpoint compact**
   - 与 diff / session checkpoint 绑定。
   - 总结从 checkpoint A 到 B 做了什么。

---

## 8. Repo index 缓存

性能层和开发能力层在 repo index 上交叉。

建议新增本地索引目录：

```text
.rivet/index/
  files.json
  symbols.json
  imports.json
  tests.json
  scripts.json
  git-status-cache.json
```

### 索引内容

- 文件列表
- package scripts
- 入口文件
- exports/imports
- test files
- symbol name → file path
- file → related tests
- git ignored files
- 最近修改文件

### 更新策略

- 启动时快速加载旧 index。
- 后台根据 git diff / mtime 增量更新。
- 用户输入时使用旧 index，不等待更新完成。

---

# 二、开发能力层优化建议

## 1. 建立开发能力基线矩阵

要证明“不弱于 Claude Code / opencode”，需要先定义可比较能力。

| 能力 | 最小标准 |
|---|---|
| 单文件 bugfix | 能定位、修改、运行相关测试 |
| 多文件 refactor | 能追踪 imports / callers / tests |
| 测试修复 | 能读失败输出，优先改实现，不乱改测试 |
| 工具调用 | tool_use JSON 稳定，失败可恢复 |
| 长会话 | compact 后不丢目标、已改文件和测试状态 |
| 中断恢复 | Ctrl+C 后 session 可继续 |
| 大输出处理 | 不污染上下文，不刷爆 TUI |
| 多模型适配 | 能说明 provider/model 失败在哪里 |
| 安全编辑 | diff 可见，危险命令审批，有 rollback |
| 最终报告 | 区分已完成、已验证、未验证、风险 |

### 建议任务集

```text
tasks/
  bugfix-small
  bugfix-cross-file
  refactor-symbol
  add-test
  fix-failing-test
  update-cli-command
  handle-large-output
  recover-after-abort
  compact-long-session
```

这些任务可以同时作为 benchmark、回归测试和开源传播材料。

---

## 2. Repo understanding 能力

主流编码代理强，很大一部分来自“找上下文”的能力，而不是单次生成能力。

### P2.1 最小目标

1. **Repo map**
   - 文件树摘要
   - 入口点
   - package scripts
   - 测试结构
   - 配置文件

2. **Symbol search**
   - function / class / type 名称索引
   - import / export 关系
   - callers / callees 粗略图

3. **Related tests**
   - `src/foo.ts` → `src/foo.test.ts`
   - `src/foo.ts` → `__tests__/foo.test.ts`
   - package script 推断

4. **Recent work context**
   - git diff
   - untracked files
   - recent commits
   - user touched files

第一阶段先用 ripgrep + 文件命名规则 + package heuristics。后续再接 Tree-sitter 或 LSP。

---

## 3. 工具体系补齐

不要让模型过度依赖 bash 拼命搜索。结构化工具能显著提高开源模型稳定性。

### 建议新增工具

#### `list_files` / `glob`

- 支持 gitignore。
- 限制结果数量。
- 返回结构化路径。
- 避免模型用 bash `find` 全盘扫。

#### `search`

- 支持 regex / literal。
- 支持 include / exclude path。
- 返回 `file:line`。
- 默认跳过 lockfile、dist、node_modules。

#### `diff`

- staged diff。
- unstaged diff。
- per-file diff。
- summary diff。

#### `apply_patch` / `multi_edit`

- 原子应用。
- dry-run。
- 冲突报告。
- diff preview。

#### `run_tests`

- 自动识别 package manager。
- 支持 targeted test。
- timeout。
- 输出截断。
- failure summary。

#### `inspect_project`

返回项目摘要：

- language
- package manager
- scripts
- build command
- test command
- entry files
- framework hints

---

## 4. 计划-执行-验证分离

为了提升开发可靠性，Rivet 应内置轻量状态机，而不是让一个 agent 一路胡跑。

```text
request
  → understand
  → plan
  → execute
  → verify
  → report evidence
```

### 三种内部模式

1. **Plan mode**
   - 只读文件。
   - 产出计划。
   - 不编辑。

2. **Code mode**
   - 执行计划。
   - 每步小 diff。
   - 遇到范围扩大要停下。

3. **Verify mode**
   - 跑测试。
   - 查 diff。
   - 查遗漏。
   - 不自我批准。

最终回答必须区分：

- 已完成
- 已测试
- 未测试
- 风险
- 后续建议

---

## 5. 测试失败诊断能力

开发能力的关键不是“会跑测试”，而是测试失败后不乱改。

建议实现 failure classifier：

```text
test failure
  ├─ TypeScript type error
  ├─ assertion mismatch
  ├─ missing dependency
  ├─ timeout
  ├─ snapshot mismatch
  ├─ module resolution
  ├─ environment missing
  └─ flaky / external
```

### 每类失败的处理策略

- **TypeScript type error：** 优先修类型，不改业务逻辑。
- **Assertion mismatch：** 先判断测试期望错还是实现错。
- **Missing dependency：** 报告依赖问题，不静默换测试命令。
- **Timeout：** 查死循环、未结束异步或长任务阻塞。
- **Environment missing：** 标记阻塞，不伪造测试通过。
- **Flaky / external：** 保留证据，避免把不稳定外部依赖当作代码 bug。

---

## 6. 编辑引擎增强

开发代理常见失败点是 edit 不稳定。P2.1 应增强编辑可靠性。

### 建议能力

1. **精确编辑**
   - old_string 唯一性检查。
   - surrounding context。
   - 找不到时提示相似片段。

2. **结构化编辑**
   - insert import。
   - update export。
   - rename symbol。
   - add test case。
   - update config field。

3. **Patch preview**
   - 应用前展示 diff。
   - 大范围改动要求确认。

4. **Post-edit verification**
   - TS/TSX 文件改后检查 parse/typecheck。
   - 测试文件改后推荐 targeted test。

后续可以接 LSP：find references、rename、diagnostics、code action。但 P2.1 不应依赖 LSP 才能启动。

---

## 7. 模型能力路由

如果目标是提高开源模型能力上限，就不要假设一个模型做所有事。

### 按任务路由

| 任务 | 模型要求 |
|---|---|
| repo summarization | 长上下文、便宜、摘要稳定 |
| code edit | tool-use 强、格式稳定 |
| test failure diagnosis | reasoning 强 |
| compaction | 便宜、摘要稳定 |
| commit summary | 小模型即可 |
| risky refactor | 强模型 + verify loop |

### Runtime policy

```text
if model.toolUseReliability < threshold:
  use stricter tool schema
  lower parallel tool count
  require extra JSON repair
  increase verification

if model.contextWindow large and cache cheap:
  prefer stable-prefix long context

if model edit reliability is weak:
  use smaller atomic edits
  require diff verification
```

provider capability 不应只是配置字段，而应实际影响执行策略。

---

## 8. 子代理与 worktree 能力

并行能力要服务于可靠性，而不是炫技。

建议顺序：

1. **只读 research agent**
   - 找文件。
   - 查调用链。
   - 查测试。
   - 不写代码。

2. **isolated verifier**
   - 只跑检查。
   - 不改文件。

3. **worktree executor**
   - 大任务在独立 worktree 修改。
   - 主 agent review diff 后合并。

4. **multi-agent task board**
   - 后期再做。
   - 不作为 P2.1 第一优先级。

原则：

> 并行不是为了同时做更多事，而是为了隔离失败、保护主上下文、提高验证质量。

---

## 9. 失败样本库

这是开源推广和模型能力提升的关键资产。

每次 agent 失败，形成样本：

```text
failure-samples/
  2026-xx-xx-tool-json-invalid/
    task.md
    model.md
    transcript.redacted.jsonl
    expected.md
    actual.md
    root-cause.md
```

### 分类

- 模型工具调用失败
- JSON 格式失败
- 上下文丢失
- 编辑错误
- 测试误判
- 过度修改
- 未验证却声称完成
- compaction 后遗忘

这些样本可以转化为：

- benchmark
- regression tests
- provider capability card
- prompt 改进依据
- 社区贡献入口

---

# 三、P2.1 推荐实施顺序

## 第一批：性能地基

1. 非阻塞 volatile context。
2. TUI streaming / thinking / tool output 批处理。
3. token accounting 增量化。
4. smart compact 真正接入。
5. tool output 三层表示：raw / model / UI。
6. abort-aware retry 和工具中断。
7. prompt fingerprint 完整化。

## 第二批：开发能力基线

1. 新增 `glob/list_files/search/diff/run_tests/inspect_project` 工具。
2. repo map 最小版本。
3. related tests 推断。
4. diff + checkpoint + rollback。
5. test failure classifier。
6. final response evidence badge。
7. 10-20 个真实 repo task benchmark。

## 第三批：开源模型能力实验室

1. provider conformance suite。
2. model capability cards。
3. task matrix。
4. failure sample library。
5. model routing policy。
6. public benchmark report。
7. workflow packs / provider recipes。

---

# 四、P2.1 的判断标准

P2.1 完成时，不要求 Rivet 功能数量超过主流工具，但应满足：

1. **性能上：** 不阻塞输入，不浪费上下文，不刷爆终端，不丢会话。
2. **能力上：** 能找上下文，能小步编辑，能跑测试，能解释失败，能回滚。
3. **开源上：** 每个模型的能力和失败都可复现、可比较、可贡献。

最终建议：

> P2.1 应优先做开发能力基线和性能地基，再逐步增强 Trust Cockpit。因为差异化设计只有建立在“真的能完成开发任务”之上，才会成为 Rivet 的能力放大器。
