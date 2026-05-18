# Wave 7 + Wave 8 实施复盘

**日期:** 2026-05-19  
**分支:** `feat/tui-2.4-structural-maturity` → `main`  
**复盘人:** 天枢

---

## 一、过程概要

| 阶段 | 内容 | 结果 |
|------|------|------|
| Wave 7 收尾 | A1-A7 全部接线，修复 3 个 env-dependent 测试 | ✅ 7/7，1908→1978 tests pass |
| Wave 8 规划 | 创建实施计划 (7 tasks) | ✅ plan 已提交 |
| Wave 8 实现 | coordination-policy → diff-collector → knowledge → worktree-coordinator → hands-session → coordinator routing → knowledge injection | ✅ 7/7，1979 tests pass |

---

## 二、遇到的问题与根因

### 1. 多会话并发修改冲突 🔴

**现象：** 在实现 Wave 8 过程中，另一个 session 也在修改相同的文件 (`coordinator.ts`, `worker-session.ts`, `hands-session.ts`, `work-order.ts`)。

**影响：**
- 我写入的文件被另一个 session 的提交覆盖
- `git commit` 失败报 "nothing to add"，因为文件已被其他 commit 修改
- 需要重新读取文件确认当前状态，增加来回确认成本

**根因：** 两个 session 同时在 `main` 分支上工作，缺乏分支隔离。

**建议：**
- 天枢 session 在 `feat/tianshu-wave8` 分支工作，完成后 PR → main
- 或者建立文件锁机制 (已部分实现 LWT guard)

---

### 2. TypeScript 严格模式下的类型摩擦 🟡

**现象：** 多次出现 TS 类型错误，需要反复修复：

| 错误 | 文件 | 修复 |
|------|------|------|
| `as const` 数组 `includes(string)` 不兼容 | coordination-policy.ts | `as unknown as readonly string[]` |
| `WorkerArtifact.kind` 缺少 `'diff'` | work-order.ts | 扩展 zod enum + 导出类型 |
| `ContextClaim` 缺少 `status`, `consumers`, `counterevidence` | worker-knowledge.test.ts | 补全必要字段 |
| `SessionPersist.filePath` 私有访问 | session-persist.ts | 添加 `getFilePath()` |

**根因：** TypeScript strict + `noUncheckedIndexedAccess`，测试中构造 mock 对象时容易遗漏字段。

**建议：**
- 在 `mocks.ts` 中提供标准工厂函数：`createMockClaim()`, `createMockStreamCallbacks()` 等
- 避免在测试中手写完整的 mock 对象

---

### 3. Strategy Shift 阻塞 🟡

**现象：** 在连续多次 `edit_file` 操作后，系统进入 "repeated identical failures detected" 状态，阻止所有 bash/git/diff/run_tests 操作。

**影响：**
- 无法验证代码修改是否正确
- 无法提交代码
- 需要等下一个 turn 恢复

**根因：** 内部策略规则检测到"5 file modifications without verification"，触发保护。

**建议：**
- 每次 edit_file 后立即运行相关测试或 typecheck
- 不要在同一个 turn 中连续修改多个文件
- 需要在 prompt/static.ts 中向 agent 传达这个行为约束

---

### 4. 上下文丢失 🔴

**具体丢失的内容：**

| 丢失内容 | 原因 |
|---------|------|
| `docs/TODO.md` | 被 rebase 或其他 session 删除 |
| Wave 8 早期提交 (`9aa826e` 等) | 被其他 session 的提交覆盖/替换 |
| 前一 turn 的 diff 结果 | 并发修改导致文件回到干净状态 |
| 我创建的 plan 文件名变更 | 其他 session 重命名为 `30362bb docs(wave8): rename hands routing plan by business scope` |

**影响：** 需要反复 `read_file` 确认当前文件状态，增加 token 消耗。

---

### 5. 非 Wave 8 文件的类型错误干扰 🟡

**现象：** `subagent-integration.test.ts` (另一个 session 创建的未跟踪文件) 持续产生 10+ 个 typecheck 错误，干扰了验证基线。

**根因：**
- 文件中有重复的对象属性 (TS1117)
- mock 的 callback 对象缺少字段
- `thresholdTokens` / `providerId` 等不存在的属性

**修复：** 另一个 session 提交了 `a724b4c test(agent): close subagent integration type drift` 修复了这些问题。

**教训：** 在多人并发工作时，未跟踪文件可能随时被他人修改。验证基线不稳定。

---

## 三、上下文保持评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 项目结构理解 | ★★★★☆ | 通过项目指令和代码阅读保持了良好理解 |
| 跨 turn 状态 | ★★★☆☆ | TODO.md 丢失、分支切换导致部分状态丢失 |
| 并发感知 | ★★☆☆☆ | 未能及时感知其他 session 的修改 |
| 策略适应 | ★★★☆☆ | 被 strategy shift 阻塞后学会了更谨慎的 edit 模式 |
| 文档同步 | ★★★★☆ | 产出了完整的 plan + closure 报告，交叉引用清晰 |

---

## 四、改进建议

### 短期 (本 session)

1. **分支隔离** — 天枢 session 使用 `feat/tianshu-*` 分支，不在 main 上直接开发
2. **提交前验证** — 每次 edit 后立即 `tsc --noEmit`，避免累积错误
3. **Mock 工厂** — 在 `mocks.ts` 中提供标准工厂函数

### 中期 (系统级)

4. **File ownership 检测** — 在 `git status` 或 volatile context 中显式标记其他 session 正在修改的文件
5. **Turn 级操作限制提示** — 在 system prompt 中明确告知 agent "每个 turn 最多修改 2-3 个文件"
6. **并发 session 通知** — 当另一个 session 修改了当前 session 的文件时，主动注入提示到 volatile context

### 长期 (架构级)

7. **Worker session 的 worktree 隔离** (Wave 8 已实现) 可以成为并发开发的参考模式
8. **Claim store 的 worker_finding → 主 session 可见** 可以作为跨 session 知识共享的雏形

---

## 五、成功交付

尽管遇到上述问题，最终交付物是健康的：

```
TypeScript: 0 errors
全量测试: 1979 passed, 0 failed, 0 skipped

Wave 7: 7/7 任务完成
Wave 8: 7/7 任务完成
文档: plan + closure 报告完整
```

---

*此报告由 天枢 维护，记录实施过程中的经验教训。*
