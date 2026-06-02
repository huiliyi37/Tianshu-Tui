# 缓存修复全流程记录：从 56% 崩溃到 97.5% 稳态

> **日期**: 2026-06-02
> **问题**: DeepSeek 会话在 turn 2 出现缓存命中率暴跌（56%），用户感知为"压缩/截断"
> **根因**: 动态附录（`cachedFreshBlock`）trailer-merge 进 lastUser 消息，turn 间动态内容变化导致字节不一致 → exact-prefix cache 断裂
> **最终方案**: 附录冻结进 user message（`ce34bdc`），frozen snapshot 保留完整内容，历史检索返回字节一致 → 缓存命中

---

## 一、问题发现与诊断

### 1.1 初始报告

用户在会话中发消息后触发"压缩和截断"。

### 1.2 消息结构分析

`buildOaiRequest` 的消息结构：

```
msg[0] (system)    | system prompt                   | 稳定
msg[1] (user)      | volatileBlock (FROZEN base)     | 稳定
msg[2..N-1]        | assistant/tool 历史              | 稳定
msg[N] (last user) | cachedFreshBlock + userContent  | 每次都变！
```

**关键**: prefix 前 2 条是稳定的，但 `cachedFreshBlock` 包含动态附录（toolHistory, taskProgress, sessionState 等），每次 turn 都变 → 最后一条 user message 字节变化 → exact-prefix cache 断裂。

### 1.3 ESC 中断流加剧问题

ESC 中断时的流程：
1. `agent.abort()` → 中止当前 run
2. TUI 把部分 assistant 回复 flush 成新消息（`pushAssistantEntry`）
3. 用户发新消息 → 新 `run()` 启动
4. 消息历史变成：原始历史 + ESC flush 的半截回复 + 新用户消息
5. 中间消息数量和内容变了 → cache 失效

---

## 二、修复迭代

### 2.1 P0: abort 路径跳过部分块 (`6d05c08`)

**改动**: `src/agent/loop.ts`

abort/streamError 路径中跳过 `addAssistantBlocks`，部分 assistant 回复不进入持久消息列表。

**效果**: 消除 ESC 中断后的消息污染。

**后续**: Agent 在 `eaf98ac` 中回退了此修复（认为"过度防御"），需在 `717bc99` 重新应用。

### 2.2 P2: TUI flush 合并 (`6d05c08`)

**改动**: `src/tui/app.tsx`

提取 `flushStreamingState()` 函数，消除 Ctrl+C/ESC/onAbort/onError 四处重复的 flush 逻辑。

### 2.3 P1: 动态附录独立化 (`8cfcad7`, `23419b7`)

**改动**: `src/prompt/engine.ts`, `src/prompt/volatile.ts`

核心变更：将动态附录从 `lastUserIdx` 的 trailer merge 改为独立追加在消息列表末尾。

```
之前: [sys, ..., lastUser_with_appendix]
之后: [sys, ..., lastUser_clean, appendix_msg]
```

**效果**: 
- Turn 2 命中率: 56.2% → 84.7%（+28.5pp）
- 命中率稳定性: 41pp 振幅 → 6pp 振幅
- 但出现新问题：命中率天花板 ~90%

**根因**: standalone appendix 消息位置每 turn 偏移（新 assistant/tool 消息插入在它前面），DeepSeek exact-prefix cache 无法匹配其字节。

### 2.4 P1b: 缓存友好附录 (`6bd0a19`)

**改动**: `src/prompt/volatile.ts`

1. 去掉动态 XML 属性（`recent`, `total`, `steps`）
2. 重排序：最稳定 section 放前面，最易变放后面
3. 缩减 `read-file-dedup-hint` 为单行

**效果**: 稳态峰值 98.3%，p50 cacheCreate ~2900。

### 2.5 天花板分析

用户指出：1M 窗口下，98% 命中率 = 2 万 tokens/轮 未缓存。1% 差距 = 成本数倍。

分析确认：standalone appendix 的位置偏移导致 ~1000 tokens/轮 固有开销，98% 是 standalone 架构的物理上限。

### 2.6 P1c/ce34bdc: 附录冻结进 user message (`ce34bdc`)

**改动**: `src/prompt/engine.ts`

将附录从独立消息移回 user message 内部，但放在 user content **之后**（而非之前的 `cachedFreshBlock + userContent`）：

```
结构: volatileBlock + '\n---\n' + userContent + '\n\n' + appendix
```

**关键洞察**: Frozen snapshot 现在保存完整内容（包括 appendix）。历史检索时 `getNextFrozen` 返回字节完全一致的内容 → DeepSeek exact-prefix cache 全量命中。

**效果**:
- v3 会话 (2f0d8e6a): 50 轮，稳态 97.5%，p50=431，62% 轮次 ≥99%
- v1 旧代码: 405 轮，稳态 99.1%，p50=312，93% 轮次 ≥99%

### 2.7 三版本对比 (`afbeae0`)

| 指标 | v1 trailer-merge | v2 standalone | v3 frozen |
|------|:---:|:---:|:---:|
| 稳态命中率 | 99.1% | 90.2% | **97.5%** |
| p50 create | 312 | 2,632 | **431** |
| ≥99% 占比 | 93% | 0% | **62%** |

### 2.8 长会话验证 (`c1e5bd1b`)

用户 agent 在 12:02 启动长会话测试：
- 22 轮，稳态 **95.3%**，p50=840
- 低于 v3 的 97.5%，但高于 v2 的 90.2%
- 可能原因：任务 profile 差异（v4 多次 read_file 大输出）或 sample size 小

**发现**: Agent 在 `eaf98ac` 中回退了 P0 修复，已在 `717bc99` 重新应用。

---

## 三、关键文件变更汇总

| 文件 | 变更 | 关联提交 |
|------|------|---------|
| `src/agent/loop.ts` | P0: abort 路径跳过 addAssistantBlocks | `6d05c08`, `717bc99` |
| `src/tui/app.tsx` | P2: TUI flush 合并 | `6d05c08` |
| `src/prompt/engine.ts` | P1: 独立附录 → P1c: 冻结附录 | `8cfcad7`, `ce34bdc` |
| `src/prompt/volatile.ts` | P1b: 缓存友好排序 | `6bd0a19` |
| `src/prompt/__tests__/` | 测试更新 | `23419b7`, `2013aef` |

---

## 四、待排查问题

1. **v3 (97.5%) vs v1 (99.1%) 的 1.6pp 差距**: 是 appendix 顺序差异（before vs after user content）还是 sample size 噪声？
2. **v4 (95.3%) 低于 v3 的原因**: 任务 profile（大量 read_file）vs 代码差异？
3. **Agent 的 eaf98ac 回退**: 为什么 agent 认为 P0 是"过度防御"？是否需要更好的注释说明？
4. **frozen snapshot eviction**: `MAX_FROZEN_USER_MERGED=64`，长会话中 eviction 后是否会影响缓存？

---

## 五、日志文件索引

| 版本 | 会话 ID | 路径 |
|------|--------|------|
| v1 旧代码 | `51e76a8b` | `.rivet/sessions/51e76a8b-.../cache-log.jsonl` |
| v2 standalone | `4db79137` | `.rivet/sessions/4db79137-.../cache-log.jsonl` |
| v3 frozen | `2f0d8e6a` | `.rivet/sessions/2f0d8e6a-.../cache-log.jsonl` |
| v4 长会话 | `c1e5bd1b` | `.rivet/sessions/c1e5bd1b-.../cache-log.jsonl` |
| 修复前基线 | `61af1cc0` | `.rivet/sessions/61af1cc0-.../cache-log.jsonl` |
