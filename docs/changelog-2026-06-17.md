# Changelog — 2026-06-17

> 15 commits · 49 files · +977 −346 lines  
> Branch: `desktop/antigravity-base`  
> 涵盖四个优化方向：信噪比数据管线审计（W1-W3）、断链闭环修复、1M 信号质量、UI/构建

---

## 一、1M 信号质量优化（3 commits）

> 目标：为 1M 上下文窗口的长会话优化信号质量——放宽探索预算、防止大块挤占、统一纠偏出口、早期折叠噪声。

### W1 — grep/search 预算缩放 + GWT blockCap `0d61b3df`

**问题**：grep/search 的 `perCall`（2K）和 `summarizeAfter`（4K）在 200K+ 窗口下过于保守，探索阶段频繁触发摘要压缩，丢失匹配上下文。同时 `selectTopKBlocks` 无单块上限，一个超大块可独占整个 salience 预算。

**改动**：
| 文件 | 变更 |
|------|------|
| `src/compact/constants.ts` | `toolTypeBudgets`: grep/search 预算随窗口缩放（≥200K 时 `perCall = min(w*0.004, 8K)`），标注 `perTurnCumulative` 未被 `enforceToolTypeBudgets` 消费 |
| `src/prompt/volatile.ts` | `selectTopKBlocks`: 新增 `blockCap = max(maxChars*0.4, 2K)`，超限截断并标注 `[truncated]` |
| `src/compact/__tests__/constants-tool-budget.test.ts` | 更新断言适配缩放后的数值 |

**效果**：1M 窗口下 grep `perCall` 从 2K→4K、`summarizeAfter` 从 4K→8K，探索阶段多保留一倍匹配上下文。单块上限防止一个 20K 的 read_file 结果挤掉 3-4 个高 salience 短块。

---

### W2 — dead-end 迁移到 advisory bus + category 去重 + kick 互斥 `d89d78f4`

**问题**：dead-end 信号通过 `injectUserMessage` 注入，破坏前缀缓存；与 kick hook 同时触发时产生"你卡住了"的重复消息；advisory bus 无分类上限，同类信号可垄断 3 条预算。

**改动**：
| 文件 | 变更 |
|------|------|
| `src/agent/hooks/signal-consumer-hook.ts` | dead-end 路由从 `injectUserMessage` 切到 `advisoryBus.submit()`；导入 `shouldKick` 做互斥检查 |
| `src/agent/advisory-bus.ts` | `render()` 新增 category 级去重——同类最多保留 `MAX_PER_CATEGORY=2` 条 |
| `src/agent/create-runtime-hooks.ts` | 传递 `advisoryBus` 到 signal-consumer |
| `src/agent/__tests__/signal-consumer-hook.test.ts` | 新增 advisory bus 路由、kick 互斥两组测试 |

**效果**：dead-end 信号走 dynamic appendix 单一出口（缓存安全）；kick 触发时 dead-end 自动静默；同类 advisory 不超过 2 条，保证多元纠偏信号共存。

---

### W3 — T7 collapse 扩展到 0-50% + 重复折叠 `9514d4fb`

**问题**：T7 轻量折叠仅在 1M 窗口且填充率 >50% 时激活。在长会话早期（0-50% 填充），重复 grep 同一 pattern、重复 read 同一文件的结果会线性堆积，浪费上下文空间。

**改动**：
| 文件 | 变更 |
|------|------|
| `src/prompt/engine.ts` | 激活门降至 ≥200K（不再限 1M）；`requestTimeCollapse` 新增 `lightOnly` 参数：0-50% 填充只做 reasoning 剥离 + dedup fold，>50% 做完整语义压缩；新增 `inferToolTarget` 从工具参数提取 grep pattern / read path |
| `src/prompt/__tests__/request-time-collapse.test.ts` | 新增 superseded grep、duplicate read、lightOnly 模式三组测试 |

**效果**：重复搜索同一 pattern 的旧 grep 结果被折叠为 `[collapsed grep: superseded by later grep on foo]`，同一文件多次 read 只保留最新版本。reasoning 内容在边界以下始终被剥离，不再等到 50% 才清理。

---

## 二、断链闭环修复（2 commits）

> 目标：修复四条已接线但数据未到达模型、或能力未被消费的断链。

### claimLines 注入 + progress 块合并 + CVM throttle 扩展 `a048615a`

**改动**：
- `turn-step-producer.ts`: `claimLines`（跨会话声明）从局部变量改为 append 到 `crossSessionEvents` appendix，模型首次能看到其他会话的 claims
- `volatile.ts`: `<decisions>` + `<task-progress>` + `<session-state>` 合并为单一 `<progress>` 块（salience 0.8），减少标签噪声
- `turn-step-producer.ts`: CVM throttle 扩展覆盖 `tool-context`——压力高时 `setToolContext(null)` 清空；overhead 追踪加入 tool-context 长度
- 删除 `renderActiveClaimsBlock` 等死代码

### APC 三级响应接线 + cache 测试适配 `240544a7`

**改动**：
- `immune-hook.ts`: primary path 映射 APC `responseType`——`quarantine` 接线 `freezeNode`、`prune_toxic` fallback 到 `deposit_warning`
- quarantine 时跳过 stigmergy deposit（已冻结无需再标 fragile）
- cache-stability 测试适配 `session-state → progress` 重命名

---

## 三、信噪比数据管线审计（3 commits）

> 目标：系统性清理认知架构中的噪声源、死字段、数据卫生问题。

### 合并 affordance+policy 为 `<tool-context>` `4e341234`

- `affordance.ts`: `affordance-hint` 和 `policy-guidance` 合并为单一 `<tool-context>` 块
- 删除 `computeEFE` 中不再使用的 `toolContext` / `policyGuidance` 分离逻辑
- 减少 2 个 XML 标签的开闭开销

### 数据质量三处修复 `4a2bc7d5`

- `playbook.ts` / `playbook-reflect-hook.ts`: failure `importance` 字段从硬编码 `'medium'` 改为基于 retry count 动态计算
- `context-injection.ts`: 删除已死的 `activeClaims` 渲染路径
- `advisory-bus.ts`: star-domain dedup——`【星名】` 开头的 advisory 若与当前 active domain 重复则抑制

### 数据卫生 — telemetry/fingerprint/dream `3ad77818`

- `telemetry-writer.ts`: `flush()` 改为可选（session 无 telemetry 时不崩）
- `session-registry.ts`: fingerprint 按 `projectHash` 分区，避免跨项目 fingerprint 交叉污染
- `dream.ts`: 新增 `cleanupProjectMemory` 函数——清理无 `dream-key` 或不符合 curation criteria 的历史条目
- `stigmergy.ts`: doc comment 修正——标注 stigmergy 实际为 session 作用域（7 天半衰期）

---

## 四、Desktop / UI / 构建（5 commits）

### CSP 补全 `751574ff`

- `index.html`: `img-src` 补 `'self' data: blob:`，修复图片上传/粘贴失败

### 上下文窗口/缓存命中率/增量数据流修复 `b5afc666`

- `loop.ts`: 新增 `getEstimatedTokens()` / `getContextWindow()` 让 REST API 返回实时数据
- `event-reducer.ts`: `turn_complete` 提取 `cache_read/creation` + 增量追踪
- `ThreadView.tsx`: header 渲染 ⚡XX% 缓存命中率 chip + +Xk 上下文增量
- `styles.css`: `.cache-chip` / `.ctx-delta` 样式

### cobalt 主题 `dcc5aff6`

- 新增 oklch 调和冷调中性主题 `cobalt`，设为默认
- glance-bar 纳入「单色克制」特判
- 测试适配

### 子代理舰队面板视觉升级 `3056df36`

- `DelegationTree.tsx`: 汇总头 + 按状态分色 chips + 五态语义 + attention 色条
- `event-reducer.ts`: 补 `profile` 字段到 `DelegationNode`
- `styles.css`: `.delegation-tree` 区块升级

### better-sqlite3 生产打包 `a30606a7`

- `native-resolver.ts`: 统一 native module 加载逻辑
- `pack-native.sh` / `verify-native.sh`: 打包与验证脚本
- `meridian-db.ts`: nullDb fallback 修复
- `tsup.config.ts`: external 配置更新

---

## 五、测试与基础设施（2 commits）

### mock loadFingerprints 补参数 `4cffa03c`

- 测试 mock 补 `projectHash` 参数，闭合覆盖缺口

### nullDb run() 修复 `a5603084`

- `session-registry.ts`: nullDb `run()` 返回 `{ changes: 0 }` 修复 SessionRegistry write error

---

## 测试覆盖

所有改动经过 typecheck (`tsc --noEmit`) + 相关测试验证：
- 信号质量优化：134 tests pass（constants-tool-budget / volatile / engine-cache-stability / signal-consumer-hook / advisory-bus / request-time-collapse）
- 断链修复：99 tests pass（含 immune-hook / volatile / engine-cache-stability）
- 数据管线审计：全量 `npm test` 2340 tests pass

## 架构影响概要

```
prompt 管线:
  grep/search budget ─── 窗口缩放 (≥200K)
  GWT selectTopKBlocks ─ blockCap 40%
  T7 collapse ────────── 0-50% lightOnly (reasoning strip + dedup fold)
                          50%+ full collapse (+ dedup fold)

纠偏出口统一:
  dead-end ──→ advisory bus (was: injectUserMessage)
  category cap: max 2/cat
  kick ⊗ dead-end: mutual exclusion

prompt 块合并:
  decisions + task-progress + session-state → <progress> (salience 0.8)
  affordance-hint + policy-guidance → <tool-context>
```
