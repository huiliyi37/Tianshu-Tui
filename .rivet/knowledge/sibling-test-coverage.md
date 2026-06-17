# 姊妹测试覆盖：通用测试范围选择方法论

> 蒸馏自 2026-06-17 consolidatedBlock 前置改动。`engine.test.ts` 33/33 全绿，但同目录 `engine-cache-stability.test.ts` 30/29（1 fail）未进入运行集。声称"33/33 绿"的 N=33 恰好是单文件测试数——这个数字本身就是红旗。

## 通用模式：文件名直觉陷阱

改源文件时，人自然跑同名测试文件：

```
改 src/foo/bar.ts → 跑 src/foo/__tests__/bar.test.ts
```

但文件命名约定 `{name}-{concern}.test.ts` 会在同目录产生姊妹文件：

```
src/prompt/__tests__/
  engine.test.ts              ← 通用测试
  engine-cache-stability.test.ts  ← 缓存不变量专项
  engine-perf.test.ts         ← 性能专项
```

单跑 `bar.test.ts` 恰好漏掉这些专项测试——而它们往往保护改动最可能打破的约束。

## 三步测试范围选择

| 改动类型 | 范围 | 命令 |
|---------|------|------|
| 普通逻辑改动 | 同名前缀 glob | `X*.test.ts` |
| 缓存/不变量/前缀结构 | 整个模块目录 | `__tests__/*.test.ts` |
| 跨模块接线 | 所有受影响模块目录 | 各自的 `__tests__/*.test.ts` |

**判断标准**：如果改动涉及以下任一项，立即升级为目录级：
- exact-prefix cache 的字节布局（如本次）
- frozen/volatile/appendix 拼接顺序
- habituation tracker 的状态迁移
- 不变量注册表中列出的任何 killer

## N 太小自检

声称"N/N 全绿"时执行一条快速自检：

1. N 是否恰好是一个已知测试文件的测试数？→ 大概率只跑了那一个文件
2. N 是否远小于模块目录总测试数？→ 覆盖缺口
3. 有没有 `X-cache-stability`、`X-perf`、`X-integration` 等同名前缀文件存在？→ 是否被纳入了

**本案例**：N=33 是 `engine.test.ts` 的精确测试数，prompt 目录共 290+。两个信号同时触发——但被忽略了。

## 关联

- `[[feedback_adversarial-review-method]]`：fail-closed on tests pass — N/N 绿不等于验证完成
- `[[feedback_full-regression-after-parallel-work]]`：targeted tests miss cross-module regressions — 本次更隐蔽，同目录同模块
- `.rivet/knowledge/testing.md`：已知不可行测试路径
