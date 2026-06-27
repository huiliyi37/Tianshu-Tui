# 以 cacheCreate 成本为单一目标的双线优化计划

> **面向 AI 代理：** 使用 `executing-plans` 逐任务执行（计划阶段不派子代理）。步骤用复选框（`- [ ]`）跟踪。
> 关联：`2026-06-19-轮间首请求-cacheCreate-增量附录优化设计.md`、`2026-06-19-增量附录-append-only-delta.md`（Part A 详细任务）、`2026-06-19-缓存命中率追竞品-四维度分析与行动优先级.md`

**目标：** 降低会话总 **cacheCreate**（未命中）token——这是成本的真正所在，不是 token 占比。

**成本模型（决策依据，来自 `engine.ts:40-50`）：** cacheRead ~0.025 元/M、cacheCreate ~3 元/M = **120×**。会话 fe39a8ee 实测：cacheCreate 仅占 5.7% token（134,954 / 2,357,976），但按 120× 加权占 **~88% 的费用**（0.405 元 vs cacheRead 0.056 元）。**所有优化只认一个指标：cacheCreate token × 3 元/M。**

**两条线（都打 cacheCreate）：**
- **Part A — 每轮 appendix 地板**：turn-0 首请求的 `<context-update>` 全量重建 ~12K，绝大部分是模型上轮已缓存的重发。增量化后 12K→1-3K。这是**每轮稳定支出**。
- **Part B — 重复读取引用化**：重复读未变文件时当前在尾部重发全文（一次全新 cacheCreate），而那些字节早已在上文缓存。专建"重读引用"机制：重读只回紧凑引用、不重发全文。对纯重复读**零编辑代价**（内容模型已看过），不碰首读全文。这是**重读越多越省**的复利项。

---

## 关键事实校准（写计划前的取证结论）

1. **v4-pro contextWindow = 1,000,000**（`provider-presets.ts:35`）。在 1M 窗口上：
   - engine 的 prune/observation-masking/dedup/DISK_BUDGET 全部门控 `< 1_000_000`（`engine.ts:439,457,480`）→ **全部不运行**。故四维度文档的"masking 10→5""DISK_BUDGET 50K→8K"在本模型上无效。
   - tiering（`tool-execution.ts:413`）`>= 500_000` 运行，但 **read_file/read_section 被显式豁免**（`tool-execution.ts:411`，理由：保留全文供 `edit_file` 精确 old_string 匹配）。
2. **read_file 的 artifact 包裹不缩内容**（`read-file.ts:550-558`）：包裹时返回 `modelContent（全文）+ 结构大纲 + [artifact:id]`，artifact 只是 prune 用的 backup。**降低 read_file artifact 阈值不会把 29.5K 文件变成摘要**——它仍全量内联、还多出大纲+标记，且重新引入 `[artifact:X]` 绕路回归（`read-file.ts:522-524` 的 Tianshu post-mortem）。**故 Part B 不采用"降 artifact 阈值"路线，也不复用现有 artifact 的全文内容。**
3. **重复读未变文件 = 尾部全文重发 = 纯 cacheCreate 浪费**（`read-file.ts:431-437` 全量重读取回全文 slice；`:457-575` 无 artifact 时只告诫后仍重发全文）。这是**首读之外**的另一笔 cacheCreate，且字节早已在上文缓存。Part B 针对它**专建一个"重读引用"机制**：重读不重发全文，只回紧凑引用（带 read_section 句柄）。对纯重复读零编辑代价（内容模型已看过），不碰首读，不撞 post-mortem 标记回归。

---

## Part A：增量附录（append-only delta context-update）

**完整任务见独立计划 `docs/superpowers/plans/2026-06-19-增量附录-append-only-delta.md`（任务 1-7）。** 此处只列摘要与本计划的统一验证挂钩，执行时直接按那份逐任务做：

- 任务 A1（=该计划任务 1）：`buildDynamicAppendix` 拆出 `buildDynamicAppendixParts`（返回 `{name,content}[]`）。
- 任务 A2（任务 2）：`appendixDelta` 开关 + engine 跨轮状态（`lastEmittedAppendixParts`/`appendixSeq`/`appendixBaselineSent`）+ `invalidateFreshCache` 重置 baseline。
- 任务 A3（任务 3）：fresh 路径接 `buildAppendixBody`——首轮全量 baseline（带 seq），后续只发变化块 `mode="delta"`，无变化发 `<context-update seq="N"/>`。
- 任务 A4（任务 4）：静态提示加 `<context-update-protocol>` supersede 语义。
- 任务 A5（任务 5）：frozen 字节一致性回归闸门。
- 任务 A6（任务 6）：压缩/历史重写边界 `resetAppendixBaseline()`。
- 任务 A7（任务 7）：`RIVET_APPENDIX_DELTA` 接线 + cache-log 验证。

**Part A 预期 cacheCreate 降幅：** 每轮 turn-0 首请求 12K→1-3K（普通轮）。按会话 4 个用户轮算，单会话省 ~9K×3=27K「token×轮」的 cacheCreate，折 ~0.027 元/会话当量；真正价值在每个会话每轮稳定省、且降低首 token 延迟。

---

## Part B：重复读取引用化（purpose-built read-reference，不复用现有 artifact 全文）

**核心取证（决定了机制设计）：** 重复读同一未变文件时，当前两条路径都**在尾部重发全文** = 一次全新 cacheCreate：
- 有 artifact：短路从 artifact 取 slice（`read-file.ts:431-437`），但**全量重读（offset=1 无 limit）的 slice 就是全文**——重发全文。
- 无 artifact（1M 窗口大多数文件，read_file 阈值 750K）：走 `repeatWarning`（`:457-468`），**只 prepend 一句"别重读"的告诫，随后照样重发全文**（`:470-575`）。

**新机制（与现有 artifact 区分）：** 重复读未变文件时**不重发全文，返回紧凑引用**——"该文件本会话已读、未变（N 行）；完整内容在你上文的 tool_result 中；需具体区段用 `read_section(...)`"。三点干净：
- **缓存安全**：纯尾部写，写入时内容完全可控，绝不改写历史（区别于 prune/T7）。
- **编辑安全**：内容是模型**之前已看过**的（不是首读隐藏）；只拒绝重复，不剥夺信息。首读全文不受影响 → `edit_file` 精确匹配不受损。
- **可恢复**：引用带 `read_section` 句柄（artifactId 或 rawPath）；上文若被压缩掉也能按需取回。

**与现有 artifact 的边界（回应"不复用现有 artifact 内容"）：** 现有 artifact 是 prune 的全文备份，重读路径复用它=重发全文。新机制只产出**引用字符串**，不把 artifact 全文吐回消息流；artifact 仅作为引用可恢复性的后端句柄之一。

### 任务 B1：未变重复读判定收口 + 开关

- [ ] 修改 `src/tools/read-file.ts:416-468`（统一"未变重复读"判定）
- [ ] 测试 `src/tools/__tests__/read-file-dedup.test.ts`

**目标：** 把现有 `readHistory`/`fileReadHistory`/`repeatWarning`（已存在）的判定收口为一个布尔：`isUnchangedRepeatRead`（同 cwd+canonical、mtime 未变、本会话已读过）。加开关 `RIVET_READ_REF`（默认关）。

**调研背书：** 判定基础设施已存在（`read-file.ts:430-467`），不新建状态；只把分散的命中判定归一，并在 flag 关时保持现状（重发全文 + repeatWarning），flag 开时改走 B2。无删除行为。

**验证：**
```bash
npm run typecheck
npx tsx --test src/tools/__tests__/read-file-dedup.test.ts
```
新增测试：flag 关时未变重读仍返回全文（回归）；`isUnchangedRepeatRead` 对 mtime 变化返回 false。

**提交：**
```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file-dedup.test.ts
git commit -m "feat(tools): unify unchanged-repeat-read detection + RIVET_READ_REF flag (任务 B1)"
```

### 任务 B2：返回紧凑引用替代全文重发

- [ ] 修改 `src/tools/read-file.ts`（命中 B1 且 flag 开 → 返回引用，不走全文返回路径）
- [ ] 测试 `src/tools/__tests__/read-file-dedup.test.ts`

**目标：** flag 开 + `isUnchangedRepeatRead` + 可恢复句柄存在时，返回紧凑引用字符串，不返回 `payload.modelContent` 全文。

**实现（引用格式）：**
```
[read-ref] {canonical} 本会话已读且未变（{totalLines} 行，{modelBytes} bytes）。
完整内容在你上文的 tool_result 中——回看即可。需要具体区段：read_section("{canonical}", offset, limit)。
```
- 全量重读（offset=1 无 limit）和**大片段重读**（命中且 modelBytes 超过引用阈值，如 >2KB）走引用。
- 小片段重读（已紧凑、低于引用阈值）保持现状（直接返回内容），避免为省几百字节反而加往返。

**调研背书：** 现有全文返回点 `read-file.ts:532-536/559-564/570-574`；引用分支在 `readFilePayload` 之前短路（命中即返回，省掉读盘+重发）。`read_section` 工具签名执行时 grep `read-section.ts` 确认（artifactId vs path 取源）。

**验证：**
```bash
npm run typecheck
npx tsx --test src/tools/__tests__/read-file-dedup.test.ts
```
新增测试：`RIVET_READ_REF=1` 下，第二次全量读同一未变文件 → 返回 `[read-ref]` 引用、**不含**全文；文件被改（mtime 变）→ 返回全文（不引用）；小片段重读不受影响。

**提交：**
```bash
git add src/tools/read-file.ts src/tools/__tests__/read-file-dedup.test.ts
git commit -m "feat(tools): return compact read-ref instead of re-emitting full content on unchanged repeat read (任务 B2)"
```

### 任务 B3：可恢复性保证（read_section 句柄）

- [ ] 修改 `src/tools/read-file.ts`（首读时确保留存可恢复句柄）
- [ ] 修改/确认 `src/tools/read-section.ts`（能按 canonical path 取源，不只 artifactId）
- [ ] 测试 `src/tools/__tests__/read-section.test.ts`

**目标：** 保证被引用化的文件，模型总能用 `read_section` 取回——即便上文已被压缩、且文件未达 artifact 阈值（无 artifactId）。

**调研背书：** `persistRawOutput`（`read-file.ts:485`）已为每次读写 `rawPath`。执行时 grep `read-section.ts` 的取源路径：若 `read_section` 仅认 artifactId，则需让它也能按 canonical path（live 文件，mtime 未变时直接读盘）取段——这是已存在能力的小扩展，非新子系统。

**验证：**
```bash
npm run typecheck
npx tsx --test src/tools/__tests__/read-section.test.ts
```
新增测试：引用化后用 `read_section(canonical, offset, limit)` 能取回对应区段（无 artifactId 也可，走 live 文件）。

**提交：**
```bash
git add src/tools/read-file.ts src/tools/read-section.ts src/tools/__tests__/read-section.test.ts
git commit -m "feat(tools): guarantee read-ref recoverability via read_section path source (任务 B3)"
```

### 任务 B4：遥测 + cacheCreate 量化（runbook）

- [ ] 复用/新增遥测计数器 + 端到端验证

**目标：** 量化净赚——被引用化省掉的"全文重发"次数 × 文件 modelBytes = 直接省下的 cacheCreate token。

**实现：** 在 B2 短路点累加 `readRefSavedBytes += modelBytes`、`readRefCount++`，写入现有 trace/sensorium（`trace-store.ts`，`RIVET_DEBUG_TELEMETRY` 下）或 cache-log breadcrumb。

**验证（runbook）：**
```bash
npm test
# 基线：默认（flag 关）跑一个含重复读取的真实会话，记 cache-log cacheCreate 总量
RIVET_READ_REF=1 <跑同类会话>
```
对比：
1. 会话 cacheCreate 总量降幅；用遥测 `readRefSavedBytes × (1/4 token/char) × 3 元/M` 交叉核对。
2. 确认无副作用：edit_file 失败率不升（引用只作用于重复读、不碰首读）；模型未因引用而频繁绕路（如重复 read_section 同一全量范围）。
3. 净赚确认后再考虑把默认翻开。

---

## 统一验证（两线共用）

1. `npm run typecheck && npm test`（2340+ 全过）。
2. 真实会话 `.rivet/sessions/<id>/cache-log.jsonl`：
   - 恒等式 `input = cacheRead + cacheCreate` 全条成立。
   - **会话 cacheCreate 总量**（不是占比）改前/改后对比——这是成本的唯一口径。
   - turn-0 首请求 cacheCreate（Part A 目标）：12K → 1-3K。
   - 碎裂点（`volatileSwapped`/`historyRewritten`/`frozenClamped`/`frozenEvicted`）数量不升。
3. 把 cacheCreate 降幅折算 `Δtoken × 3 元/M` 报告实际省钱。

## 自检结果

1. **规格覆盖**：Part A（cacheCreate 每轮地板）→ 引用 P1 计划 7 任务；Part B（read 首写体积 + 碎裂放大）→ B1-B4。两线共用统一验证。✓
2. **占位符扫描**：无 TODO/TBD；B2/B3 的调用点定位标为执行时 grep（同 P1 任务 6 体例），非占位。✓
3. **类型一致性**：`sourceLargeBytes`/`decideReadPolicy(largeBytes)` 签名一致；环境变量 `RIVET_APPENDIX_DELTA`/`RIVET_READ_PARTIAL_BYTES` 命名一致。✓
4. **调研背书**：Part B 关键事实（1M 门控、read_file 豁免、artifact 不缩内容）已逐条取证并列入"关键事实校准"，且明确**排除**了无效的 artifact-阈值路线，附偏差理由。✓

## 设计偏差说明（必读）

- 四维度文档/artifact 提案的"降 read_file artifact 阈值 → 摘要"路线**未采纳**：经 `read-file.ts:550-558` 取证，该机制对 read_file 不缩内容、反增标记、且撞 post-mortem 回归。
- read-policy partial 视图（首读降为首页）**未作为主方案**：它对**首读**有真实 read→edit 代价。Part B 改打**重复读**——重读未变文件本就是纯浪费（内容已在上文缓存），引用化对它零编辑代价。partial 视图可作为后续可选项，但不在本计划。
- "masking 10→5 / DISK_BUDGET 50K→8K"**未采纳**：1M 窗口上不运行，且改写历史会碎前缀缓存（与降 cacheCreate 目标相悖）。
- Part B 专建"重读引用"，**不复用现有 artifact 的全文内容**（现有 artifact 是 prune 备份，复用即重发全文）；默认全关（`RIVET_READ_REF`），灰度由 env 控制，B4 遥测量化净赚后再翻默认。
