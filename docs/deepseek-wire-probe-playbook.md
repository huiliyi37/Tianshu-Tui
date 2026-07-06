# DeepSeek 线上行为实测手册 — usage 帧位置 / 双发风险 / 缓存单元语义

> 2026-07-07 凌晨实测留档。起因：v2.15 缓存回归复盘中发现侧路 usage 记账依赖
> `onStopReason` 回调语义，而官方文档与线上真实行为存在两处不符。本文记录完整的
> 测试方法（离线模拟 + 线上探测）、当日实测基线与判读规则，供行为漂移怀疑时复用。
>
> 关联：`docs/changelog/2026-07-06-llm-speculation-suffix-double-append.md`（侧路记账背景）、
> `docs/changelog/2026-07-07-v2.15-cache-regression-chain.md`（事故链总览）。

## 一、要回答的三个问题

1. **usage 在流的哪一帧？出现几次？** —— 决定 `processDelta` 两条 usage 路径
   （合并帧 L1074 / 尾部 usage-only 帧 L992）哪条真实命中，以及"双发重复记账"是否可能。
2. **缓存落盘粒度与跨请求命中规则是什么？** —— 决定 compact 锚点复用、append-only
   设计、侧路请求蹭主缓存这些成本模型是否成立。
3. **文档能信到什么程度？** —— DeepSeek 文档在这两处都与线上不符（见基线），
   涉及计费与缓存的行为判断一律实测优先。

## 二、测试前置：key 的解析

- 优先 `DEEPSEEK_API_KEY` 环境变量；**注意 2026-07-07 事故**：`.zshrc` 里的 env key
  已失效（401 `****6ac0`），现役 key 在 `~/.rivet/config.json` 的
  `provider.providers.deepseek.apiKey`（`****06cc`）。
- 复用脚本 `scripts/deepseek-wire-probe.mjs` 会收集两处候选 key，逐个用免费的
  `GET /models` 预检，自动跳过死 key（当晚就是 env 死 key 吃了一轮 401 才发现）。
- 401 时错误体会带 key 尾号，先核对用的是哪一把，不要先怀疑模型名——
  401 是认证错误，与模型无关（当晚第一反应怀疑错了方向）。

## 三、离线模拟：processDelta 帧序列穷举（零成本，先跑这个）

不打真实 API，直接构造 SSE chunk 喂 `OpenAIClient.processDelta`，穷举四种帧序列
验证 `onStopReason` 触发次数。当晚用它先实证了"假想双发场景会双记"：

```typescript
// npx tsx /tmp/double-fire-check.ts
import { OpenAIClient } from '/绝对路径/src/api/openai-client.js' // tsx 下相对 import 会走 CJS 解析，用绝对路径

const client = new OpenAIClient({ apiKey: 'x', baseUrl: 'http://localhost', model: 'm', maxTokens: 100 } as any)
let fires: Array<{ reason: string; input: number }> = []
const cb = {
  onStopReason: (reason: string, usage: any) => { fires.push({ reason, input: usage?.input_tokens ?? -1 }) },
}

// A: DeepSeek 实际行为 — finish_reason + usage 同帧
fires = []
client.processDelta({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }, cb as any)
console.log('A 合并帧:', JSON.stringify(fires))          // 1 次 ✓

// B: OpenAI 规范 — finish 帧无 usage + 尾部 usage-only 帧（choices undefined）
;(client as any).pendingStopReason = null; fires = []
client.processDelta({ choices: [{ delta: {}, finish_reason: 'stop' }] }, cb as any)
client.processDelta({ choices: undefined, usage: { prompt_tokens: 100, completion_tokens: 5 } }, cb as any)
console.log('B 分离帧:', JSON.stringify(fires))          // 1 次 ✓

// C: 畸形态 — 合并帧带 usage 之后又发尾部 usage-only 帧
;(client as any).pendingStopReason = null; fires = []
client.processDelta({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }, cb as any)
client.processDelta({ choices: undefined, usage: { prompt_tokens: 100, completion_tokens: 5 } }, cb as any)
console.log('C 两帧都带usage:', JSON.stringify(fires))   // 2 次 ✗ 双记（无 provider 命中此形态）

// D: OpenAI 规范变体 — 尾部帧 choices 为空数组 []
;(client as any).pendingStopReason = null; fires = []
client.processDelta({ choices: [{ delta: {}, finish_reason: 'stop' }] }, cb as any)
client.processDelta({ choices: [] as any, usage: { prompt_tokens: 100, completion_tokens: 5 } }, cb as any)
console.log('D 尾帧choices=[]:', JSON.stringify(fires))  // 1 次 ✓（choices[0] 为 undefined 走 L992）
```

判读：只有 C（同流两帧带 usage）会双记。线上探测（下节）用来确认真实 provider
是否可能产生 C 形态。

## 四、线上探测：scripts/deepseek-wire-probe.mjs

```bash
node scripts/deepseek-wire-probe.mjs frames                    # 帧序列（默认 flash，~0.01 元）
node scripts/deepseek-wire-probe.mjs frames deepseek-v4-pro    # pro 帧序列
node scripts/deepseek-wire-probe.mjs cache                     # 缓存五连测（默认 pro，~0.15 元）
node scripts/deepseek-wire-probe.mjs all
```

### 实验一：帧序列探测（4 个形态）

覆盖：非思考+include_usage / 非思考无 stream_options / 思考模式 / 思考+工具调用
（`finish=tool_calls`）。逐帧打印 `choicesLen / kind / finish / usage`，
`: keep-alive` 注释行单独标出，最后汇总 usage-bearing 帧数。

**2026-07-07 基线（flash 与 v4-pro 完全一致）：**

```
#N-1  choicesLen=1  finish=-           usage=null      ← include_usage 时其他帧为 null，无 stream_options 时为 absent
#N    choicesLen=1  finish=stop        usage=PRESENT   ← 合并帧；tool_calls 轮同样合并
#N+1  [DONE]
>>> usage-bearing frames: 1
```

- usage 与 finish_reason **同帧**（合并帧），`[DONE]` 前**没有**独立 usage-only 块。
- **与官方文档矛盾**：文档称 include_usage 会在 `[DONE]` 前发一个 `choices=[]` 的
  独立 usage 块。文档对的只有"其他块 usage 为 null"这半句。
- 不带 `stream_options` 时最后的合并帧照样带 usage。
- 历史一致性：`42a67603`（2026-05-25）当年就是因为合并帧 usage 被丢导致 cache-log
  全 0% 才加的 L1074 路径——从 V3 到 V4 线上行为没变过，变的是文档。
- `openai-client.ts` L1068 注释（"DeepSeek combines finish_reason + usage"）**正确，勿改**。

**重跑判读：**

| 观测 | 含义 | 动作 |
|---|---|---|
| usage-bearing frames = 1（合并帧） | 基线行为，无双记 | 无 |
| usage-bearing frames = 1（分离尾帧） | DeepSeek 迁移到了文档行为 | 更新 L1068 注释；仍无双记 |
| usage-bearing frames ≥ 2 | C 形态成真，**双记事故** | 立即加 per-attempt `usageEmitted` 旗标 |

### 实验二：缓存单元语义五连测

用约 7.8K token 的**确定性**长前缀（150 条星图数据，无时间戳/随机数），依次测：

| 场景 | 构造 | 验证点 |
|---|---|---|
| A 冷启动 | sys + user1 | 基线全 miss |
| B 同请求重放（+8s） | 与 A 完全相同 | 请求结束位置落盘 |
| C 多轮追加 | A + assistant + user2 | append-only 主形态（Rivet 常态） |
| D 同 sys 不同 user | sys + user9 | 文档例二："第二次不命中"？ |
| E 第三个不同 user（+8s） | sys + user11 | 公共前缀检测路径 |

**2026-07-07 基线（v4-pro）：**

```
A 冷启动:        p=7835 hit=0    miss=7835  0.0%
B 同请求重放:    p=7835 hit=7808 miss=27    99.7%
C 多轮追加:      p=7850 hit=7808 miss=42    99.5%
D 同sys不同user: p=7835 hit=7808 miss=27    99.7%   ← 文档例二未复现，立即命中
E 第三个不同user: p=7835 hit=7808 miss=27   99.7%
```

关键数字：**hit 恒为 7808 = 64 × 122**——64-token 块量化边界。判读结论：

- "按固定 token 间隔落盘"在长前缀下主导，实际效果 ≈ 旧的 64-token 块前缀缓存语义。
- 文档例二（同 system 不同 user 第二次不命中，需公共前缀检测后第三次才命中）
  在 7.8K 前缀下**不成立**——D 立即 99.7%。文档的"完整单元匹配"描述至少对长前缀过度悲观。
- 尾部不满一块的 token（27 个）恒 miss；连完全相同的重放也只命中到块边界。
- 短 prompt（10 token，低于最小块）完全不缓存（帧序列实验里同请求重放 hit=0）。
- **对项目的意义**：append-only 设计、compact 锚点复用（锚点 ≥ 若干块即可命中）、
  advisor 的"压缩后整段作废"模型全部继续成立；不必按文档的单元语义重估。

**重跑判读**：hit 若不再是 64 的倍数、或 D/E 掉到 0%，说明落盘/匹配语义变了，
需要重估 compact 锚点复用与侧路共享前缀的成本模型，并更新本文基线。

**注意**：重跑时 A 可能因上次的缓存未过期（几小时~几天）而非 0%——改 lore
里任意一个字符即可强制冷启动。

## 五、遗留待办（截至 2026-07-07）

- [ ] `parseStreamFromReader` 跨 attempt 重试双记：usage 帧已处理、`[DONE]` 前断连、
  错误可重试 → 整流重放再记一次。final text block 有防重（"never on error/retry paths"），
  usage 没有。修法：per-attempt `usageEmitted` 旗标。实测确认单流单发后，这是唯一残余风险。
- [ ] `openai-client.ts` L1068 注释补一行："2026-07-07 实测（flash+pro、含 tool_calls 轮）
  确认仍是合并帧，与官方文档 include_usage 描述不符，见本 playbook"。
- [ ] `.zshrc` 的失效 `DEEPSEEK_API_KEY` 换成现役 key（`verify-cache-hit-rate.ts` 等
  脚本从 env 取 key）。

## 六、何时重跑

- DeepSeek 发版公告 / API 文档更新（尤其 stream_options、缓存章节改动）后。
- cache-log 出现无法解释的命中率悬崖或 usage 总量异常（怀疑双记）时。
- 接入新 OpenAI 兼容 provider / 代理（cliproxy 等）时——把 `BASE_URL` 换掉即可
  用同一脚本验证该 provider 的帧形态属于 A/B/C/D 哪一种。
- 侧路记账（`event:'side_path'`）数据与账单对不上时。
