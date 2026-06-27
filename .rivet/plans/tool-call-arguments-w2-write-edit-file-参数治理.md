> **Status: COMPLETED** — 2026-06-19

# W2:write_file / edit_file 大参数治理 — Layer 1 框架扩展

> 前置:W1(`8643c714`)已建立 `ToolArgPostProcessorRegistry` + `addAssistantBlocks` 拦截 + plan_submit 文件指针。
> 评审依据:[tool-call-arguments-上下文膨胀治理-方案评审.md](./tool-call-arguments-上下文膨胀治理-方案评审.md)
> 本波负责人:瑶光出 spec;实现待指派。W1 遗留的集成测试与 untitled 边界由天权在 W1 上修。

## 为什么需要 W2(真实事故依据)

会话 `d6448b29` 的 cache-log 实证:第一次 0% 缓存断裂(`userMsgs:6, turn:1`)精确对应一次 **`write_file` 把 20,055 字符 / 549 行文档塞进 tool-call arguments**(消息 [101],写 `docs/superpowers/plans/2026-06-17-better-sqlite3-生产打包方案.md`),input 自此 +5370 永久骑高位。

**W1 只治了 plan_submit,真正咬人的是 write_file。** 全会话最大两个 tool-arg 负载都是 write_file(20,800 / 5,337 字符),plan_submit 在这个会话里根本没出现。W2 补上这个缺口。

## 设计原则(继承 W1,不过度设计)

1. **复用 W1 框架**:仍是 `ToolArgProcessor.process(args): string \| null` 同步接口,仍在 `addAssistantBlocks` 拦截,**不引入 Layer 3 的 ToolArgManager / artifactStore / async**(评审已论证过度设计风险,且 write_file/edit_file 的目标文件已由 execute 落盘,无需 artifact)。
2. **阈值门控**:与 plan_submit(plan 必然很大、无阈值)不同,write_file/edit_file 是通用工具,小写入很常见。**只在大参数超阈值时替换**,小写入保持 inline——避免外部调研指出的"小东西也外置导致来回 read 反噬 token"。
3. **指针即决策面**:替换串保留 `file_path` + 行数 + 字符数,让模型判断是否值得 read_file 回看(外部调研:preview 是 offload 生效的命门)。
4. **抽公共工厂**:write_file 与 plan_submit 结构同构(把一个大文本字段换成指向已知文件路径的指针),抽 `createFileContentArgProcessor` 复用,减少重复。

## 三个处理器

### 1. write_file(核心,高价值低风险)

字段:`{ content: string, file_path: string }`(实测)。execute 把 `content` 写到 `file_path`。指针直接引用 `file_path`——比 plan_submit 更自然(路径由模型显式给出,无需 slug 推导)。

```
content 超阈值 → 替换为:
[file written to {file_path} — {lines} lines, {chars} chars. Use read_file to review.]
```

保留 `file_path` 等其余字段不变;`content` 换指针。幂等:`content.startsWith('[file written to')` 则返回 null。

**时序不变量**(同 plan_submit):`addAssistantBlocks`(orchestrator:600)在 `executeBatch`(:627)之前,拦截时文件尚未写;但 `file_path` 在 args 中确定,文件在同轮毫秒级后写入,任何后续轮次 read 时已存在。

### 2. edit_file(保守,带风险门槛)

字段:`{ file_path, old_string, new_string, replace_all?, expected_count? }`。**比 write_file 微妙**,因为:

- old_string/new_string 通常远小于整文件,膨胀风险天然低;
- 替换掉 old/new 会**丢失"改了什么"的记录**。若 edit **失败**(stale anchor / 多匹配),模型想从上一次失败的 old/new 学习重试,却只看到指针——丧失重试上下文。而拦截发生在 execute(及其成败)之前,**无法按成败条件替换**。

**结论:edit_file 仅在极大阈值(建议 8K 字符,old+new 合计)才替换**,覆盖罕见的整块替换场景;常规小 edit 一律 inline。替换串:

```
[edit on {file_path}: replaced {oldLen}-char block with {newLen}-char block. Use read_file for current content.]
```

并在替换串里**保留 old_string 的前 80 字符**作为定位线索(决策面),避免完全失忆。

### 3. apply_patch(评估,本波不实现)

`apply_patch` 的 `diff` 字段可能很大,但 diff 是多文件补丁、无单一 file_path 可指。本波不处理,记入 W3 待办。

## 公共工厂

```typescript
// src/agent/tool-arg-post-processor.ts(扩展)或新文件
export function createFileContentArgProcessor(opts: {
  toolName: string
  contentField: string          // 'content' | 'plan'
  resolvePath: (parsed: Record<string, unknown>) => string | null
  threshold: number             // 字符阈值;0 = 无阈值(plan_submit)
  pointerPrefix: string
  render: (path: string, lines: number, chars: number, preview: string) => string
}): ToolArgProcessor
```

plan_submit 可回迁到此工厂(`resolvePath` = slug 推导,threshold = 0),write_file 用之(`resolvePath` = 取 `file_path`,threshold = 2000)。**回迁 plan_submit 须保持 W1 既有测试全绿**,否则不迁、仅新增 write_file 处理器。

## 阈值建议

| 工具 | 字段 | 阈值(字符) | 理由 |
|------|------|-----------|------|
| plan_submit | plan | 0(W1 现状) | plan 必然大 |
| write_file | content | 2000 | ~500 token;小配置/小文件 inline,20KB 事故必中 |
| edit_file | old+new 合计 | 8000 | 仅罕见整块替换;保留常规 edit 重试上下文 |

阈值为模块常量,不做 config 化(W2 不需要)。

## 安全不变量(继承 W1 + 新增)

继承:① 只改 `function.arguments` 字符串,不碰 `block.input`(execute 用 toolUses,写文件拿完整 content);② 合法 JSON 或 null;③ 幂等;④ fail-open;⑤ tool_call_id/name 不变;⑥ 拦截在 push+onMutation 之前,persist 与内存 byte-identical。

新增:
7. **阈值以下不替换**(返回 null),保证小写入零行为变化。
8. **edit_file 仅在超 8K 时替换**,且保留 old_string 前 80 字符 preview。
9. **指针解析语义**:历史指针经 read_file 解析的是文件**当前**内容,非写入时快照。对 write_file 可接受(模型关心当前态);文档明示此权衡。

## 实施任务

### Task 1:抽 `createFileContentArgProcessor` 工厂
- 文件:`src/agent/tool-arg-post-processor.ts`(扩展)
- 测试:扩展 `tool-arg-post-processor.test.ts`
- 交付:工厂函数,覆盖阈值门控、preview 提取、幂等前缀检测。

### Task 2:write_file 处理器 + 注册
- 文件:新建 `src/tools/write-file-arg-processor.ts`;在 `context.ts` 构造函数注册。
- 测试:`src/tools/__tests__/write-file-arg-processor.test.ts`
- 交付:超 2000 字符替换为 file_path 指针;阈值下返回 null;幂等;保留其余字段。

### Task 3:edit_file 处理器 + 注册(保守)
- 文件:新建 `src/tools/edit-file-arg-processor.ts`;注册。
- 测试:`src/tools/__tests__/edit-file-arg-processor.test.ts`
- 交付:old+new 超 8000 才替换,保留 old_string 前 80 字符 preview;阈值下 null;幂等。

### Task 4:addAssistantBlocks 集成测试(补 W1 缺口的共享基建)
- 文件:`src/agent/__tests__/context-arg-processor-integration.test.ts`
- 注意:W1 的 1 号缺口(集成测试)已交天权;若天权已建此测试,本 Task 改为**在其上追加** write_file/edit_file 用例,不重复建文件。
- 场景:经 `addAssistantBlocks` 投入一个 write_file(20KB content)tool_use → 断言 oaiMessages 里该 call 的 arguments.content 已是指针、file_path 不变、tool_call_id 不变;并断言原始 `block.input.content` 未被 mutate(模拟 executeBatch 仍能拿到完整 content)。

### Task 5:工具描述更新
- 文件:`src/tools/write.ts`、`src/tools/edit.ts` 的 definition.description
- 改动:说明大 content 在消息历史中会被替换为 file_path 指针,后续轮次用 read_file 回看(同 W1 plan_submit 的做法)。

### Task 6:volatile 提示词(可选,低优先)
- 若实测模型在 write_file 后频繁困惑,再在 volatile 补一句"你写过的大文件在历史中是指针,需要时 read_file"。先不做,观察后定。

## 反证测试表

| 场景 | 错误实现的后果 | 哪条测试会红 |
|------|---------------|-------------|
| write_file 处理器 mutate 了 block.input | execute 把指针当 content 写进文件 → 文件内容损毁 | Task 4:断言 block.input.content 未变 |
| 阈值判断用了错字段或恒真 | 小写入也被替换 → 模型来回 read 反噬 | Task 2:1KB content 应返回 null |
| edit_file 无脑替换(不设高阈值) | 失败重试时丢失 old/new 上下文 | Task 3:常规小 edit 应返回 null,大 edit 保留 preview |
| 替换后 JSON 非法 | tool call 解析失败 / 匹配不上 | Task 2/3:JSON.parse(result) 不抛 |
| 幂等失效 | 指针被二次包裹 | Task 2/3:再处理返回 null |
| 回迁 plan_submit 破坏 W1 行为 | plan_submit 指针格式变化 / 测试红 | W1 既有 13 测试 + Task 1 |

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| write_file 失败(路径逃逸等)但指针已入历史 → 悬空指针 | 低 | 模型看到错误结果会重试;悬空指针无害 | 与 plan_submit 同类边界;execute 错误结果已足够引导 |
| edit_file 替换导致失败重试丢上下文 | 中 | 模型难从失败 edit 学习 | 8K 高阈值 + 保留 old_string 前 80 字符;常规 edit 不触发 |
| 历史指针解析到文件当前态而非写入态 | 低 | 模型读到的是最新内容 | 文档明示;对 write_file 通常正是期望行为 |
| 工厂回迁 plan_submit 引入回归 | 低 | W1 行为漂移 | 回迁须 W1 测试全绿,否则不迁、仅新增 |

## 与 W1 / 天权的分工边界

- **天权(在 W1 上)**:补 addAssistantBlocks 集成测试(评审 1 号缺口)、修 untitled 缺 title 边界(2 号缺口,改为缺/空 title 返回 null)。
- **W2(本 spec)**:write_file(核心)+ edit_file(保守)处理器、公共工厂、阈值、(在天权集成测试上追加的)write/edit 用例、工具描述。
- **W3 待办**:apply_patch 的 diff、delegate_task.instructions、send_message.body 等其余大参数工具;以及评审指出的**第二类断裂**(长空闲 → frozen base 驱逐重建,cache-log L123)的独立治理——与 arg 膨胀无关,不在本线。

## 不做什么(防 scope 蔓延)

- 不做 Layer 3 ToolArgManager / 通用预算配置系统(过度设计)。
- 不做 Layer 2 plan mode 独立上下文双数组(L 级改动,评审建议先用轻量替代验证收益)。
- 不碰 frozen base 驱逐那条断裂线(独立问题,W3)。

## W3 收束(已落地)

排查全部工具定义后,W2 spec 对 W3 的预设需纠正,Layer 1 在此正式收口:

- **delegate_task / delegate_batch 排除**:其大字段是 `objective`(一句话目标,有界),不是膨胀源,不需治理。
- **send_message 排除**:并非工具,仅存在于旧设计文档。
- **实际剩余、且内容落盘或可经 git/磁盘重建的大自由文本工具只有两个,均已覆盖**:
  - `hash_edit`(`new_string`,阈值 2000)— 工厂复用,`anchors`/`file_path` 保留,指针 `[hash_edit applied to …]`。处理器 `src/tools/hash-edit-arg-processor.ts`。
  - `apply_patch`(`diff`,阈值 4000)— 自定义有损坍缩:解析 `+++` 文件清单 + `@@` hunk 数,生成 `[patch applied to N file(s): … — H hunks, K chars]`;`check_only:true` 与无法解析文件头时保持原样。处理器 `src/tools/apply-patch-arg-processor.ts`。
- **apply_patch 有损取舍**:verbatim diff 不落盘,坍缩后只能经 read_file / git diff 重建结果。沿用 W2 既有缓解(高阈值 + check_only 留存 + 失败时工具结果回显),不引入 `.rivet/patches` 持久化。
- **不纳入**:create_document/presentation/spreadsheet/pdf 等生成类工具(低频,可后续单列);frozen base 驱逐(评审第二类断裂,独立问题,与 arg 膨胀无关)。

至此 Layer 1 覆盖 plan_submit / write_file / edit_file / hash_edit / apply_patch 五个工具,tool_call 参数膨胀治理主线闭环。
