# 工作记录：XML Protocol + Code Review Fixes

**日期**: 2026-05-16
**分支**: main
**初始 HEAD**: 7859377
**最终 HEAD**: 6dcb02c

## 背景

实施 `docs/superpowers/plans/2026-05-16-rivet-xml-protocol-speculative-engine-implementation.md` 完整计划（6 任务 / 3 Phase），随后 3 轮 code review 修复。

## 提交记录

| Commit | 类型 | 内容 | 文件数 | 测试 |
|--------|------|------|--------|------|
| `a29811e` | feat | XML Protocol Layer + Speculative Pre-warming Engine (6 tasks) | 10 | 353 |
| `3f41e73` | fix | Code review: dead code, trigger, regex, file size bound | 3 | 355 |
| `8306483` | docs | 3 个实现计划标记完成 + CLAUDE.md 更新 | 4 | — |
| `b22f73b` | fix | P0 gaps: prewarm fast-path, session memory injection, worker concurrency, worker timeout | 6 | 355 |
| `6dcb02c` | fix | P1/P2: context ledger, cockpit ref sync, phase debounce, Esc collapse, plan doc | 9 | 357 |

## P0 必修问题修复

| 问题 | 根因 | 修复 | 影响文件 |
|------|------|------|----------|
| Prewarm cache 写入从不消费 | `loop.ts:301` 对所有 read_file 直接调用 `toolRegistry.execute()`，忽略缓存 | 缓存命中直接构造 `ToolResult` 返回，跳过文件读取 | `loop.ts` |
| Session memory 从不注入 prompt | `main.tsx` 构造 `PromptEngine` 时 `volatileCtx: { cwd }` 缺 `sessionMemoryBlock` | 构造时传入 `sessionMemoryBlock`；新增 `updateSessionMemory()` 方法支持 `/memory` 后动态更新 | `main.tsx`, `engine.ts`, `loop.ts` |
| Subagent 并发上限不生效 | `delegateBatch()` 用 `Promise.all` 一次跑所有任务 | chunk 按 `maxWorkers` 分组，每组 `Promise.all`，组间串行 | `coordinator.ts` |
| Worker timeout 不执行 | `runWorkerSession` 没有 abort 机制 | `setTimeout(agent.abort, timeoutMs)` + `finally` 清理 | `worker-session.ts` |

## P1/P2 改进

| 问题 | 修复 |
|------|------|
| Context Ledger `sessionMemory: null` | `SessionPersist.getSessionMemoryState()` → `AgentConfig` callback → `createContextLedger` |
| Cockpit `cockpitExpandedRef` 不同步 | `useEffect` 同步 state → ref |
| Cockpit 无 Esc 收起 | `useInput` 中捕获 `_key.escape` |
| Phase tracker 无 debounce | 2 次连续同类型工具调用才切换 phase（14 个测试） |
| 95%+ context 无 bold | `SummaryBar` bold={contextPct >= 0.95} |
| Plan doc 步骤未标记 | 34 个步骤全部 [x]，engine.ts 变更说明修正 |
| Intent extractor 正则遗漏目录 | 新增 config/scripts/docs/bin/tools/.github，新增 yml/yaml/toml |
| 大文件 prewarm 阻塞 event loop | `statSync` > 100KB skip |
| Modulo trigger 不稳定 | 改为 `lastPrewarmAt` 阈值: ≥500 字符触发 |

## 测试覆盖

初始: 323/323
最终: 357/357 (+34 个新测试)

新增测试分布:
- `static.test.ts`: 10 (XML section 验证)
- `volatile.test.ts`: +6 (tool-history rendering)
- `intent-extractor.test.ts`: 8 + 2 (新目录/扩展名)
- `prewarm.test.ts`: 6 (cache TTL/eviction/stats)
- `phase-tracker.test.ts`: 14 (从 11 重构为 debounce 版本，+3 用例)

## 关键架构决策

1. **Tool history per-turn injection**: 历史 turn 保持 frozen prefix（缓存友好），仅最新 turn 注入含 tool history 的 fresh volatile block
2. **Prewarm best-effort**: 缓存命中直接返回，miss 正常执行，不改变正常路径
3. **Phase debounce**: 2 次连续同类型才切换，防止工具交错时的闪烁
4. **Session memory 双重注入**: 构造时注入初始值 + `/memory` 动态更新，新鲜 volatile block 自动携带
5. **Worker timeout**: `setTimeout` + `AbortController.abort()`, `finally` 确保 timer 清理

## 文档更新

- `README.md`: status, data flow, prompt layering, cockpit, speculative pre-warming, worker safety, session memory 说明
- `docs/superpowers/plans/2026-05-16-rivet-xml-protocol-speculative-engine-implementation.md`: 34 步标记完成
- 本文件: 工作记录
