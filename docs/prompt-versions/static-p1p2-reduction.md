# Static Prompt P1+P2 精简记录

## 变更目标

在不动 `<workflow>`（P0）的前提下，先完成 P1、P2 级别的重复/过重内容精简，便于前后对比分析。

## 文件位置

- 变更前备份：`docs/prompt-versions/static-before-p1p2.ts`
- 变更后备份：`docs/prompt-versions/static-after-p1p2.ts`
- 当前生效：`src/prompt/static.ts`

## 体积对比

| 指标 | 变更前 | 变更后 | 减少 |
|------|--------|--------|------|
| 字符数 | 11,801 | 10,343 | -1,458 (-12.4%) |
| 行数 | 224 | 186 | -38 |
| UTF-8 字节 | 25,152 | 22,226 | -2,926 (-11.6%) |

## P1 改动：消除重复区块

### 1. 合并 `lossy-observation-discipline` 到 `evidence-scope`

**变更前**：两个独立 rule。

```xml
<rule name="evidence-scope">...有损观测一句话...</rule>
<rule name="external-source-verification">...</rule>
<rule name="lossy-observation-discipline">
  工具输出含 [storm-collapsed] / [output truncated] / [PARTIAL view] ... 禁止推出负向结论...
  特别地：repo_map 显示 truncated 时...
  改共享能力/启动路径/配置面时...
</rule>
```

**变更后**：`evidence-scope` 内用一个段落承载有损观测纪律，保留 `lossy-observation-discipline` 字符串和全部测试断言所需关键词（`禁止从中推出负向结论`、`PARTIAL view`、`truncated`）。

```xml
<rule name="evidence-scope">
  ...
  有损观测纪律（lossy-observation-discipline）：工具输出含 [storm-collapsed] / [output truncated] / [PARTIAL view] / [truncated: N files omitted] / [⚠ VERIFICATION_REQUIRED] 等标记时，禁止从中推出负向结论，必须换独立工具交叉验证。repo_map truncated 时假设被省略文件含关键调用方；read_file PARTIAL view 时必须读到消费端/调用端；改共享能力/启动路径/配置面时按同一调用模式扫完消费方再声称完整。
  ...
</rule>
```

**释放**：约 400 字符。

### 2. 压缩 `<tool-usage>` 中的三层收敛纪律

**变更前**：

```text
收敛纪律（硬性闸门）：并行只读工具返回后，必须完成三层收敛再下结论：
1. 分类层 — 将返回结果按类型分桶...
2. 交叉验证层 — 关键结论...
3. 综合判断层 — 前两层完成后再给结论...
批次纪律：存在性探测和内容读取不得混在同一批...
```

**变更后**：

```text
收敛纪律：并行只读工具返回后，先分类结果、再交叉验证关键结论、最后综合判断；存在性探测和内容读取不混同一批，每批发完收敛后再发下一批。
```

**释放**：约 350 字符。

### 3. 删除独立 `<delegation>` 区块，合并到 `<tool-usage>`

**变更前**：`<tool-usage>` 末尾已有并行纪律提到 delegate，但后面又有一个完整的 `<delegation>` 区块（约 1.5K 字符），内容大量重复。

**变更后**：在 `<tool-usage>` 末尾新增一段委派纪律，保留所有测试断言关键词：

```text
委派：不是默认推进方式；核心改动路径不外包。需并行探查 3+ 独立模块、交叉星域审视或理解 3+ 文件整体结构时，用 delegate_task / delegate_batch；单次 grep/read 能完成的不委派。用户说不要委派时禁用。worker findings 是待核验假设，引用前用 read_file/grep 独立核验；worker 卡住或超时，标注降级并继续内联执行。建议用户在新会话继续实施 ≠ delegate_task 委派——前者是上下文压力下的协作建议，后者是工具调用。
```

**释放**：约 1,000 字符。

## P2 改动：合并 `<beliefs>` 与 `<delivery-contract>` 重叠

### 1. 删除 `<delivery-contract>` 中的「异议推进」子条款

**变更前**：

```text
<beliefs>
当你发现更优方案时...
当你有不同看法时，直接说出有理有据的异议...
当你预见风险时，在修改前指出风险并给出规避方案。
...
</beliefs>
...
<delivery-contract>
...
异议推进：当你判断当前方向有显著风险时，一句话异议是最高效的推进——格式「⚠ [风险] → [建议]」，然后继续你认为正确的方向。
...
</delivery-contract>
```

**变更后**：保留 `<beliefs>` 里的异议/风险情境触发，删除 `<delivery-contract>` 中重复的「异议推进」格式条款。行动闭环、诚实门禁、收束等仍保留。

**释放**：约 100 字符，同时避免同一语义在两个区块重复。

## 验证结果

```bash
npx tsc --noEmit -p tsconfig.json
# 无错误

npx tsx scripts/run-node-tests.ts src/prompt/__tests__/static.test.ts
# 26 tests, 0 fail
```

## 未触及的 P0 建议

`<workflow>` 仍占用约 3.5K 字符，是最大减重空间。后续若继续精简，可考虑：

1. 把六阶段工作流和诊断阶梯迁到 seed capsule / `recall_capsule(工作流)`，static 只保留一句纲领。
2. 把 `<tool-usage>` 中浏览器/桌面自动化分工迁到对应工具描述，减少 static 体积。
3. 评估 `<downloads>` 是否必要常驻。

## 注意事项

- 所有测试断言的关键字符串均已保留（`lossy-observation-discipline`、`不是默认推进方式`、`用户说不要委派时`、`继续内联执行`、`delegate_task 委派——前者是上下文压力下的协作建议` 等）。
- 没有改动 `<identity>`、`<beliefs>`、`<stance>`、`<security>`、`<shared-worktree>`、`<git>`、`<workflow>` 的核心内容。
- 模型 calibration（deepseek/mimo/glm）未改动。
