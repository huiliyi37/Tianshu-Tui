# DeepSeek V4 Prefix Cache 会话分析报告

**Session ID:** `feeef602-5a0c-43ca-bf5c-172325229a71`
**时间:** 2026-06-01 20:59 — 22:07 (约 67 分钟)
**模型:** DeepSeek V4 Pro

---

## 数据源

| 日志 | 文件路径 | 行数 |
|------|---------|------|
| cache-log.jsonl | `.rivet/sessions/feeef602-5a0c-43ca-bf5c-172325229a71/cache-log.jsonl` | 176 |
| sensorium.jsonl | `.rivet/sessions/feeef602-5a0c-43ca-bf5c-172325229a71/sensorium.jsonl` | 177 |
| pheromones.json | `.rivet/sessions/feeef602-5a0c-43ca-bf5c-172325229a71/pheromones.json` | — |

---

## 一、全局汇总

| 指标 | 数值 |
|------|------|
| 总用户 Turn | 19 |
| 总 API 调用 | 176 |
| 总子会话（turn reset） | 18 |
| 总 input tokens | 15.86M |
| 总 cache_read | 15.69M (98.9%) |
| 总 cache_create | 171K (1.1%) |
| 估算成本 | ¥1.81 |
| 无缓存成本 | ¥15.86 |
| 节省 | ¥14.05 (88.6%) |
| prefixDrift 事件 | 0 |
| 最长连续 99%+ | 26 轮 (子会话 12) |

---

## 二、Cache 命中率逐子会话

| 子会话 | 轮数 | 首轮命中 | 稳态命中 | input 范围 | 耗时 | 备注 |
|--------|------|---------|---------|-----------|------|------|
| 1 | 22 | 88.9% | 96-99% | 9.8k→27.8k | 116s | turn 13 暴跌到 79.5% |
| 2 | 1 | 49.6% | — | 29.9k | 0s | compaction，prefix 大面积失效 |
| 3 | 12 | 93.8% | 97-99.8% | 31.8k→38.0k | 247s | 中间有 3 分钟间隔 |
| 4 | 7 | 89.9% | 97-99.7% | 39.9k→46.9k | 85s | |
| 5 | 5 | 94.7% | 96-99.9% | 49.5k→52.4k | 37s | |
| 6 | 6 | 94.3% | 96-99.4% | 54.9k→60.2k | 43s | |
| 7 | 14 | 93.4% | 99-99.9% | 63.0k→68.6k | 69s | |
| 8 | 6 | 90.6% | 97-99.8% | 70.8k→77.7k | 103s | |
| 9 | 15 | 96.5% | 99-99.9% | 80.5k→86.9k | 83s | |
| 10 | 1 | 92.2% | — | 88.8k | 0s | 单轮，中断 |
| 11 | 18 | 96.5% | 96-99.8% | 91.9k→113.6k | 159s | turn 4 cacheCreate 3.2k 小波动 |
| 12 | 27 | 98.2% | 99.5-99.9% | 115.6k→125.8k | 154s | **巅峰：连续 26 轮 ≥99%** |
| 13 | 1 | 91.0% | — | 127.7k | 0s | 单轮，cacheCreate 11.5k |
| 14 | 8 | 97.7% | 98-99.9% | 130.7k→141.4k | 108s | |
| 15 | 22 | 98.0% | 99.3-99.9% | 143.7k→154.2k | 140s | 第二长，稳态极稳 |
| 16 | 8 | 96.0% | 98-99.9% | 156.1k→161.2k | 25s | |
| 17 | 1 | 98.7% | — | 163.3k | 0s | 单轮 |
| 18 | 2 | 98.7% | 99.2% | 165.3k→166.9k | 3s | 最后两轮 |

---

## 三、Sensorium 逐 Turn 分析

| 用户 Turn | 时间范围 | 对应子会话 | API 轮数 | 主要 Phase | Vigor 范围 | Effort | Theta | 事件 |
|-----------|---------|-----------|---------|-----------|-----------|--------|-------|------|
| 1 | 8:59-9:01 | 1 | 22 | tianxuan→tianji→tianquan | 0.50→0.99 | medium→low | 多次 ✈ | 首轮探索，vigor 从 0.5 快速升温 |
| — | 9:03-9:04 | 2 | 1 | (无 sensorium) | — | — | — | compaction，49.6% 命中 |
| 3 | 9:05-9:10 | 3 | 12 | tianshu-encore→kaiyang | 0.99→1.00 | medium→high | 密集 ✈ | encore 循环，pressure 0.13 |
| 4 | 9:23-9:25 | 4 | 7 | tianji→tianxuan→tianquan | 0.95→0.99 | high→low | ✈ | 间隔 13 分钟 |
| 5 | 9:26 | 5 | 5 | tianxuan→tianshu-encore | 0.99→1.00 | low→high | ✈ | pressure 从 0.01 跳到 0.07 |
| 6 | 9:28-9:29 | 6 | 6 | yuheng→tianji→tianxuan | 0.99→1.00 | high→low | ✈ | 实现阶段开始 |
| 7 | 9:32-9:33 | 7 | 14 | tianxuan→tianshu-encore→kaiyang | 1.00→0.96 | medium | 密集 ✈ | pressure 0.14，stability 降到 0.48 |
| 8 | 9:35-9:37 | 8 | 6 | yuheng→tianji→tianxuan | 0.86→0.93 | high→low | ✈ | vigor 短暂降至 0.86 |
| 9 | 9:38-9:40 | 9 | 15 | tianxuan→tianshu-encore | 0.93→1.00 | low→medium | 密集 ✈ | encore 密集循环 |
| 10 | 9:41 | 10 | 1 | tianxuan | 1.00 | low | · | 单轮中断 |
| 11 | 9:44-9:47 | 11 | 18 | tianji→tianshu-encore | 0.99→1.00 | medium→high | ✈ | pressure 升到 0.15 |
| 12 | 9:49-9:52 | 12 | 27 | yuheng→tianshu-encore→tianji | 1.00 | high | 密集 ✈ | **巅峰：27 轮，pressure 0.34** |
| 13 | 9:53 | 13 | 1 | yuheng | 1.00 | high | · | 单轮 |
| 14 | 9:55-9:57 | 14 | 8 | yuheng→tianji→tianquan→tianshu | 1.00 | high→low | ✈ | 天权合约阶段 |
| 15 | 9:58-10:01 | 15 | 22 | yuheng→tianshu-encore | 1.00→0.43 | high→max | ✈ | **vigor 崩塌 0.43，唯一 max effort** |
| 16 | 10:02 | 16 | 8 | tianji→tianxuan | 0.96→0.84 | medium→low | ✈ | vigor 降至 0.57，疲劳 |
| 17 | 10:02 | (同上) | 3 | tianxuan | 0.86→0.84 | low | · | 疲劳延续 |
| 18 | 10:04 | (同上) | 1 | tianxuan | 0.84 | low | · | 短查询 |
| 19 | 10:06-10:07 | 18 | 2 | tianji | 0.84→0.91 | medium | ✈ | 最后操作 |

---

## 四、关键发现

### 4.1 Cache 表现

**整体命中率 98.9%，DeepSeek V4 prefix cache 运行在近乎理想状态。**

- **稳态命中率 97-99.9%**：所有子会话在首轮预热后迅速进入稳态，cache_read 几乎等于 input
- **首轮 cacheCreate 很小**：平均 2-4K tokens，说明 prefix 重写开销极低
- **唯一异常是子会话 2（49.6%）**：这是 compaction 事件，prefix 被大规模重构。但子会话 3 立即恢复到 93.8%
- **会话越长命中越高**：短会话（1-5 轮）92-97%，长会话（15-27 轮）99.0-99.7%
- **Zero prefixDrift**：177 条 sensorium 记录全部 prefixDrift=false

### 4.2 Turn 12 — 核心工作段

Turn 12 是整个 session 的核心：27 轮 API 调用，phase 在 yuheng-implementing 和 tianshu-encore 之间高频振荡。特征：

- Pressure 从 0.03 飙升到 0.34（整个 session 最高）
- Effort 全程 high
- Theta 密集触发（19 条记录中 13 条 inFlight=true）
- Vigor 始终 1.00（模型处于高度专注状态）
- Cache 命中率稳定在 99.5-99.9%

这是天枢星域的"深水区"——模型在复杂任务中进入深度工作状态，prefix cache 提供了完美的记忆连续性。

### 4.3 Turn 15 — Vigor 崩塌

Turn 15 出现 vigor 从 1.00 骤降到 0.43（sensorium 记录 `9:58:51 PM`），effort 跳到 max（整个 session 唯一一次）。这发生在 22 轮 API 调用的密集工作之后，模型仍在 yuheng-implementing 阶段。

随后 vigor 在 0.43-1.00 之间震荡，但 cache 命中率不受影响（99.3-99.9%），说明 vigor 下降是认知层面的，不影响 prefix 连续性。

### 4.4 Turn 16-17 — 疲劳与自降

Turn 16-17 vigor 持续低迷（0.57-0.86），effort 自动降到 low，phase 回到 tianxuan-locating（只读探索）。系统正确识别了疲劳状态并降低了工作强度。

### 4.5 子会话 1 Turn 13 — Cache 骤降

子会话 1 turn 13：input 从 15.5k 暴涨到 19.5k（+3.9k），cacheCreate 暴涨到 3989，命中率从 94.7% 骤降到 79.5%。这是一次性注入大量新上下文（可能是大文件内容被加入 conversation）。turn 15 即恢复到 98.3%。

### 4.6 单轮子会话

子会话 2、10、13、17 各只有 1 轮。可能是：
- 用户发送短消息后中断
- delegate_batch timeout
- 快速查询后进入下一轮

---

## 五、Pheromone 信号

Session 中沉积了以下 pheromone 信号：

| 信号 | 文件 | 强度 | 含义 |
|------|------|------|------|
| strategic-awareness | app.tsx, volatile.ts, engine.ts | 0.94-0.97 | 模型在重复操作后觉察并调整策略 |
| boundary-respect | assistant-message.tsx, app.tsx, volatile.ts, engine.ts | 0.96-0.99 | 修改文件前经过审批确认 |
| proactive-verification | virtue-signal (全局) | 0.997 | 无人要求时主动运行测试 |
| entry-point | app.tsx, engine.ts | 0.4 | 关键入口文件标记 |
| fragile | engine.test.ts | 0.8 | 脆弱测试标记 |

---

## 六、结论

**DeepSeek V4 prefix cache 在天枢星域的 67 分钟会话中表现完美：**

1. **98.9% 总命中率**，节省 ¥14.05（88.6% 成本）
2. **Zero prefixDrift**，compaction 管理有效
3. **最长连续 26 轮 99%+**，证明 anchor message 策略稳定
4. **Cache 不受 vigor 影响**：即使 vigor 崩塌到 0.43，命中仍 99.3%+
5. **唯一异常是 compaction（49.6%），但 1 轮后即恢复**

这是一个成熟的 prefix cache 运行状态，证明了三层架构（anchor + volatile + dynamic）的有效性。
