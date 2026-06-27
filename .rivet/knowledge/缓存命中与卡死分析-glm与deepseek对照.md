---
日期: 2026-06-18
涉及 session:
  - ee3e768b-c746-47bf-aa45-2a8a71110ef5 (deepseek-v4-pro，本会话本身)
  - 1d7958f2-65d0-4dd4-9253-a74a85bcdfbb (glm-5.2，卡死排查会话)
  - b2d09d84-1953-415f-b3c7-1b940025b44a (glm-5.2，对照)
数据源:
  - cache-log.jsonl (`~/.rivet/sessions/<slug>/<id>/`，每 turn 记录 t/turn/model/input/cacheRead/cacheCreate/hitRate)
  - 主 transcript (`~/.rivet/sessions/<slug>/<id>.jsonl`，无时间戳，仅对话行为)
---

# 缓存命中与卡死分析（GLM vs DeepSeek）

## 0. 背景与核心结论

排查「TUI 频繁卡死」时，对 GLM 与 DeepSeek 两组会话的 cache-log 做对照分析。

**核心结论：**
1. **GLM 的 cacheCreate 恒为 0 是字段缺失，不是异常** — GLM 不返回 `prompt_cache_miss_tokens`，代码 `?? 0` 兜底。两个 GLM 会话全程 0，DeepSeek 正常有值。
2. **1d7958f2（GLM）的卡死根因是 `native-resolver.js` 打包路径断裂**，已在 `ddd9a210` 修复。与缓存无关。
3. **ee3e768b（DeepSeek）唯一真异常是 row136 的一次缓存换出**（rd -72704），其余低命中与 stall 是 input 增长和用户输入间隔。

---

## 1. cacheCreate = 0 的代码根因（GLM）

GLM 走 `openai-client.ts`（providerName='glm'）：

```ts
// src/api/openai-client.ts:657-659
const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
cache_read_input_tokens:      cacheRead,
cache_creation_input_tokens:  usage.prompt_cache_miss_tokens ?? 0,   // ← GLM 不返回此字段
```

- `cacheRead` 有值：GLM 返回 `prompt_cache_hit_tokens`，值真实可信。
- `cacheCreate` 恒 0：GLM 不返回 `prompt_cache_miss_tokens`，`?? 0` 兜底。

**这不是异常，不影响命中分析**（rd 仍真实）。DeepSeek 同时返回两个字段，所以 ee3e768b 的 cacheCreate 完整。

---

## 2. 1d7958f2（GLM）卡死分析

### 2.1 现象
- 用户在 TUI 报告「双层输入框」「一直卡」。
- cache-log 显示同 episode 内 rd 暴跌（ep3 turn0→1：rd 11884→8454，input 仅 +1168）。
- stall 频率 ~2.5/10min（对照 b2d09d84 仅 1.0/10min）。

### 2.2 真根因（主 transcript 记录的）
该会话本身就在排查这个 bug，并已修复：

- `src/repo/meridian-db.ts` 用 `createRequire(import.meta.url)('./native-resolver.js')` 加载 native 模块。
- tsup 打包后，主 chunk（`dist/chunk-EQ6XDSCY.js`）里这条 require 的**相对路径断裂** → 运行时 `Cannot find module './native-resolver.js'`。
- `better_sqlite3.node` 加载失败 → MeridianDb 索引降级 → 错误处理路径触发 TUI 重复渲染 → **双层输入框、界面卡死**。

### 2.3 修复
提交 `ddd9a210`（`fix(repo): native-resolver 打包路径断裂 — createRequire 相对路径改 ESM static import`）：

```ts
// 修复后 — src/repo/meridian-db.ts:5
import { resolveBetterSqlite3 } from './native-resolver.js'
```

### 2.4 曾经的错误推断（已撤回）
- ~~TUI 渲染残液（spinner/状态栏）泄漏进 user message 打碎缓存~~ — 那是用户卡死后主动粘贴的报错截图，是结果不是原因。
- ~~rd 暴跌导致卡死~~ — 时间对不上（污染消息在 ep0/1，rd 暴跌在 ep3），因果强行拼接。

---

## 3. ee3e768b（DeepSeek）缓存分析

### 3.1 数据概览（分析时 189 行，会话进行中）
- 累计 input：36,231,191
- 累计 cacheRead（命中）：35,723,264
- 累计 cacheCreate：507,927（约 50.8 万）
- 整体命中率：98.6%
- **`input = cacheRead + cacheCreate` 严格成立**（189 行全部满足，差 = 0）

### 3.2 所有异常点（纯列出）

**cacheRead 下降（仅 2 处）：**

| 行 | turn | 位置 | rd 变化 | input 变化 | 说明 |
|---|---|---|---|---|---|
| row90 | 0 | 边界 | 157824→129280（-28544） | +11047 | 新 round 起步，上一段 28k 没接上 |
| **row136** | **46** | **轮内** | 251136→178432（**-72704**） | **+624** | input 几乎没涨，命中蒸发 7.2万；injected 1→3 |

**命中率 <95%（共 15 处）：** 轮内 9 处（多为 input 暴涨 12-13k 的正常增长），边界 6 处（episode 起步）。

**gap ≥30s（共 11 处）：** 边界 10 处（用户输入间隔，最长 181s），轮内 4 处。

**diagnose 字段（仅 1 处）：** row136 触发 `normal_growth: Cache hit 71% — new messages partially outside cached prefix`（诊断不准，row136 是缓存换出不是新消息增长）。

### 3.3 轮内 vs 用户边界

| 维度 | 轮内（turn>0） | 用户边界（turn=0） |
|---|---|---|
| cacheRead 下降 | **1（row136）** | 1（row90） |
| 命中率 <95% | 9 | 6 |
| cacheCreate >3000 | 12 | 12 |
| gap ≥30s | 4 | 10 |

**真异常只有 2 处**（都是 rd 坍缩型）：row136（轮内，injected 突跳）、row90（边界，新 round 起步没接上）。其余低命中是 input 增长，gap 是用户输入间隔。

### 3.4 未命中（cacheCreate）50.8 万来源分解

| 来源 | 行数 | token | 占比 |
|---|---|---|---|
| episode 起步（turn0，每轮新用户消息） | 18 | 235,502 | 46.4% |
| 大块吃入（轮内，每次 +12k 上下文） | 11 | 114,978 | 22.6% |
| **大坍缩（row136 那一次）** | **1** | **73,464** | **14.5%** |
| 中等增量（1k-5k） | 22 | 39,566 | 7.8% |
| 常规增量（<1k） | 137 | 44,417 | 8.7% |

**85% 是正常增长，只有 14.5%（row136）是异常坍缩的被迫重建。**

### 3.5 「每轮写入的 1 万」是什么

正常 turn0 的 cacheCreate ≈ input 增量（差 < 100），这 1 万是新 round 第一次请求**新增进 input 的内容**：

| 行 | input 增量 | cacheCreate | 差 |
|---|---|---|---|
| row25 | 10656 | 10676 | 20 |
| row30 | 10513 | 10596 | 83 |
| row40 | 10194 | 10163 | -31 |

构成 = 上一轮结束时的尾部内容：
1. 上一轮最后 assistant 文本输出（总结性回复）
2. 上一轮最后的工具结果（bash/run_tests 等可能很大）
3. 新的 user 消息
4. system-reminder 注入

前缀缓存只覆盖到上一轮请求结束的 message 边界，上一轮"生成"的 output 和本轮才输入的 user 消息，到这一轮才首次写入。

**例外 row90（cr=39690）：** input 增量仅 11044，cacheCreate 39690，差 28646 ≈ rd 下降（28544）。即 `cr = 新内容(11044) + 缓存换出重建(28646)`。

---

## 4. 关键代码位置

| 用途 | 文件:行 |
|---|---|
| cache-log.jsonl 写入（含 model/diagnose/breadcrumbs） | `src/agent/loop-factory.ts:59-110` |
| OpenAI/GLM usage 解析（cacheRead/cacheCreate 映射） | `src/api/openai-client.ts:643-660` |
| GLM provider 特征门控 | `src/api/openai-client.ts:75,207,223,595-630` |
| native-resolver 打包修复 | `src/repo/meridian-db.ts:5`（提交 ddd9a210） |

---

## 5. 方法论教训

- **先看 session 主 transcript 记录了什么**，再碰 cache-log。本次 1d7958f2 的根因在 transcript 里写得清清楚楚（它自己就是排查会话），却盯着 cache-log 查缓存查错方向。
- **cache-log 只有 `t = Date.now()`（API 调用完成时刻）**，无调用开始时间、无 latency。gap 无法区分「GLM 慢 / 工具慢 / 网络抖」。要查真实延迟需换数据源（cliproxy 访问日志）。
- **cache-log 的 diagnose/breadcrumbs 字段在 GLM 会话全程缺失**，诊断分支未生效；DeepSeek 仅 row136 触发一次且归因不准。
- **不要用「跟 memory 某条同族」代替查代码** — 记忆是参考不是证据，代码才是。
