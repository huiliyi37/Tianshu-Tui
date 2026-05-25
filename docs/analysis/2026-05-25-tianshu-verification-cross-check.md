# 天枢验证文档的交叉核查

**日期**: 2026-05-25
**目的**: 对 `docs/analysis/2026-05-24-context-loss-verification.md` 中天枢补充的 8 个"遗漏发现"做代码层面的真伪核查
**结论摘要**: 7 真 1 假，但其中 2 个真问题的描述/方向需要修正

---

## 核查结果一览

| # | 天枢的发现 | 核查结论 | 备注 |
|---|---|---|---|
| 遗漏 1 | 工具输出截断 20 行默认 | **真**（描述错位） | 真问题是 read_file/grep 给模型的内容硬编码截到 8000 字符，与 token 预算无关 |
| 遗漏 2 | artifact 模式替换消息内容 | ✅ **真** | `tool-pipeline.ts:156` artifactIntercept 真实存在 |
| 遗漏 3 | 三个 append 方法都无人调用 | ✅ **真** | 比我原文档的"appendOaiWithChecksum 无人调用"更精确 |
| 遗漏 4 | agent-diet 阈值 8 触发 | ✅ **真** | ANCHOR_MESSAGES(2) + protectRecent(6) = 8 |
| 遗漏 5 | replaceMessages 破坏前缀缓存 | **真**（机制描述错） | 不是"replaceAll"导致，是修改中段内容导致；修复方向也错 |
| 遗漏 6 | adaptive 回退陷阱 | ❌ **假**（死代码） | `adaptiveCompactPolicyRatios` 0 个生产调用方，跟 `loadRecoverableMessages` 一样写了没接 |
| 遗漏 7 | prune 不区分策略 | ✅ **真**（影响有限） | 真存在，但阈值 10 高于 stale-round 的 6，实际作用被掩盖 |
| 遗漏 8 | 反沉淀机制不查 strategy | ✅ **真** | 这是对根因 7 的正确修正 |

---

## 详细核查

### 遗漏 1 — 描述错位，但真问题更严重

**天枢说**：工具输出截断 20 行默认（引用 `tool-result-truncate.ts`）。

**实际代码**：

```ts
// src/agent/tool-result-truncate.ts:3-18
export function truncateToolResult(content: string, maxTokens: number): string {
  if (!content) return content
  const tokens = estimateOaiMessageTokens({ role: 'user', content })
  if (tokens <= maxTokens) return content
  // ... 头 60% / 尾 30% 的字符切分
}

// src/agent/tool-pipeline.ts:127-132
function truncateSuccessfulToolResult(content: string, config: AgentConfig): string {
  return truncateToolResult(content, compactThresholds({
    contextWindow: config.contextWindow ?? 1_000_000,
    providerProfile: config.providerProfile,
  }).toolResultMaxTokens)
}

// src/compact/constants.ts:80
toolResultMaxTokens: Math.min(Math.floor(contextWindow * 0.3), toolResultHardCap),
// 1M 模型 → 200K token，200K 模型 → 60K token
```

**这一层**实际阈值很高（200K token），单条 tool_result 超过 200K token 才截。所以**天枢说的"20 行"在这一层不存在**。

**但真问题更严重，在工具内部**：

```ts
// src/tools/read-file.ts:37-39
const MODEL_MAX_CHARS = 8000
const MODEL_HEAD_CHARS = 4000
const MODEL_TAIL_CHARS = 2000

// src/tools/grep.ts:91
return { content: truncateContent(text, 8000, 4000, 2000) }

// src/tools/output-store.ts:58 (bash)
const MODEL_MAX_LINES = 200
```

**read_file 和 grep 给模型的内容硬编码截到 8000 字符**——约 2000 token。bash 是 200 行。

这才是真正的 bug。一个 800 行的源文件，模型只看到前 4000 字符 + 尾 2000 字符，**中间永远 omitted**。无论 contextWindow 是 200K 还是 1M、无论 strategy 是什么，全都一样的 8000 字符。

**这条遗漏方向是对的，但天枢引用的代码位置错了**。需要把焦点从 `tool-result-truncate.ts` 转到 `tools/read-file.ts:37` 和 `tools/grep.ts:91`。

---

### 遗漏 2 — 真实，artifact 是双重截断

**天枢说**：工具输出被替换为 `[artifact:read_file:abc123]` 类引用。

**核查**：`tool-pipeline.ts:156-212` 的 `artifactIntercept` 真存在：

```ts
return `[artifact:${artifactId}] ${summary}${headExcerpt}\nUse read_section(artifactId="${artifactId}", section="L1-L200") to expand.`
```

✅ 描述准确。

**值得补充的细节**：当模型用 `read_section` 读回时，又会再次走 `MODEL_MAX_CHARS = 8000` 截断（如果 read_section 用了 read-file 通用路径）。**模型经历了两次截断：完整 → artifact ref + 头部 → 重读 8000 字符**。

---

### 遗漏 3 — 完全准确

```bash
$ grep -rn "\\.append\\b\\|\\.appendWithChecksum\\b\\|\\.appendOaiWithChecksum\\b" src/agent/loop.ts | grep -v "appendCompact"
# 0 行
```

确认：所有"写一条消息"的方法都没有生产调用方。我原文档说"appendOaiWithChecksum 无人调用"是局部正确，**天枢的修正"三个 append 方法全部无人调用"更精确**。

---

### 遗漏 4 — 准确，且发现额外 bug

```ts
// src/compact/agent-diet.ts:26-31
const ANCHOR_MESSAGES = 2

export function applyAgentDiet(messages: OaiMessage[], options: DietOptions = {}): DietResult {
  const protectRecent = options.protectRecentMessages ?? 6
  if (messages.length <= ANCHOR_MESSAGES + protectRecent) return ...
```

✅ 触发阈值 8，正确。

**额外发现（不在天枢报告里）**：`extractPath` 把 grep 也按 redundant 处理：

```ts
// src/compact/agent-diet.ts:124-129
if (tc.function.name === 'read_file' || tc.function.name === 'grep' || tc.function.name === 'glob') {
  try {
    const args = JSON.parse(tc.function.arguments)
    return args.file_path || args.path || args.pattern  // ← grep 的 pattern 当 path
```

两次相同 grep pattern 的结果，第一次会被标 `[diet:redundant]`——但**两次同样 pattern 完全可以是不同上下文下的不同意图**（"刚才 grep 后我又改了代码，现在再 grep 看变化"）。这是单独的 bug，影响调试场景。

---

### 遗漏 5 — 现象真，机制描述错，修复方向错

**天枢说**：

> agent-diet 移除消息后调用 `replaceMessages`，整个数组引用变了，DeepSeek 的前缀缓存（exact-prefix 类型）完全失效。
>
> 修复方向：diff 增量更新而非 replaceAll。

**这个判断有问题**。

DeepSeek 的 prefix cache 是**服务器侧按消息内容字节比对**——客户端是 replaceAll 还是增量 update 跟服务器无关。服务器收到的请求 body 是序列化后的 JSON，cache key 是字节内容前缀。

**真正的破坏来自内容本身被改**：

```ts
// agent-diet.ts:99
return { ...msg, content: `[diet:redundant] re-read later` }
//                ↑ 中段消息内容变了
```

只要中段任何一条 tool_result 的 content 从原始内容变成 `[diet:redundant]` 占位符，**那个位置之后的所有消息**都不再匹配 prefix cache——这是 prefix cache 的本质，跟 replaceMessages 这个 JS API 无关。

**正确的修复方向**：
- **不要修改中段消息内容**——agent-diet 这种"标 redundant"逻辑本质上和 prefix cache 不兼容
- 要丢就丢**尾段**（最近的内容，cache 价值低）
- 或者把 redundant 标记**只追加到最后**（"以下是早期已被 redundant 的索引：[idx 5, 8, 12]"），不动原消息
- 或者**完全跳过**有 cache-preserving 策略的会话

**天枢的"diff 增量更新"修复跟问题不对应**——增量 vs 全替换在 JS 层面没区别，问题在内容是否被修改。这条要修正。

---

### 遗漏 6 — 死代码，不会触发

```bash
$ grep -rn "adaptiveCompactPolicyRatios" src --include="*.ts" | grep -v __tests__
src/compact/constants.ts:127:export function adaptiveCompactPolicyRatios(
# 0 个调用方
```

`adaptiveCompactPolicyRatios` 写了但**没有任何生产代码调用它**。和 `loadRecoverableMessages`、`detectIncompleteCompact` 一样是预留但未接入的功能。

**所以"低 cache 命中率 → 自动降低阈值 → 恶性循环"目前不会发生**。它是潜在地雷（接入时容易出问题），但不在当前问题范围内。

**这条要从"现存问题"挪到"潜在风险"**。

---

### 遗漏 7 — 真，但实际作用被掩盖

```ts
// src/compact/prune.ts:15-46
export function pruneStaleToolResults(messages, options = {}): PruneResult {
  // 没有 providerProfile / strategy 参数
  const protectRecent = options.protectRecentMessages ?? PRUNE_PROTECT_RECENT_MESSAGES  // 8
  const minChars = options.minContentChars ?? PRUNE_MIN_CONTENT_CHARS  // 1200
  // ANCHOR_MESSAGES(2) + protectRecent(8) = 10 触发
  // 把 > 1200 字符的中段 tool_result 替换为 [pruned: N chars]
}
```

✅ 不查策略表是真的。

**但实际影响有限**：触发阈值是 10 条消息，而 stale-round 是 6 条。stale-round 先把所有中段 tool_result 截到 1200 字符——之后 prune 检查 `if (msg.content.length <= minChars) return msg`（1200 字符以内不动），**已经没有内容可 prune**。

所以两者**实际是冗余机制**，prune 在大部分情况下是 no-op。这条优先级应该比天枢标的低。

---

### 遗漏 8 — 完全正确

四个反沉淀机制（agent-diet / stale-round / prune / heap-driven）都不查询 `providerProfile.strategy`。这是对根因 7 的正确修正。

DeepSeek 走 cache-preserving 策略，但 agent-diet 仍然每轮跑、stale-round 仍然在 6 条消息触发——**策略表是装饰**。

---

## 综合评价

天枢的验证文档质量很高：
- 7/8 个新发现是真实的代码事实
- 多数引用准确到行号
- 关联图清晰

但有 3 处需要修正：

1. **遗漏 1 引用错位**：真问题不在 `tool-result-truncate.ts`（那层阈值很高），而在 `tools/read-file.ts:37` 和 `tools/grep.ts:91` 的 `MODEL_MAX_CHARS = 8000` 硬编码
2. **遗漏 5 机制错误**：prefix cache 失效不是 replaceMessages 这个 API 引起，是中段内容被修改引起；天枢的"增量更新"修复方向不对症
3. **遗漏 6 是死代码**：`adaptiveCompactPolicyRatios` 0 个调用方，应从"现存问题"移到"潜在风险"

---

## 修正后的 P0 清单

按"实际现存 + 严重 + 修复成本低"重排：

| 优先级 | 问题 | 修复方向 |
|---|---|---|
| **P0-1** | 消息从不落盘（R1+漏3） | `loop.ts` 在 `addUserMessage` / `addAssistantBlocks` 后调用 `appendOaiWithChecksum` |
| **P0-2** | read_file/grep 硬截 8000 字符（漏1 修正版） | 阈值改为 `compactThresholds(...).toolResultMaxTokens` 联动；或按当前剩余 token 预算动态 |
| **P0-3** | 反沉淀机制改中段内容（漏5 修正版 + R2 + R3） | cache-preserving 策略下整个跳过 agent-diet/stale-round/prune；只动尾段或不动 |
| **P0-4** | heap-driven 整轮删除（R4） | 改为提示而非默删；最多走第一阶段（截 tool 内容、reasoning） |

P1 / P2 维持天枢原排序，但移除遗漏 6（死代码）。

---

## 关于"反沉淀机制总数"

我的原文档说"6 处"，天枢算到"12 处"。重新清点（去掉死代码 + 描述错位）：

**真正在生产代码里跑的反沉淀机制**：

1. agent-diet（每轮）
2. stale-round（>6 触发）
3. prune（>10 触发，多数被 stale-round 覆盖）
4. heap-driven 强制压缩（heap ≥ 60%）
5. microCompactOai 第一阶段（tier > 0）
6. microCompactOai 第二阶段（estimateOaiTokens > window）
7. enforceContextCeiling（tokens > 95%）
8. pre-compact-handoff（每轮，零密度）
9. **read_file 内部 8000 字符硬截**（每次 read）
10. **grep 内部 8000 字符硬截**（每次 grep）
11. **bash 内部 200 行截断**（每次 bash）
12. **artifactIntercept**（每次工具输出超阈值）

加上**消息持久化缺失**（不算"反沉淀"，但效果等价于"会话退出后全部沉淀失效"）。

**12 处的总数对**，但"工具内部硬截"这三条天枢没识别——它们是最隐蔽的，因为发生在 LLM 看见消息**之前**，模型本身就不知道完整内容存在。
