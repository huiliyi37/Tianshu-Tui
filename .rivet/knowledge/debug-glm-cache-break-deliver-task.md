# GLM 缓存碎裂排查 — deliver_task 与 196s 请求空窗

> 日期：2026-06-20
> 会话：bd283033-f8c8-4a6b-87f6-14b354e38e18（GLM-5.2，天权域）
> 数据源：`.rivet/sessions/bd283033.../cache-log.jsonl`（72 条逐请求记录）

## 断裂点

| 字段 | row 66 (turn 30) | row 67 (turn 31) | 变化 |
|---|---|---|---|
| timestamp | 23:27:26 | 23:30:42 | **+196s** |
| hitRate | 99.7% | **0.0%** | 完全碎裂 |
| cacheRead | 75,504 | **0** | 归零 |
| input | 75,730 | 76,228 | +498（正常增长） |
| userMsgs | 4 | 4 | 不变 |
| appendixChars | 17,753 | 17,753 | 不变 |
| projChars | 951 | 737 | -214（常态波动） |
| readRefCount | 12 | 18 | +6 |
| readRefSavedBytes | 138,588 | 405,204 | +266,616 |

## 已排除的原因

### ❌ readRef 去重改写历史
readRef（`src/tools/read-file.ts:519`）默认开启（`RIVET_READ_REF !== '0'`）。它只改写**当前轮新 read_file 调用的返回值**（用 `[read-ref]` 引用替代完整内容），**不回溯改写历史消息**。readRefCount 12→18 是新增 6 次重复读取产生的新 tool_result，追加在末尾，不影响前缀。

### ❌ projChars 变化
projChars（认知投影 = cognitive-mirror + task-contract）**每轮都在变**（Δ 从 -257 到 +292），但之前从未碎缓存。row 63（Δ=+254）、row 53（Δ=+232）、row 58（Δ=-216）等更大的 projChars 变化都没碎。appendixChars 全程 17,753 不变。

### ❌ TTL 过期（3 分钟）
没有服务端 3 分钟 TTL 的缓存。GLM 文档说缓存基于"相同或高度相似的内容"匹配，不是短 TTL 机制。

### ❌ prompt 结构异常
userMsgs 不变（4→4），appendixChars 不变（17,753→17,753），input 只 +498。prompt 结构层面无异常。

## 当前判断（未完全确认）

**唯一独占变量是 196 秒的请求空窗。** 在这 196 秒里，deliver_task（commit=true）执行了大量同步操作：

deliver_task 完整操作清单（`src/agent/deliver-task.ts`）：
1. `collectCurrentDirtyFiles()` — 3 次 git spawnSync（diff / diff --cached / ls-files）
2. `ctx.gate.getReport()` — 读 TaskLedger + OwnershipLedger + DeliveryGateV2
3. `filterExternalNoise()` — 过滤外部噪音文件
4. `summarizeOwnershipHealth()` — 健康检查
5. `readProjectMemory()` — 读 `.rivet/knowledge/project-memory.md`
6. `detectSymptomPatch()` — 2 次 git spawnSync（diff --numstat / diff HEAD）
7. `readUnacknowledged()` — 读 recovery journal
8. `checkCommitCohesion()` — 文件聚合度检查
9. `detectWroteButNeverRead()` — 静态分析扫描
10. `detectReadButNeverProduced()` — 静态分析扫描
11. `git rev-parse --short HEAD` × 2（commit 前后）
12. `commitScopedFiles()` — git add + git commit
13. `git show --stat HEAD` — 读回 diff
14. **Post-commit review** — 如果 review discipline 开启且非 skip：启动 worker（async spawn），有 timeout

至少 10+ 次 git spawnSync（每个 5s timeout）+ 文件读取 + 静态分析 + 可能的 review worker。累积耗时造成 196 秒请求空窗。

## 待确认

- GLM 服务端缓存淘汰策略（LRU？容量？需要读 https://docs.bigmodel.cn/cn/guide/capabilities/cache 的完整内容，页面 JS 渲染 curl 拿不到）
- 196 秒是否足以触发 LRU 淘汰（对比其他大间隔：row 50→51 间隔 168s 未碎，row 26 间隔 186s 只降到 78.5%）

## 对照数据：其他大间隔

| gap | hit | rd 变化 | 说明 |
|---|---|---|---|
| 196s (row 67) | 99.7%→**0%** | -75,504 | 完全碎裂 |
| 186s (row 26) | 99.8%→78.5% | -1,894 | 部分下降（新 user message） |
| 168s (row 51) | 99.7%→100% | +7,084 | 未碎 |
| 143s (row 19) | 99.1%→40.9% | -12,589 | 大幅下降（新 user message） |
| 141s (row 35) | 99.2%→99.2% | +362 | 未碎 |
| 133s (row 88) | 99.4%→80.2% | -14,626 | 下降（新 user message） |
| 132s (row 68) | 0%→19.8% | +16,466 | 缓存重建中 |

196s 是所有间隔中最长的，且是唯一一个在**非新 user message** 情况下完全碎裂的。

## ✅ 根因确认：review worker 并发 API 请求淘汰了主会话缓存

### 证据链

1. **deliver_task 确实启动了 review worker**：record 146 的 tool_result 末尾写明：
   ```
   ⚠️ 审查未决 (auto)：post-commit review DID NOT run (timed out: Review workflow timed out)
   ```

2. **两个 review worker 在 196s 空窗内接力活跃**：
   - worker-wo_99c02140：23:27:26→23:29:07，glm-5.2，7 次 API 调用
   - worker-wo_475183bd：23:29:07→23:30:58，glm-5.2，7 次 API 调用
   - 合计约 14 次 GLM API 请求在主会话 row 66→67 之间发出

3. **AUTO_REVIEW_BUDGET_MS = 180,000（3 分钟）**：与 196s 空窗吻合——review worker 跑了 180s 后超时，加上 commit 本身耗时，总计 196s。

4. **review worker 用 glm-5.2**（与主会话同模型同 API key）：worker 的 prompt 内容与主会话不同（不同的系统提示词、不同的消息历史），GLM 服务端的"相同或高度相似"缓存匹配机制会将 worker 的请求视为新的缓存条目，淘汰主会话的旧缓存。

### 根因机制

deliver_task commit=true → post-commit review → `routeReviewWorkflow()` spawn worker → worker 用 glm-5.2 发 API 请求 → GLM 服务端缓存被 worker 的不同 prompt 覆盖 → 主会话下一个请求 cacheRead=0。

不是 git 提交内容碎的缓存，不是 TTL 过期，不是 prompt 结构变化。是 **review worker 的并发 GLM API 请求淘汰了主会话的 GLM 服务端缓存**。

### 影响范围

这个机制影响所有 `prefixCache: 'none'` 的 provider（GLM、Kimi、Codex）——它们的 cacheRead 完全依赖服务端隐式缓存，任何并发 API 请求（worker/delegate）都可能淘汰主会话缓存。DeepSeek（`prefixCache: 'deepseek-native'`）由 Rivet 侧管理精确前缀缓存，不受此影响。

### 可行动的修复方向

1. **review worker 用不同模型（最优）**：当前 worker 继承主会话模型（glm-5.2），没有降级到 flash 的机制。`selectModelForTask`（coordinator.ts:494）只从 modelCards 里选——没有 Pro→Flash 降级路径，只有 Flash→Pro 升级路径（coordinator.ts:1120）。review 是只读验证任务，用 deepseek-v4-flash 或更快的模型即可，不需要重型推理。这既避免缓存竞争，又加快 review 速度。
2. **GLM 会话跳过 auto review（快速止血）**：deliver_task 对 glm provider 设 `skipAutoReview=true`（类似 goal 模式的处理）
3. **review worker 串行化**：在 deliver_task 的 review 期间，主会话不发请求（当前已是串行，但 review 超时后主会话才恢复——问题在于 review 本身太慢）

### worker 模型路由现状

- `selectModelForTask`（coordinator.ts:494）：从 modelCards 里按 preferredTier 选，无路由配置时用第一个可用卡片
- 主会话配 glm provider → modelCards 只有 glm-5.2 → worker 也用 glm-5.2
- 无 Flash→Pro 降级机制（只有升级路径 coordinator.ts:1120-1164）
- review-coordinator-deps.ts:372 注释提到 "Flash models are reliable enough at these focused axes" 但实际没有配置 flash 路由
