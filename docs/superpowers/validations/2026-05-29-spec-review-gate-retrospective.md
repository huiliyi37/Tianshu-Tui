# Spec Review Gate — 回测验证

> 回测目标：2026-05-29 Anthropic native client cache design spec
> 审查清单版本：v1 (docs/superpowers/spec-review-checklist.md)
> 日期：2026-05-29

## Q1: 约束提取完整性

| 约束 | spec 位置 | plan 是否接住 |
|------|----------|-------------|
| lookback window 20 block — 对话增长超 20 block 会 miss | 第 3 节 "其他已知坑" | ❌ 未接住（原始 plan Task 3 BP4 是静态"最后已完成轮"） |
| tools 非确定性序列化 → hash 变 miss | 第 3 节 | ✅ Task 2 用 sort + stableStringify |
| minCacheTokens 错值 (1024 vs 4096) | 第 3 节 | ✅ Task 1 修复 |
| 日期注入杀手 → system 每次 hash 不同 | 第 3 节 | ✅ Section 3.2 验证了 system 无日期 |
| tool_choice 变化失效 messages 缓存 | 第 3 节 | ✅ 保持恒定 tool_choice |

**Q1 结论：🔴 1/5 遗漏 → 应标红**

## Q2: 协议行为完整性

| SSE event | plan 处理 |
|-----------|----------|
| message_start | ✅ 读取 usage（cache_read/creation tokens） |
| content_block_start (text) | ✅ |
| content_block_start (tool_use) | ❌ 直接读 `block.input`（流式下为空 `{}`），未累积 input_json_delta |
| content_block_delta (text_delta) | ✅ |
| content_block_delta (input_json_delta) | ❌ 注释 "handled via content_block_start" 但实际无处理 |
| content_block_stop | ❌ 空 break，未 emit 拼好的 tool_use |
| message_delta | ✅ 读取 stop_reason + output_tokens |
| message_stop | ✅ |

**Q2 结论：🔴 3/8 遗漏 → 应标红**

## Q3: 字面值对齐

| spec 值 | plan 值 | 一致？ |
|---------|--------|--------|
| BP1 TTL: 1h | `{ type: 'ephemeral' }` (默认 5m) | ❌ |
| BP2 TTL: 1h | `{ type: 'ephemeral' }` (默认 5m) | ❌ |
| minCacheTokens: 4096 (Opus) | 1024 (Sonnet) | ❌ → Task 1 修正为 4096 |

**Q3 结论：🔴 3/3 不一致 → 应标红**

## Q4: 测试表面审计

| 源文件 | 测试文件 | 流式测试 |
|--------|---------|---------|
| anthropic-client.ts | ✅ `__tests__/anthropic-client.test.ts` | ❌ 只有 `buildRequestBodyForTest`，无 mock stream 测试 |
| factory.ts | ✅ `__tests__/factory.test.ts` | ✅ 已有 mock fetch 模式 |
| provider-profile.ts | ✅ `__tests__/provider-profile.test.ts` | ✅ |

**Q4 结论：🟡 流式测试缺失 → 应标黄**

## Q5: 边界条件

| 条件 | spec 位置 | plan 处理 |
|------|----------|----------|
| system 段无日期注入 → 断点 2 可用 | 第 1 节 "退出条件" | ✅ Section 3.2 验证 |
| system 段有日期 → 断点 2 降级或合并到断点 3 | 同上 | N/A（已验证不触发，显式标记） |
| lookback 窗口超 20 block → 每 ~15 block 加断点 | 第 3 节 | ❌ 未在原始 plan 中处理（后修正） |

**Q5 结论：🟡 1/3 条件分支在原始 plan 中未处理 → 应标黄**

## 总结

若在 plan 生成前跑此审查清单：

| 象限 | 结果 | 含义 |
|------|------|------|
| Q1 | 🔴 | 约束遗漏 → 阻塞 |
| Q2 | 🔴 | 协议处理不完整 → 阻塞 |
| Q3 | 🔴 | 字面值不对齐 → 阻塞 |
| Q4 | 🟡 | 测试盲区 → 标注后继续 |
| Q5 | 🟡 | 边界条件遗漏 → 标注后继续 |

**3 红灯 = 阻塞进入 Task 拆解。** 这 3 个红灯精确对应外部审查抓到的 H1(Q2)、M1(Q3)、M2(Q1)。修正后（本次实现中的两次 fix commit）可进入 Task 拆解。

**审查清单有效性：4/4 已知失败模式（H1/M1/M2/测试盲区）被捕获。**
