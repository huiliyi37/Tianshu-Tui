# write-tool「会话中断导致工具结果丢失」（已定位根因）

> 状态：根因已定位，主线修复已发布（2.17.0–2.18.0），agent 侧归因引导已加固
> 记录时间：2026-07-10（2026-07-10 排查更新）
> 来源：用户会话反馈（TUI 2.17）

---

## 1. 问题摘要

用户会话中，所有**写入类工具**（`edit_file` / `write_file` / `hash_edit`）返回"会话中断导致工具结果丢失"，但目标文件的磁盘写入全部成功（11/11）。读工具、`bash`、`run_tests` 均正常。

**关键更正**：初版记录推测"失败发生在响应帧回传阶段"，并列了序列化/传输超时/帧过大等 7 个候选原因——排查后确认**全部不成立**。那句"会话中断导致工具结果丢失"不是 transport 错误，而是本项目自己的 **orphan 恢复合成文案**（`src/context/write-evidence-probe.ts`）。

---

## 2. 真实机制

1. assistant 的 `tool_calls` 已持久化到会话 JSONL，写工具执行成功（文件落盘）；
2. 但 tool result 行在落盘前会话被中断（强杀/卡顿/断电）；
3. 下一次构建请求时 `runResumePreflightOai` 检测到孤儿 tool_call，为满足 API 配对约束合成占位结果注入——就是用户看到的那句话。

所以"磁盘 100% 成功、响应 100% 中断"不是矛盾，是同一机制的两面。

**为什么只有写工具**：写工具在磁盘写入之后还有展示用 diff 构建、LSP 诊断等收尾。根因是 jsdiff 同步 Myers diff 无界阻塞事件循环（大文件全量重写可跑数分钟）→ TUI 冻结（"卡住组"）→ 用户强杀 → result 丢失 → 合成恢复 → 模型重写 → 再次卡住。详见 `src/tools/edit-diff.ts` 头部注释（2026-07-08 root cause）。

---

## 3. 修复时间线

| 提交 | 内容 | 进入版本 |
|---|---|---|
| `e3aa0178` | 会话恢复时 write_file 结果丢失连锁修复 | 2.17.0 |
| `94ed95e8` | 增大 abort drain（3s）+ fdatasync 落盘 | 2.17.0 |
| `ea413390` | **根因**：同步 Myers diff 加 timeout 硬上界 | 2.17.0 |
| `335cdc26` | 修补两条 orphan tool_use 来源 | 2.17.0 |
| `fcab18d6` | orphan 永久循环修复（回写自愈）+ DEBUG_ORPHAN | 2.17.2 |
| `b126abfd` / `8700f809` | 写工具 orphan 非破坏恢复 + 磁盘证据探针 L2 | 2.18.0 |

---

## 4. Agent 侧误归因（2026-07-10 跟进修复）

遗留问题：模型连续看到多条"会话中断导致工具结果丢失"后，会自行归因为"系统架构有问题 / 工具层无法操作"，然后放弃写工具改用 bash 绕过（本文档初版第 6 节的"临时方案"正是模型这么推理出来的产物）。

修复（见 `src/context/write-evidence-probe.ts`）：

- 每条合成恢复文案追加**归因段**：明确这是宿主中断恢复占位，不是写工具故障，禁止改用 bash 绕过；
- 会话历史中已累计 ≥2 条恢复文案时追加**重复升级段**：要求模型把环境反复中断的事实如实报告给用户、建议升级版本，不得自行得出"工具层不可用"的结论；
- `session-persist.ts` 会话重载的 system-reminder 同步补充"NOT a tool malfunction"归因。

---

## 5. 排查手册（再遇到时）

1. 拿到会话 JSONL（`~/.rivet/sessions/<slug>/<id>.jsonl`），跑 `scripts/diagnose-tool-orphans.ts` 确认孤儿配对；
2. 从 `.meta.json` 确认版本号；< 2.17.2 → 先升级；
3. `RIVET_DEBUG_ORPHAN=1` 可输出 adjacency 违规细节；
4. 若 2.17.0+（已含 diff timeout）仍复现"卡住组"，排查 LSP 诊断等待与 import-graph 同步扫描等其余阻塞点——这是当前唯一开放项。

---

## 6. 关联信息

- 首次记录会话：其他用户会话（StickyNotesOverview.tsx 场景，TUI 2.17）
- 受影响文件类型：`.tsx`、`.ts`、`.js`、`.json`（均产 diff 收尾——与文件类型无关，与写族收尾链路有关）
