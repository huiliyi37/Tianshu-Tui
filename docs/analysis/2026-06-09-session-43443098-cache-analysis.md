# 会话 43443098 缓存分析报告

> 分析时间：2026-06-09  
> 分析者：天枢  
> 模型窗口：DeepSeek **1M** context window（此前误记为 200K，已修正）

## 相关日志路径

| 日志 | 路径 | 说明 |
|------|------|------|
| 会话目录 | `.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/` | 完整会话数据 |
| 缓存日志 | `.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/cache-log.jsonl` | 113 条 API 调用缓存命中记录 |
| 认知状态 | `.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/sensorium.jsonl` | 533 条 sensorium 状态采样（114 条有完整字段） |
| 信息素轨迹 | `.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/pheromones.json` | 16 条行为信号轨迹 |

> 注：三个文件均在 `.gitignore` 中，不会进入版本控制。

## 概况

| 指标 | 值 |
|------|-----|
| 总 API 调用 | 113 次 |
| 时间跨度 | 22.4 分钟 |
| 用户消息 | 11 条 |
| 平均命中率 | 97.8% |
| 最低命中率 | 77.0%（msg#1 冷启动） |
| <95% 命中率次数 | 16/113 (14.2%) |
| 最终上下文 | 201,546 / 1,000,000 (**20.2%**) |
| 窗口压力 | 全程 < 0.07（远低于阈值） |

## Token 递进（1M 窗口）

| 用户消息 | input tokens | 占比 | 增量 | 状态 |
|---------|-------------|------|------|------|
| msg#1（初始） | 18,645 | 1.9% | — | OK |
| msg#2 | 67,619 | 6.8% | +48,974 | OK |
| msg#3 | 79,324 | 7.9% | +11,705 | OK |
| msg#4 | 90,921 | 9.1% | +11,597 | OK |
| **msg#5** | **136,075** | **13.6%** | **+45,154** | OK（但缓存暴跌） |
| msg#6 | 140,475 | 14.0% | +4,400 | OK |
| msg#7 | 154,526 | 15.5% | +14,051 | OK |
| msg#8 | 169,270 | 16.9% | +14,744 | OK |
| msg#9 | 185,919 | 18.6% | +16,649 | OK |
| msg#10 | 190,355 | 19.0% | +4,436 | OK |
| msg#11 | 201,546 | 20.2% | +11,191 | OK |

**结论**：1M 窗口下从未触发容量压力或压缩。问题在成本侧，不在容量侧。

## 缓存异常事件

### 三大类 cacheCreate 大户（>1000 tokens 重建）

| 排名 | 事件 | create | 命中率 | input | 原因 |
|------|------|--------|--------|-------|------|
| 1 | msg#5 turn=0 | 20,363 | 85.0% | 136,075 | msg#4 28-turn 工具链后前缀漂移 |
| 2 | msg#1 turn=2 | 5,697 | 77.0% | 27,243 | 冷启动：系统提示词首次缓存写入 |
| 3 | msg#9 turn=0 | 14,015 | 92.5% | 185,919 | msg#8 20-turn 工具链后前缀漂移 |
| 4 | msg#5 turn=7 | 6,857 | 95.4% | 142,368 | msg#5 中段工具密集区 |
| 5 | msg#5 turn=15 | 3,580 | 97.0% | 120,444 | msg#5 中段工具密集区 |
| 6 | msg#3 turn=0 | 3,345 | 93.3% | 79,324 | msg#2 长回复后前缀重建 |
| 7 | msg#7 turn=0 | 11,550 | 92.5% | 154,526 | msg#6 12-turn 工具链后前缀漂移 |
| 8 | msg#1 turn=1 | 4,609 | 89.7% | 44,801 | 冷启动余波 |
| 9 | msg#1 turn=11 | 4,678 | 91.7% | 56,134 | 冷启动余波 |
| 10 | msg#11 turn=0 | 4,554 | 97.7% | 201,546 | msg#10 后常规重建 |

### 消耗速率

| 消息间 | 耗时 | 增量 | 速率 |
|--------|------|------|------|
| msg#1→2 | 197s | +48,974 tok | 247 tok/s |
| msg#2→3 | 76s | +11,705 tok | 154 tok/s |
| msg#3→4 | 94s | +11,597 tok | 123 tok/s |
| **msg#4→5** | **207s** | **+45,154 tok** | **218 tok/s** |
| msg#5→6 | 44s | +4,400 tok | 99 tok/s |
| msg#6→7 | 185s | +14,051 tok | 76 tok/s |
| msg#7→8 | 204s | +14,744 tok | 72 tok/s |
| msg#8→9 | 131s | +16,649 tok | 127 tok/s |
| msg#9→10 | 69s | +4,436 tok | 64 tok/s |
| msg#10→11 | 108s | +11,191 tok | 103 tok/s |

平均每条用户消息消耗 ~12K tokens（不含冷启动）。

## 逐异常对照分析

### ① msg#1 冷启动低谷 hr=77%（ts≈1781222457）

**sensorium 对照**：无数据。首条 sensorium 记录在 ts=1781222664（+207s），冷启动阶段 sensorium 还未开始采集。

**cache-log**：msg#1 的前 15 个 turn 有 11 次 hitRate <95%，最低 77.0%。turn=0 的 cacheCreate=5,697 是全场第二高。

**结论**：**正常**。系统提示词 + 工具定义需要首次请求才能写入前缀缓存。77% 的命中率反映的是「首次缓存创建」的固有代价。DeepSeek API 在首次请求时无法命中任何前缀。

### ② msg#4→5 暴增 +45,154 tokens（ts≈1781223245）

这是全场最关键的一次跳变。

**sensorium 对照**：

| 时间点 | ts | turn | pressure | complexity | effort | prefixDrift |
|--------|----|------|----------|------------|--------|-------------|
| msg#4 最后 | 1781223163 | 28 | 0.0478 | 0.6 | medium | False |
| msg#5 入口 | 1781223210 | 0 | 0.0482 | 0.6 | medium | False |
| msg#5 稳定 | 1781223276 | 0 | 0.0491 | 0.6 | medium | False |

**pheromones 对照**：msg#4 时段有密集的 `strategic-awareness` 信号，路径包括 `src/agent/loop.ts`、`src/prompt/static.ts`、`src/prompt/volatile.ts`、`src/prompt/engine.ts`，以及大量 `cat`、`find`、`ls` 命令路径。

**根因**：msg#4 跑了 **28 个 turn** 的工具调用链（read/grep/find/cat 密集操作）。每个工具结果都作为 assistant/tool message 插入对话历史中间，破坏了前缀连续性：

```
正常缓存路径：
  [system prompt] [volatile] [msg1] [reply1] [msg2] ...
  ┕── prefix ──┘ └── stable, 99%+ hit ──────────┘

实际发生：
  [system prompt] [volatile] [msg1] [reply1] [tool_result_1] ... [tool_result_28] [msg5]
  ┕── prefix ──┘ └─────── 28 个工具结果插入中间 ───────────────┘
                                                  ┕── 前缀断裂，后段全部 cacheCreate ──┘
```

**关键盲区**：pressure 从 0.0478→0.0482，仅 +0.0004。1M 窗口下 45K 增量微不足道，不会触发任何阈值。prefixDrift 始终 False。

### ③ msg#7 turn=0 create=11,550（ts≈1781223528）

**sensorium 对照**：

| 时间点 | ts | turn | pressure | prefixDrift |
|--------|----|------|----------|-------------|
| msg#6 最后 | 1781223473 | 1 | 0.0529 | False |
| msg#7 最近 | 1781223525 | 6 | 0.0550 | False |

**根因**：同 ②。msg#6 有 12 个 turn 的工具调用，中间结果积累导致前缀断裂。cacheCreate=11,550 tokens 需要重建。

### ④ msg#9 turn=0 create=14,015（ts≈1781223773）

**sensorium 对照**：

| 时间点 | ts | turn | pressure | prefixDrift |
|--------|----|------|----------|-------------|
| msg#8 最后 | 1781223752 | 20 | 0.0615 | False |
| msg#9 入口 | 1781223797 | 0 | 0.0618 | False |

**根因**：同 ②。msg#8 有 **20 个 turn** 的工具调用链。

## 系统级诊断

### 监控盲区

| 监控维度 | 当前状态 | 问题 |
|---------|---------|------|
| `prefixDrift` | 全程 `False` | 二值布尔型，无法反映 4-20K 的重建规模。应改为数值型 |
| `pressure` | 按 1M 窗口计算 | 200K 只占 20%，45K 跳变只 +0.0004。无法反映缓存成本 |
| `hitRate < 95%` | 有记录 | 16/113 次低于 95%，但无联动告警 |
| `complexity` | 正常波动 | 0.2-0.6 之间，与缓存异常无关联 |
| `reasoningEffort` | high→medium→low 周期 | 正常适应行为，与缓存异常无关 |

### 三条共性问题

1. **长 turn 工具链（20-28 轮）是缓存杀手**：每轮工具结果都插入对话中间，破坏前缀连续性。这不是单次异常，而是结构性问题——每条用户消息后如果模型做多轮工具调用，下一条用户消息入口必然出现大量 cacheCreate。

2. **prefixDrift 检测完全失效**：全程 533 条记录无一为 True。但 cache-log 显示有 5 次 cacheCreate > 4000。检测器的实现逻辑需要审计。

3. **1M 窗口的成本盲区**：容量永远不是问题（20%），但缓存重建成本是真实的额外计费。每次 turn=0 重建 4-20K tokens × cache-create 单价 = 隐形成本。

## 可行动项

| 优先级 | 行动 | 关联文件 |
|--------|------|---------|
| P1 | `prefixDrift` 从 boolean 改为数值型（cacheCreate/input 比率） | `src/agent/sensorium*.ts` |
| P1 | 审计 prefixDrift 检测逻辑为什么始终返回 False | `src/cache/prefix-cache*.ts` |
| P2 | pressure 增加缓存成本维度，不只有窗口占比 | `src/agent/sensorium*.ts` |
| P2 | 工具结果走 artifact 存储 + rawPath 引用，减少对话中注入 | `src/tools/output-store.ts`（本次已修截断 footer） |
| P3 | 长 turn 链（>15 turn）后主动提示前缀漂移风险 | `src/agent/loop.ts` |
| ✅ 已落地 | cache-log 增加 model 字段（commit 68ca09f） | `src/agent/loop.ts` |

> **本会话的 cache-log 无 model 字段**——会话 43443098 发生在 68ca09f 合入之前，日志格式为旧版（t/turn/input/cacheRead/cacheCreate/hitRate/userMsgs）。后续新会话的 cache-log 将自动携带 model 字段，可用于跨模型缓存行为对比。

## 数据复现

如需复现本分析，运行：

```bash
# 缓存日志分析
python3 -c "
import json
with open('.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/cache-log.jsonl') as f:
    lines = [json.loads(l) for l in f if l.strip()]
print('Total:', len(lines), 'entries')
# 按 userMsgs 分组取最后一条
seen = {}
for l in lines:
    seen[l['userMsgs']] = l
for um in sorted(seen):
    l = seen[um]
    print('msg#%d: input=%d hitRate=%s create=%d' % (um, l['input'], l['hitRate'], l['cacheCreate']))
"

# Sensorium prefixDrift 检查
python3 -c "
import json
with open('.rivet/sessions/43443098-a544-4cb8-8a54-0b158e23952c/sensorium.jsonl') as f:
    lines = [json.loads(l) for l in f if l.strip()]
full = [l for l in lines if 'prefixDrift' in l]
drift_true = [l for l in full if l.get('prefixDrift') == True]
print('prefixDrift=True:', len(drift_true), '/', len(full))
"
```
