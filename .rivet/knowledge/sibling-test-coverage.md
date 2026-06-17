# 姊妹测试覆盖：改 X.ts 时不仅要跑 X.test.ts

> 蒸馏自 2026-06-17 consolidatedBlock 前置改动。`engine.test.ts` 33/33 绿，但同目录 `engine-cache-stability.test.ts` 30/29（1 fail）未被包含在运行集中。声称"33/33 绿"的 N=33 恰好是单文件测试数——这个数字本身就该触发警觉：改了缓存关键路径，只跑出 33 个测试，而 prompt 目录总共 290+ 个。

## 根因

测试命令只点了 `engine.test.ts` 一个文件，没用 glob (`engine*.test.ts`)。同目录的 `engine-cache-stability.test.ts` 和 `engine-perf.test.ts` 完全没进运行集。

## 规则

- 改 `X.ts` → 跑 `X*.test.ts`（覆盖 `X-cache-stability`、`X-perf` 等同源姊妹文件）
- 缓存/不变量/前缀结构类改动 → 跑整个 `__tests__/*.test.ts` 目录
- 声称"N/N 绿"前，确认 N 对得上被影响范围的测试文件总数。N 太小就是没测全的信号

## 具体命令

```bash
# 最小：改 X.ts 至少跑姊妹文件
node --import tsx --test src/prompt/__tests__/engine*.test.ts

# 缓存/不变量改动：跑整个目录
node --import tsx --test src/prompt/__tests__/*.test.ts
```

## 关联

- `[[feedback_adversarial-review-method]]` fail-closed on tests pass
- `[[feedback_full-regression-after-parallel-work]]` targeted tests miss cross-module regressions
