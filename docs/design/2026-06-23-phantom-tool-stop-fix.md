# Phantom tool-call premature-stop 修复

> 2026-06-23 · 关联计划 `phantom-tool-stop-fix`

## 背景

Agent 经常「以为调用了工具、实际没调用」就结束回合，需要用户再发一条消息才继续。
根因有两条，彼此独立：

1. **传输层（已实证 bug）**：DeepSeek 偶尔把 tool call 当作纯文本 content 吐出来
   （`hasToolJsonInContentBug`）。`OpenAIClient` 有回收逻辑
   `tryParseToolJsonFromContent`，但它被 `this.config.capabilities?.hasToolJsonInContentBug`
   门控，而 `createProviderClient`（`src/api/factory.ts`）构造 client 时**从未传入
   `capabilities`** → 运行时恒为 `undefined` → 回收逻辑是死代码。DeepSeek preset 的
   `toolJsonBug: true` 在生产里完全没生效。工具调用静默退化成文本 →
   `toolUses.length === 0` → 回合结束。

2. **Loop 层（设计缺口）**：`turn-orchestrator` 只要 `toolUses.length === 0` 就走
   `isFinal:true` + `break`，与文本是否表达「我接下来要做 X」无关。
   convergence / kick / dedup / self-verify 都只在下一回合边界、或连续 2+ 个无工具
   回合后才软性 nudge，救不了**第一次**无工具停止。唯一会自动续跑的是 `/goal` 模式的
   `GoalTracker`。

```
turn 结束
  └─ toolUses.length > 0 ? ── yes ─→ execute → isFinal:false → continue
                            └─ no ──→ /goal active ? ── yes ─→ GoalTracker 续跑
                                                       └─ no ──→ isFinal:true → 等用户
```

## 改动

### Tier 1 — 传输层根因修复

`src/api/factory.ts` 的 `new OpenAIClient({...})` 透传 capability：

```ts
capabilities: { hasToolJsonInContentBug: capabilities.hasToolJsonInContentBug },
```

`capabilities` 已由 `resolveCapabilities` 从 preset/默认合并。这让 DeepSeek 在
「tool JSON 当文本」时自动回收为 `tool_use`。其余 provider 该 flag 为 `false`，行为不变。
回收仅在 `toolCallBuffer` 为空、文本以 `{`/`[` 开头、且能 `JSON.parse` 出含 `name`
字段的对象时触发，风险极低。

### Tier 2 — Loop 层有界自动续跑

新增纯函数模块 `src/agent/phantom-continuation.ts`（仿 `thinking-retry.ts` 形态），
`evaluatePhantomContinuation(input)` 分层判定：

1. **硬门**：`maxAutoContinue<=0` / 预算耗尽 / `convergenceEscalated` / 空文本 →
   不续跑（不与 convergence/doom-loop 抢方向，不在空回合乱续）。
2. **Layer 1（task-contract 优先）**：活动 contract 且 `isActionable` 且
   `status ∉ {ready_to_deliver, blocked}` → `contract-open`，续跑。
3. **Layer 2（意图启发式回退）**：无 contract 信号时，对文本末尾匹配「行动承诺词
   （让我/接下来/现在/I'll/let me…）+ 工具动词（grep/read/run/查/改/跑…）」共现，
   且非纯社交（复用 `isSocialOrTrivial`）→ `action-intent`，续跑。

接线在 `turn-orchestrator.ts` 的 goal 检查之后、final completion 之前（仅当
`!tracker?.isActive()`）。触发即 `completeTurn(isFinal:false)` + `appendSystemReminder`
（system-reminder 通道，前缀缓存安全）+ `continue`。

提示语克制：提醒「上一回合没有实际发起 tool call，要继续就直接发起工具调用，不要只
用文字叙述；若确已完成请给出结论」。

#### 预算与不变量

- `autoContinueCount` 是 `AgentLoop` 的 per-run 状态，`initializeRun` 每个 `run()`
  重置为 0（与 `consecutiveNoToolTurns` 并列）。
- 续跑回合仍计入 `consecutiveNoToolTurns`，所以续跑无效时 convergence/doom-loop 照常
  升级 → **不会死循环**。
- `/goal` active 时整个分支跳过，沿用 `GoalTracker`，二者不冲突。

### 配置

`src/config/schema.ts` / `default.ts` 新增 `agent.maxAutoContinue`：

| 值 | 含义 |
|----|------|
| `0` | 关闭（回到旧行为：无工具即停） |
| `1`（默认）| 每个 run 最多自动续 1 回合 |
| `2`–`3` | 放宽（clamp 上限 3） |

经 `loop-types.ts`（`AgentConfig.maxAutoContinue`）→ `bootstrap.ts` →
`loop-factory.ts` 注入 orchestrator deps（含 `getActiveContract` / `getDoomLoopLevel` /
auto-continue 计数 getter/setter）。

## 测试

- `src/api/__tests__/factory.test.ts`：deepseek/kimi capability 接线断言 + 一条端到端
  回归（SSE 文本含 `{"name":"grep",...}` → 断言 emit 出 `tool_use`）。
- `src/agent/__tests__/phantom-continuation.test.ts`：14 例覆盖硬门 / Layer 1 / Layer 2
  全部分支。
- `src/agent/__tests__/phantom-continuation-loop.test.ts`：3 例端到端（续一次后停 /
  预算上限 / 关闭时不续）。

## 边界与非目标

- 不改 SSE 双相 flush / GLM 空参数路径（已由延迟 flush 修复）。
- 不引入 token 级实时流、不动 `/goal` headless 路径、不动 convergence/doom-loop 阈值。
- 默认 `maxAutoContinue=1` 只续一回合，避免「自说自话刷屏」。
