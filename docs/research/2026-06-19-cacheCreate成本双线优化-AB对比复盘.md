# cacheCreate 成本双线优化 — A/B 对比复盘

> **日期**: 2026-06-19  
> **涉及会话**: fe39a8ee (baseline), 0fefc90b (delta ON), ef0381c8 (B计划前), c3adbcb1 (B计划后)  
> **目标**: 量化 delta appendix + read-ref + command-filters 三项优化对 cacheCreate 的实际效果

---

## 一、优化项全景

| 计划 | 优化项 | 机制 | 状态 |
|------|--------|------|------|
| **A 计划** | Delta appendix | 稳态轮只发变更块，boundary 发 full baseline | ✅ default-on (任务7) |
| **A 计划** | resetAppendixBaseline hook | 压缩/rewind 后重置 baseline | ✅ 已修复覆盖 (任务6) |
| **B 计划** | read-ref (B1-B4) | 重复读同一文件返回紧凑引用 | ✅ default-on |
| **B 计划** | command-filters | tsc/test/git status 输出精简 | ✅ 已实现 |
| **遥测** | projChars/appendixChars | cache-log 记录 appendix 体量 | ✅ 已接入 |
| **遥测** | readRefSavedBytes/readRefCount | cache-log 记录 read-ref 命中 | ✅ 已接入 |

---

## 二、会话级 A/B 数据

### 2.1 Baseline vs Delta ON (A 计划效果)

| 指标 | fe39a8ee (delta OFF) | 0fefc90b (delta ON) | 变化 |
|------|----------------------|---------------------|------|
| 轮数 | 27 | 94 | — |
| 总 cacheCreate | 121,944 | 127,959 | — |
| 每轮均 cacheCreate | **4,516** | **1,361** | **-69.9%** |
| 稳态中位数 cacheCreate | 1,215 | 165 | **-86.4%** |
| 总命中率 | 94.8% | 98.8% | +4.0pp |
| Boundary 均 cacheCreate | 12,179 | 12,290 | +0.9%（持平）|

**结论**: delta 的收益在稳态轮间——中位数从 1,215 降到 165（-86.4%）。Boundary 首请求不可优化（必须发 full baseline）。

### 2.2 B 计划前后对比 (read-ref 效果)

| 指标 | ef0381c8 (ref OFF) | c3adbcb1 (ref ON) | 变化 |
|------|---------------------|-------------------|------|
| 轮数 | 99 | 39 | — |
| 总 cacheCreate | 196,643 | 41,139 | — |
| 每轮均 cacheCreate | **1,986** | **1,055** | **-46.9%** |
| 稳态中位数 cacheCreate | 304 | 328 | 持平 |
| Read-ref 命中 | 0 次 / 0 bytes | **348 次 / 2,143,007 bytes** | 新增 |
| 最终 input tokens | 221K (22.1%) | **58K (5.8%)** | **-74%** |
| read-ref 节省估算 | 0 | **~535K tokens** | — |

**结论**: read-ref 在 c3adbcb1 里命中 348 次，省了 2.14M bytes（约 535K tokens）。最终 context 只占 5.8% 窗口——极度健康。

### 2.3 三线齐发效果 (c3adbcb1 完整画像)

| 维度 | 数值 |
|------|------|
| 总轮数 | 39 |
| 稳态中位数 cacheCreate | 328 tokens |
| 稳态命中率 | 99.7% |
| Boundary cacheCreate | [15,612, 3,997, 5,602, ...] |
| Projection 占 appendix | 5.1% (avg 878 chars / 17,098 appendix) |
| Read-ref 累计节省 | 2,143,007 bytes (348 次命中) |
| command-filters 覆盖 | tsc + node:test + git status |

---

## 三、Projection 分析

projection 不进 delta diff，每轮全发。实测平均 558-878 chars，占 appendix 的 3.4-5.1%。

**结论**: projection 不是 delta 收益的瓶颈。3-5% 的占比不会显著影响 delta 的节省效果。

---

## 四、cacheCreate 尖峰根因分析

### 4.1 ef0381c8 尖峰 (ref OFF)

| turn | cacheCreate | 根因 |
|------|-------------|------|
| 16 | 11,443 | read_file 大文件 |
| 23 | 17,188 | **同一文件重复读 8+ 次** (goal-auto-continue.md) |
| 26 | 16,335 | 同上 |
| 38 | 13,664 | 同上 |

**根因**: `goal-auto-continue.md` 被反复读取 8+ 次，每次返回 ~17K chars 全文。read-dedup 触发了警告但 **仍然返回全文**（因为 RIVET_READ_REF 当时未开启）。

### 4.2 c3adbcb1 尖峰 (ref ON)

| turn | cacheCreate | 根因 |
|------|-------------|------|
| 0 | 15,612 | Boundary 首请求（系统 prompt + tools 预热）|
| 6 | 5,602 | 首次 read_file 新文件 |
| 其余 | <1,500 | 正常增量工具输出 |

**结论**: 开启 read-ref 后，8+ 次重复读取的 11-17K 尖峰全部消失。

---

## 五、恒等式验证

所有会话的 `input = cacheRead + cacheCreate` 恒等式检查：

| 会话 | 条目数 | 失败数 | 状态 |
|------|--------|--------|------|
| fe39a8ee | 27 | 0 | ✅ |
| 0fefc90b | 94 | 0 | ✅ |
| ef0381c8 | 54 | 0 | ✅ |
| c3adbcb1 | 39 | 0 | ✅ |

---

## 六、已实施的修复清单

| Commit | 内容 |
|--------|------|
| 5f82cfab | delta baseline reset on history rewrite |
| 426155a6 | RIVET_APPENDIX_DELTA env flag |
| 687fb7e2 | resetAppendixBaseline 全路径覆盖 (任务6 补全) |
| eb56acae | projChars/appendixChars 遥测字段 |
| 842a9121 | read-ref 判定收口 + RIVET_READ_REF |
| 2800bd91 | read-ref 紧凑引用替代全文重发 |
| 618d9f1e | read_section 支持 file_path |
| 1acbe053 | read-ref 遥测字段 |
| aedca12e | command-filters (tsc/test/git status) |
| 1d55bd95 | RIVET_READ_REF default-on |
| 9074ca71 | goal 中文完成标记 + maxIterations 联动 |
| 4f568f83 | goal-aware review gating |

---

## 七、后续迭代方向

### 7.1 已知问题 (待修)
- **reliability mode goal 豁免**: doom loop 检测器在 goal 长任务里过度触发（详见 `docs/handoff-goal-interrupt-issue.md`）
- **goal continuation 后中断**: `⏹ Interrupted` 发生在 turn 完成后、下一轮 API 前（根因待定位）

### 7.2 优化机会
- **output-filter 扩展**: 当前只有 tsc/test/git status 三个 filter，可加 `npm install`、`docker build`、`cargo` 等
- **projection delta 化**: projection 不进 diff 但只占 3-5%，优先级低
- **boundary cacheCreate 优化**: 12K/次的 boundary 尖峰不可通过 delta 优化——需要减少 appendix 本身体量或让 provider 的前缀缓存跨 boundary

### 7.3 对比基线
后续迭代时，用本文档的 c3adbcb1 数据（稳态中位数 328、命中率 99.7%、context 5.8%）作为新基线。每次优化后跑一个 39+ 轮的 goal 会话，对比这些指标。
