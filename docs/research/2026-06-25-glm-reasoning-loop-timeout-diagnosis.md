# GLM 推理循环 + 超时 Abort 诊断（修正版）

> 诊断日期: 2026-06-25
> 会话: 77f3bbee (GLM-5.2, TUI), mqsyrjmu (GLM-5.2, 桌面端)
> 数据源: session JSONL + cache-log.jsonl + config.json + 源码

## 问题现象

GLM-5.2 模型在推理过程中被超时机制误杀（"The operation was aborted due to timeout"），导致会话 cleanExit: false。模型在正常推理（reasoning）时需要较长时间，框架的超时体系不支持这种工作模式。

## 已排除的错误假设（修正记录）

以下是诊断过程中犯过的错误，记录以防重蹈覆辙：

1. **"模型在循环探索不收敛"** — 错误归因。模型的行为是 GLM reasoning 模式的正常工作方式：深度推理 → 低 output → 工具调用 → 继续。这不是 bug，是 GLM 的特征。

2. **"上下文窗口撑不住了"** — 错误。当前会话最后一次 API 调用 input=145K，对 1M 窗口只有 14.5%。压缩阈值（GLM 在 40-50% = 400K-500K 时触发）远远没到。压缩正常工作，没触发是因为上下文占用太低。

3. **"压缩没触发是 bug"** — 错误。压缩机制正常工作。单次 input 远低于阈值，不触发是正确行为。

4. **"缩短超时时间解决循环"** — 错误方向。缩短超时 = 杀掉推理 = 破坏代码质量。GLM 的长推理是它产出高质量分析的方式。

5. **"这是系统级行为模式，DeepSeek 也有"** — 错误。这是 GLM 特有的问题，DeepSeek 没有这种程度的问题。当前会话实际是 GLM 不是 DeepSeek（meta.json 写 deepseek-v4-pro 但实际推理用 GLM）。

## 实际情况

### GLM 的正常工作模式

GLM-5.2 配置（config.json）:
- contextWindow: 1,000,000 (1M)
- reasoningEffort: high
- thinking: enabled (preserved thinking: clear_thinking=false)
- prefixCache: none（GLM 不支持前缀缓存）

GLM 的 reasoning 模式特征：
- 每轮 API 调用在 thinking 阶段花费大量时间（可能 30-60 秒甚至更长）
- visible output 很少（41-200 tokens/轮），但 reasoning tokens 很大
- preserved thinking（clear_thinking=false）意味着上一轮的推理 tokens 会保留到下一轮的上下文中，上下文增长比 visible output 快得多

### 超时配置现状

SSE 层（openai-client.ts:130-140）:
```
FIRST_BYTE_TIMEOUT_MS = 45_000
REASONING_FIRST_BYTE_TIMEOUT_MS = 90_000
GLM_READ_TIMEOUT_MS = 720_000 (12分钟，GLM + reasoning 专用)
SLOW_FIRST_BYTE_TIMEOUT_MS = 180_000
SLOW_READ_TIMEOUT_MS = 300_000

GLM 在 SLOW_THINKING_PROVIDERS 集合中
thinkingStallTimeoutMs: 默认未配置（=禁用）
Hard cap: baseStreamMs = 10分钟，自适应续期最长 3× = 30分钟
```

### 问题定位

用户看到的 "The operation was aborted due to timeout" 意味着某个超时层级触发了。需要确认是哪一层：

1. **SSE read timeout (720s)** — 对 GLM reasoning 可能够用，但如果模型深度推理时间超过 12 分钟就会被杀
2. **Hard cap (10min base, 30min max)** — 如果 reasoning delta 持续到达，硬顶会不断续期，最长到 30 分钟。但如果某个阶段 reasoning delta 停了 >30s，就会被 abort
3. **Turn 层 maxTurns** — 按调用次数计算，GLM 的调用次数高（因为每轮 output 少），可能在 maxTurns 耗尽时被终止
4. **Tool pipeline progressiveTimeout** — 按 session turn 数递增的超时，可能不匹配 GLM 的推理节奏

**需要在新会话中确认实际是哪一层触发了 abort**。方法：读 77f3bbee 会话 JSONL 中的 abort 错误消息，或在 openai-client.ts 中加 abort reason 日志。

### 为什么现有修复方向都是错的

之前文档建议的修复（P0-P3）全部围绕"缩短时间限制"，这等于在惩罚 GLM 的正常工作模式。正确方向应该是：

1. **确认 abort 来源** — 到底是 SSE 层、hard cap、maxTurns 还是 progressiveTimeout 杀的
2. **适配 GLM 推理节奏** — 不是缩短时间，而是让超时体系识别"模型还在正常推理"和"模型卡死了"的区别
3. **thinkingStallTimeoutMs 可以帮到** — 但方向不是缩短到 180s 杀掉推理，而是设一个合理的"无 delta 心跳"检测（比如 120s 内完全无 thinking delta = 可能卡死）

## 数据证据

### 77f3bbee (GLM, TUI) cache-log 摘要

23 次 API 调用，input 从 6.5K 增长到 65K（对 1M 窗口只有 6.5%）。大部分 output 41-200 tokens。cache 命中率 97-99%（GLM 服务端缓存，非框架前缀缓存）。compactEvents: []（未触发压缩，正确行为）。

meta.json: prompt=1,344,974（累计总和，非单次占用）, turnCount=2, toolCallCount=24, cleanExit=false

### mqsyrjmu (GLM, 桌面端) cache-log 摘要

80+ 次 API 调用，input 从 6K 增长到 145K（对 1M 窗口 14.5%）。compactEvents: []。这个会话的诊断过程中，模型（我）本身就演示了 GLM 的深度推理模式：读大量源码、逐步分析、产出少但每步都有据。

## 下一步（交给新会话）

1. **确认 abort 层级**: 读 session JSONL 找到实际的 abort error message，或 grep openai-client.ts 中 `throw new Error` 的 abort 路径，确认是哪个超时杀了 GLM

2. **检查三层超时对齐**: SSE read timeout (720s) → turn maxTurns → tool pipeline progressiveTimeout。GLM 的单次推理时间可能在 2-5 分钟，如果 maxTurns 或 progressiveTimeout 不匹配这个节奏，就会误杀

3. **方向**: 适配 GLM 推理节奏，不是缩短超时。GLM 需要的是"给足推理时间 + 检测真正的 stall（无 delta 心跳）"

4. **相关文件**:
   - `src/api/openai-client.ts:130-140` — 超时常量
   - `src/api/openai-client.ts:539-545` — GLM 专用超时选择逻辑
   - `src/api/openai-client.ts:509-527` — hard cap 机制
   - `src/agent/timeout-ladder.ts` — progressive timeout
   - `src/agent/phantom-continuation.ts` — 在无 tool call 回合注入 CONTINUATION（对 GLM 可能加剧循环）
   - `src/compact/constants.ts:14` — AUTO_COMPACT_THRESHOLD = 800K
   - `~/.rivet/config.json` — GLM provider 配置（contextWindow=1M, reasoningEffort=high）

5. **关键概念区分**:
   - 累计 token 消耗 ≠ 上下文窗口占用。meta.json 的 prompt 数字是所有调用 input 的总和，不代表窗口压力
   - 压缩阈值按单次 input token 设定（40-50%），GLM 的循环模式是低单次占用 + 高调用次数，永远不会在单次层面触发压缩
   - GLM 的 preserved thinking 使上下文增长比 visible output 快——reasoning tokens 保留在后续请求中

## 源码级根因确认（2026-06-25 天权域追加）

### SSE 层超时配置（verified）

`src/api/openai-client.ts`:

| 超时 | 值 | GLM 走哪条 | 判定 |
|------|-----|-----------|------|
| first-byte | `SLOW_FIRST_BYTE_TIMEOUT_MS = 180_000` (3min) | `isSlowProvider` → 3min | ✅ 够用 |
| read timeout | `GLM_READ_TIMEOUT_MS = 720_000` (12min) | `isGlm && isReasoning` | ✅ 够用 |
| idle timer | 每个 delta 后重置到 readMs (720s) | 每个 reasoning delta 都重置 | ✅ 够用 — 只要 delta 持续到达 |
| thinking stall | `thinkingStallTimeoutMs ?? readMs` → 720s (默认未配置) | 回退到 720s | ✅ 实际禁用 |
| **hard cap** | `baseStreamMs = 10min`，可续期到 `3× = 30min` | 进度窗口 `30s` | ⚠️ **嫌疑最大** |

### Hard cap 机制详解

`src/api/openai-client.ts:149-173`, `500-526`:

```
baseStreamMs = 10 * 60_000 (10min)
HARD_CAP_PROGRESS_WINDOW_MS = 30_000 (30s)   ← GLM 停顿 >30s 触发
HARD_CAP_EXTENSION_SLICE_MS = 60_000 (60s)
absoluteMaxMs = 3 × baseStreamMs = 30min
```

逻辑：
1. 流式开始后 10 分钟触发第一次 hard cap 检查
2. 检查 `lastDataEventAt`：如果最后的数据事件距今 > 30s → **abort**（即使模型后续还会产出）
3. 如果 ≤ 30s → 续期 60s，60s 后再次检查
4. 最多续到 30 分钟，之后无条件 abort

**致命组合**：GLM 深度推理时，单个 reasoning 周期可能花费 30-60 秒**不产出任何 delta**。如果这个停顿正好发生在 hard cap 的 10 分钟检查窗口内（`lastDataEventAt > 30s ago`），流就被杀了——即使模型在正常思考、即将产出下一个 delta。

这不是 `thinkingStallTimeoutMs` 能解决的问题，因为 thinking stall 检测的窗口是 720s（等于禁用）。真正的问题是 **hard cap 的 30s 进度窗口对 GLM 太窄**。

### progressiveTimeout 也构成威胁

`src/agent/timeout-ladder.ts:27-31`:

```
turn ≤ 1 → 60s
turn ≤ 4 → 120s
otherwise → 180s
```

此超时用于 worker/工具管道。如果 GLM worker 在 turn 1-2 做推理，60s 的 progressive timeout 加上 `WORKER_EXIT_GRACE_MS = 30s`（实际 90s 死线）仍然可能不够一个深度推理周期。

### 修复建议（具体）

1. **P0**: 对 GLM provider，将 `HARD_CAP_PROGRESS_WINDOW_MS` 从 30s 提升到 120s 或按 provider 配置。这是最可能的根因。
2. **P1**: 为 GLM worker 设置 `profile.defaultTimeoutMs` ≥ 300s（`profile-registry.ts`），覆盖 progressiveTimeout 的早期 60s 约束。
3. **P2**: 考虑配置 `thinkingStallTimeoutMs` 为 ~120s（针对 GLM），作为真正的"delta 心跳"检测——不是用 30s 硬窗口误杀正常推理。
