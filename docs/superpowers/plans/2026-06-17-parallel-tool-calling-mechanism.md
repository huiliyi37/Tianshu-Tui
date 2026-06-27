# 并行工具调用机制 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 教会模型把互相独立的探索型工具调用在单条消息里一次扇出，让 Rivet 每轮工具调用数压到与 Claude Code 同量级——这是补一个缺失的机制，不是换模型。

**架构：** 引擎层 `tool-execution.ts` 的 `executeBatch` 早已支持单轮并行（对连续的 concurrency-safe 工具用 `Promise.all`）。瓶颈在 prompt：`static.ts` 教的是 `inspect_project → repo_map → glob → grep` 的"由粗到细"串行链，结构上逼模型一轮一个。本计划改写 `<tool-usage>` 段，把串行链换成"先列独立操作 → 一次扇出"的并行批处理指令 + few-shot，并用契约测试锁定指令存在。

**技术栈：** TypeScript strict / node:test + node:assert/strict / 纯字符串系统提示（`src/prompt/static.ts`）。

---

## 背景事实（实读代码确认，2026-06-17）

### 哪些工具可并行（`isConcurrencySafe() === true`）

引擎判据：`src/tools/types.ts:148` 的 `isConcurrencySafe(): boolean`。每个工具自报。

**可并行（探索/只读族 —— 这是 prompt 要主打的批处理对象）：**
`read_file` · `grep` · `glob` · `semantic_search` · `repo_map` · `repo_graph` · `inspect_project` · `file_info` · `read_section` · `related_tests` · `web_fetch` · `web_search`

**可并行（其它，非探索）：**
`diff` · `recall` · `recall_capsule` · `remember` · `todo` · `leave_mark` · `open_path` · `skill` · `ask_user_question` · `delegate_task` · `delegate_batch` · `sandbox_exec` · LSP 工具（`src/lsp/tools.ts:66,128`）

**串行（`isConcurrencySafe() === false`，写/执行/有副作用）：**
`write_file` · `edit_file` · `hash_edit` · `apply_patch` · `bash` · `run_tests` · `git` · `browser` · `import_resource` · `export_file` · `request_path_access` · `undo` · `team_orchestrate` · `plan_submit` · `plan_close` · `plan_task` · `create_document` · `create_image` · `create_pdf` · `create_presentation` · `create_spreadsheet`

### 怎么被调用（`src/agent/tool-execution.ts:166-237`）

```
executeBatch(toolUses):
  indexed = toolUses.map(tu => ({ tu, safe: registry.get(tu.name)?.isConcurrencySafe() ?? false }))
  cursor = 0
  while cursor < len:
    if indexed[cursor].safe:
      # 收集"连续"的 safe 工具成一批
      batchStart = cursor; while safe: cursor++
      await Promise.all(batch.map(executeToolUse))   # ← 并行
    else:
      executeToolUse(single); cursor++               # ← 串行
```

**关键约束（决定 prompt 怎么写）：只有"连续"的 safe 工具才会并行。** 若模型发 `[read_file, edit_file, read_file]`，中间的 `edit_file` 把它切成三段，两次读退化成串行。所以指令不能只说"独立的读并行发"，必须说"**把同阶段、互相独立的探索调用连续聚在一起，别在中间插写操作**"。

### 当前 prompt 现状（`src/prompt/static.ts:41-46`）

```
<tool-usage>
文件操作：read_file 先读再改，edit_file 精确替换…
导航：inspect_project → repo_map → glob → grep，由粗到细。路径含空格加引号。
工作区外路径：…
防循环：同一方法 3 次无新信息，先声明策略无效再换工具。同一错误复现两次则换方法。
</tool-usage>
```

第 43 行的箭头链是问题根源——它描述的是串行依赖流程，全程没一句"独立操作并行发"。

### 缓存影响

`static.ts` 属于 P1 冻结前缀。改它触发一次性前缀缓存重建（版本变更的正常代价），改完后稳定，**不破坏会话内缓存**。前提：新增文本只进 `static.ts`，绝不进 `volatile.ts`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/prompt/static.ts` | 系统提示静态段，含 `<tool-usage>` | 修改第 43 行 + 新增并行批处理指令与 few-shot |
| `src/prompt/__tests__/static.test.ts` | `buildSystemPrompt` 契约测试 | 新增 3 条断言：指令存在 / few-shot 存在 / 不破坏既有结构 |

范围检查：本计划只动 prompt 层（单一子系统），产出可独立测试的变更。规划/感知层支撑（让模型发工具前显式枚举"哪些独立"）是**第二阶段**，故意不在本计划内——先验证 prompt 单层是否足够（见末尾"第二阶段（推迟）"）。

---

## 实施前基线探针（反证前置，天璇 #3 + 瑶光 #1）

改 prompt 前，先用当前 prompt 跑一次探索型任务确认模型行为基线。**不能凭推测动手**——如果当前模型已经在并行、或者串行根因不在 prompt，改了就是 false-green 的 prompt 工程。

**探针方法：** 选一个独立于本项目的探索型任务（"列出 `/tmp` 下所有 `.log` 文件的内容前 5 行"），用当前代码跑 3 轮，记录 `executeBatch` 中 `toolUses.length` 分布。预期基线：每轮 1 个工具调用（串行）。

探针失败（模型已经在并行，或任务不适合测）→ 暂停实施，重新诊断根因。探针通过（确认串行基线）→ 继续任务 1。

基线数据留在计划文件内，供改后对照。

---

### 任务 1：契约测试 — 并行批处理指令存在

**文件：**
- 测试：`src/prompt/__tests__/static.test.ts`（在 `describe('buildSystemPrompt', …)` 内追加）

- [ ] **步骤 1：编写失败的测试**

在 `static.test.ts` 的 `describe('buildSystemPrompt', () => {` 块内，紧接 `wraps tool usage in <tool-usage> tags` 那条之后，插入：

```typescript
  it('teaches parallel fan-out of independent探索 tools', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 必须出现"并行/一次扇出"语义的指令，且点名探索工具
    assert.ok(prompt.includes('并行'), '应含并行指令')
    assert.ok(
      prompt.includes('单条消息') || prompt.includes('一次发出') || prompt.includes('一次扇出'),
      '应教在单条消息里一次发出多个工具',
    )
  })

  it('warns不要在并行批中插入写操作 (contiguous-block constraint)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 引擎只并行"连续"safe 块；写操作会切断批次 → 必须显式告诫
    assert.ok(
      prompt.includes('写操作') || prompt.includes('edit_file') || prompt.includes('write_file'),
      '应提醒并行批中不要混入写操作',
    )
  })

  it('no longer teaches串行 "由粗到细" navigation chain', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 旧的串行链描述应被移除或改写，避免与并行指令冲突
    assert.ok(!prompt.includes('由粗到细'), '串行链描述应已移除')
  })
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test-force-exit --test src/prompt/__tests__/static.test.ts`
预期：3 条新测试 FAIL（`应含并行指令` / `应教在单条消息…` / `串行链描述应已移除`），其余既有测试仍 PASS。

> 命令依据：`npm test` 走 `scripts/run-node-tests.ts`，它 glob 全部 `src/**/*.test.ts` 不接单文件参数（确认于 `scripts/run-node-tests.ts:10,24`）。单文件迭代直接复用 runner 内部的 `node --import tsx --test-force-exit --test <file>` 形式。全量回归仍用 `npm test`。

- [ ] **步骤 3：Commit 失败的测试**

```bash
git add src/prompt/__tests__/static.test.ts
git commit -m "test(prompt): 并行工具调用指令契约测试 (RED)"
```

---

### 任务 2：改写 `<tool-usage>` — 串行链 → 并行批处理

**文件：**
- 修改：`src/prompt/static.ts:43`（替换"导航"行）+ 在其后插入并行批处理指令

- [ ] **步骤 1：替换第 43 行的串行链**

把 `src/prompt/static.ts:43` 这一行：

```
导航：inspect_project → repo_map → glob → grep，由粗到细。路径含空格加引号。
```

替换为：

```
导航：探索靠 inspect_project / repo_map / glob / grep / read_file / semantic_search。这些是只读工具，互相独立——别一个一个串行发。路径含空格加引号。
并行：把同一阶段、互不依赖的只读探索调用放进同一条消息一次发出，引擎会并行执行。例：要读 3 个文件 + grep 2 个符号，就在一条消息里发 5 个工具调用，而不是分 5 轮。只有结果会喂给下一步时才串行。
连续约束：并行只对"连续"的只读调用生效。别在一批读/搜中间插 write_file/edit_file/bash——写操作会切断并行批，把两侧的读退化成串行。先把所有要读的一次读完，再动写。
```

> 实现提示：用 `edit_file` 精确替换第 43 行整行；`old_string` 取 `导航：inspect_project → repo_map → glob → grep，由粗到细。路径含空格加引号。`（须与文件中完全一致，含全角符号）。

- [ ] **步骤 2：运行契约测试验证通过**

运行：`node --import tsx --test-force-exit --test src/prompt/__tests__/static.test.ts`
预期：任务 1 的 3 条全部 PASS（`并行` / `单条消息`（"一次发出"命中）/ `由粗到细` 已移除 / `写操作` 命中）。

- [ ] **步骤 3：Commit**

```bash
git add src/prompt/static.ts
git commit -m "feat(prompt): 并行工具调用机制 — 串行链改并行批处理 + 连续约束告诫"
```

---

### 任务 3：全量回归 + typecheck

**文件：** 无新增，仅验证。

- [ ] **步骤 1：typecheck**

运行：`npm run typecheck`
预期：无错误（仅改了字符串和测试，不应有类型问题）。

- [ ] **步骤 2：全量测试**

运行：`npm test`
预期：全绿。重点关注 `src/prompt/__tests__/` 下所有缓存/契约测试——确认改 `static.ts` 没破坏前缀缓存稳定性测试（`engine-cache-stability.test.ts` / `static.test.ts` 的"no markdown ## headers" / "nesting depth max 2"）。

> 若 `nesting depth is max 2 levels` 或 `no markdown ## headers` 测试转红：说明新增文本引入了三层嵌套标签或 `## ` 行首——检查插入的三行纯中文文本不含 `<tag>` 和行首 `## `（本计划的文本不含，应安全）。

- [ ] **步骤 3：Commit（若回归暴露需修的点）**

仅当步骤 1/2 发现并修复了问题时：

```bash
git add -A
git commit -m "fix(prompt): 并行指令回归修复"
```

否则跳过——任务 2 的 commit 已是最终状态。

---

## 自检结果

**1. 规格覆盖度：** 用户要求"先分析代码找出哪些并行工具、怎么调用、写一下" → 已在"背景事实"章节用实读代码列出 22 个可并行工具 + `executeBatch` 调用机制 + 连续块约束。改造机制 → 任务 1-2。验证 → 任务 3。全覆盖。

**2. 占位符扫描：** 无 TODO/待定。每个代码步骤都有完整可粘贴的测试代码与替换文本。

**3. 类型一致性：** 仅用既有 `buildSystemPrompt({ tools: [] })`（`static.ts:118` 确认签名），无新类型。测试断言用 `assert.ok` + `string.includes`，与 `static.test.ts` 现有 27 条断言同模式。

**4. 提示词字节数（瑶光 #8：落地核对）：** 改前 `wc -c src/prompt/static.ts` → 改后 `wc -c src/prompt/static.ts` 对比。预期净增 ~200 字节（替换 1 行 + 新增 2 行纯中文）。若膨胀超过 500 字节，检查是否误插了多余空格/换行——在提交前修回。

---

## 第二阶段（推迟，YAGNI）

若任务 3 验证后，改后对照观察**未达到以下三条硬指标中的至少两条**，才触发第二阶段——在 `afterPerception` hook 或 turn 起始注入"枚举本轮独立操作"的轻量结构。

**三条硬指标（瑶光 #11：可 falsify 的判定标准）：**

| 指标 | 测量方法 | 目标（改前 baseline → 改后） |
|------|----------|------------------------------|
| 单轮平均 tool_use 数 | 同一探索型任务，`executeBatch` 中每次 while 迭代的 `batch.length` 分布取中位数 | baseline ~1 → 改后 ≥ 3 |
| 总轮数 | 同一任务完成所需 API 轮数 | 下降 ≥ 30% |
| 假并行块占比 | `batch.length === 1` 的"名义并行实为串行"块数 / 总批次数 | 从 ~90% 降到 ~30% |

**三条全未达标 → prompt 层不够，启动第二阶段。达标两条或以上 → prompt 层足够，第二阶段封存为 YAGNI。**

第二阶段的方案：
- 在 `afterPerception` hook 或 turn 起始注入"枚举本轮独立操作"的轻量结构，把并行从偶发强化成默认。
- 风险：动 hook/perception 层会碰 `runtime-hooks.ts` 与缓存边界，复杂度远高于 prompt 单层。**先证明 prompt 层不够，再上这层。** 不要预先实现。

改后对照方法：
1. 用任务 3 落地后的代码，跑与基线探针**完全相同的任务**（同一 prompt、同一工作区状态）
2. 在 `tool-execution.ts:157` 临时加一行 `console.error('[telemetry] batch sizes:', batchLengths)` 记录分布（验证完移除）
3. 收集 3 轮数据，对比基线计算三条指标，写入计划闭包
