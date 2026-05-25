# DeepSeek Prefix Cache 命中率优化：90% → 97-98%

## 实施状态更新（2026-05-25）

截至 `27a6679 fix(prompt): skip observation masking entirely on 1M+ windows`，本设计中的 Phase 0、Phase 1、Phase 2 主路径已经基本落地：

- Phase 0：DeepSeek 合并 SSE 帧中的 cache usage 解析已修复（`42a6760`）。
- Phase 1.1：`consolidatedBlock` 已移出 frozen prefix，改为 dynamic appendix 注入（`a23724c`）。
- Phase 1.2：prune 已停止写回 session storage，转为统计/request-time 方向（`30637de`）。
- Phase 1.3：tool result trailing whitespace 已归一化（`ab2996c`）。
- Trailer mode：`cachedFreshBlock` 已合并进最后一条 user message，消除独立消息位置滑动（`2e37179`）。
- Phase 2.1：1M+ window 下 `maybeCompact()` 跳过常规 micro compaction；95% `enforceContextCeiling()` 仍保留。
- Phase 2.2：1M+ window 下 observation masking 完全跳过（`27a6679`）。
- Phase 2.3：86% proactive session split 已实现，并修复为在 `addUserMessage()` 前触发以避免吞掉新输入（`ed54f59`, `d858678`, `7c27770`）。

因此本文下面的“实施路径”应理解为设计来源与历史计划；当前下一步不再是 Phase 0，而是：

1. 用真实 DeepSeek API 跑 20+ turns，复核 cache-log / billing 是否不再出现由注入位置滑动、habituation promotion、1M masking 造成的 >10% 命中率骤降。
2. 评估 Phase 3 是否继续推进：客户端工具修复、HCA 步幅对齐、JSON key 排序/并行工具结果稳定排序。

## 背景

### 用户需求
当前 DeepSeek V4 prefix cache 命中率约 90%（官方后台：5000 万输入 tokens / 500 万未命中）。目标：探索提升到 99%+ 的可行性。参考对象：[deepseek-reasonix](https://github.com/esengine/deepseek-reasonix) 声称 99.82%。

### 项目上下文
- Rivet：terminal coding agent，1M context window，DeepSeek V4 API（官方直连，非 cliproxy）
- 当前架构：frozen volatile + dynamic appendix 分离，CACHE_ANCHOR_MESSAGES=2，cache-preserving compaction 策略
- 已知问题：前端 cache-log 显示 0%（API response 的 `prompt_cache_hit_tokens` 字段未被正确解析到 TUI），但实际 billing 确认 90% hit

### 调研发现摘要
- **Reasonix**：纯静态 system prompt + append-only log + head-only compaction + 客户端工具修复 + 确定性工具结果排序
- **DeepSeek 机制**：64-token 最小单元，字节精确匹配，磁盘缓存（TTL 数小时到数天），V4 压缩步幅对齐（CSA 8-token, HCA 128-token）
- **跨领域原则**：缓存系统奖励单调性，惩罚 key 空间中的新颖性

---

## 三轮思考过程

### 第一轮：变异

生态位：DeepSeek V4 / 1M window / terminal coding agent / 30-100 turn sessions / 90% baseline

4 个方案：
- **V1（渐进修复）**：修复 frozen volatile 中的字节泄漏点（workingSet 移到 dynamic）
- **V2（Reasonix 移植）**：纯静态 prefix + head-only compaction + 客户端工具修复
- **V3（双层 prefix）**：利用 DeepSeek 跨请求公共前缀检测，多 session 共享 prefix
- **V4（零 compaction）**：1M 窗口下禁用 compaction，用 session 分裂替代

### 第二轮：选择

灭绝：
- V3 — DeepSeek 公共前缀检测是被动机制，system prompt 已经跨 session 稳定，额外收益不确定
- V2（降级为参考）— 全量重构成本太高，核心洞察可通过 V1+V4 渐进实现

存活：V1（基础层）+ V4（核心层），组合使用

回收特征：
- V2 的客户端工具修复 → Phase 3
- V2 的 head-only compaction → V4 的降级方案
- V3 的 HCA 步幅对齐 → V1 的 system prompt 长度优化

### 第三轮：适应

收敛洞察：**在 1M 窗口下，最好的 cache 策略是"不修改任何东西"**。V1 减少不必要的修改，V4 直接禁止修改。Reasonix 的 99.7% 也收敛到这个方向。

---

## 最终方案

### 核心策略

**在 1M 窗口下，用"永不修改历史 + session 分裂"替代"compaction"**

### 当前 10% miss 来源分解（实测 baseline）

| 来源 | 占比 | 可控？ |
|------|------|--------|
| 首轮冷启动 | 2-3% | 不可控（跨 session 磁盘缓存可摊薄） |
| Compaction 事件 | 3-4% | ✅ 可消除（禁用 + session 分裂） |
| frozen volatile 变异（habituation promotion） | 5-20% per event | ✅ 可修复（consolidatedBlock 移到 dynamic） |
| pruneStaleToolResults 修改历史 | 1-2% | ✅ 可修复（改为请求时 mask） |
| workingSet 变化 | 0%（已是冻结快照） | 无需修复 |
| Observation masking 滑动 | ~0.5% | 可优化 |

### 实施路径

#### Phase 0：修复 cache 显示（前提·半天）

**问题**：API response 中的 `prompt_cache_hit_tokens` 未被解析到 TUI cache-log。DeepSeek 官方 API 直连，billing 确认 90% hit，但前端显示 0%。

**动作**：
1. 检查 `src/api/openai-client.ts` 中 `prompt_cache_hit_tokens` → `cache_read_input_tokens` 的映射是否在 DeepSeek provider 下生效
2. 确认 DeepSeek API response 的实际字段名（可能是 `prompt_cache_hit_tokens` 或其他变体）
3. 修复后每轮都能看到实际 hit/miss，为后续优化提供实时反馈

**成功标准**：cache-log 显示非零 hit tokens
**退出条件**：如果 DeepSeek API 确实不在 response 中返回 cache 字段（只在 billing 中体现），则接受无法实时监控，用 billing 做周期性验证

#### Phase 1：修复字节泄漏（低垂果实·2-3 天）

**1.1 consolidatedBlock（habituation promotion）从 frozen volatile 移到 dynamic appendix**

文件：`src/prompt/engine.ts:147-151`

当前 field-habituation 的 `consolidatedBlock` 变化会直接修改 `this.volatileBlock`（frozen volatile 的一部分），导致 system prompt 字节变化，整个 prefix 失效。实测：一次 promotion 在短 session 中造成 20%+ miss（Turn 4: 92.9% → Turn 5: 69.7%）。

修复：consolidatedBlock 的内容移到 `buildDynamicAppendix`（在消息历史之后注入，不影响 prefix）。frozen volatile 只包含初始化时的静态内容（rivetMd + sessionMemoryBlock）。

预期收益：消除 habituation promotion 导致的锯齿形命中率（~5-20% per event）

**1.2 workingSet 确认无需修改**

经代码审查确认：workingSet 在 `createVolatileSnapshot` 中通过 `Object.freeze` 冻结，session 中途不会变化。之前假设有误，无需修改。

**1.2 pruneStaleToolResults 改为请求时 mask**

文件：`src/compact/prune.ts`, `src/agent/compaction-controller.ts`

当前 `pruneStaleToolResults` 直接修改 messages 数组（存储层变异）。改为：
- messages 数组永不修改（append-only）
- 在 `buildOaiRequest` 时，对超过 protectRecent 的旧工具结果做临时替换（只影响发送给 API 的 payload，不影响存储）

预期收益：消除 prune 导致的 prefix 失效（~1-2%）

**1.3 工具结果字节归一化**

文件：`src/agent/tool-pipeline.ts`

在工具结果写入消息历史前：
- JSON 输出做 key 排序（`JSON.stringify(obj, Object.keys(obj).sort())`）
- 去除 trailing whitespace
- 确保并行工具结果按声明顺序（而非完成顺序）写入

预期收益：消除非确定性序列化导致的偶发 miss（~0.5%）

**Phase 1 总预期**：90% → 93-95%

#### Phase 2：零 compaction 策略（核心·3-5 天）

**2.1 1M 窗口下禁用 microCompactOai**

文件：`src/agent/compaction-controller.ts`

当 `contextWindow >= 1_000_000` 时：
- 跳过 `microCompactOai`（不再重写历史）
- 跳过 `compactStaleRoundsOai`（不再截断旧 round）
- 保留 95% ceiling 的紧急逃生（`enforceContextCeiling`）作为最后防线

**2.2 observation masking 固定化**

文件：`src/prompt/engine.ts`

当前 `MASK_WINDOW = 10` 是滑动的（每轮边界移动 → 之前 mask 的内容变了）。改为：
- mask 只在 `buildOaiRequest` 时应用（不修改存储）
- 或者固定 mask 边界到 compaction 点（不滑动）

**2.3 session 分裂替代 compaction**

文件：新增 `src/agent/session-split.ts`

当 context 接近 86% 时：
- 生成 handoff summary（已有 `pre-compact-handoff.ts`）
- 结束当前 session
- 开新 session，handoff summary 作为第一条 user message
- 新 session 的 system prompt + tools 立刻命中磁盘缓存（跨 session 不变）

**Phase 2 总预期**：93-95% → 97-98%

#### Phase 3：进阶优化（可选·1 周）

**3.1 客户端工具修复 pipeline**

参考 Reasonix 的 scavenge/truncation/storm：
- 工具调用 JSON 解析失败时，尝试客户端修复（补全括号、修复 trailing comma）
- 减少因工具失败导致的模型重试（重试 = context 变异 = cache miss）

**3.2 System prompt HCA 步幅对齐**

确保 system prompt 长度对齐 128-token HCA 压缩步幅边界，最大化 V4 的压缩缓存效率。

**3.3 field-habituation 反向应用**

已提前到 Phase 1.1 实现（consolidatedBlock 移到 dynamic appendix）。此处保留为验证项：确认 promotion/demotion 不再影响 prefix 字节。

**Phase 3 总预期**：97-98% → 98-99%（接近 Reasonix 水平）

---

## 与 Reasonix 的差距分析

| 维度 | Reasonix | Rivet 当前 | 修复后 |
|------|----------|-----------|--------|
| System prompt | 纯静态，零插值 | frozen volatile 含 workingSet | Phase 1.1 修复 |
| 消息历史 | append-only，永不修改 | prune/stale-round 修改中间消息 | Phase 1.2 修复 |
| Compaction | head-only（只压缩旧消息） | 全量重写 | Phase 2.1+2.3 替代 |
| 工具失败 | 客户端修复 | 模型重试 | Phase 3.1 |
| 并行工具顺序 | 按声明顺序 | 需验证 | Phase 1.3 |
| 复杂度 | 低（纯 agent loop） | 高（hooks/evidence/delivery gate） | 接受差距 |

**为什么 Rivet 的天花板是 97-98% 而非 99.7%**：
- Rivet 有 runtime hooks pipeline（9 个 hooks），每个 hook 可能触发 volatile 变化
- Evidence/delivery gate 系统在 turn-end 注入 badge（dynamic appendix，不影响 prefix，但增加了系统复杂度导致偶发泄漏）
- Field habituation 的 promotion/demotion 是一次性 miss，但 Rivet 有更多字段在流动

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| Phase 0 发现 API 不返回 cache 字段 | 中 | 无法实时监控 | 用 billing 周期验证 |
| 禁用 compaction 后长 session 质量下降 | 低 | 模型注意力分散 | observation masking + session 分裂 |
| Session 分裂 handoff 丢失关键上下文 | 中 | 新 session 重复工作 | 复用已有 pre-compact-handoff（已验证） |
| workingSet 移到 dynamic 后模型看不到 | 低 | 无影响（dynamic appendix 每轮都注入） | 验证 buildDynamicAppendix 包含 workingSet |

---

## 下一步

历史计划中的 Phase 0/1/2 已基本进入代码。当前下一步是实测与收尾：

1. 跑真实 DeepSeek session，观察 `.rivet/cache-log.jsonl` 或 session scoped `.rivet/sessions/<sessionId>/cache-log.jsonl`，确认 Turn 2+ 命中率稳定且无由 cachedFreshBlock 位置滑动导致的 >10% 锯齿。
2. 对照 billing 复核 cache-log 字段是否可信；若 API usage 与 billing 不一致，以 billing 为最终口径。
3. 确认 session scoped runtime 路径：`cache-log.jsonl` 现在优先位于 `.rivet/sessions/<sessionId>/cache-log.jsonl`；旧 bundle / 旧 commit 才可能继续写 `.rivet/cache-log.jsonl`。
4. 若仍要冲击 98-99%，再进入 Phase 3：客户端工具修复、HCA 步幅对齐、工具结果确定性增强。
