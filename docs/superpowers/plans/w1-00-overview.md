# Wave 1 任务总览

> 日期：2026-05-21
> 执行方式：多 TUI session 并行，每个 session 领取任务独立交付
> 参考标准：4 TUI + 2 Opus 同分支 13 条独立交付

## 任务列表

| # | 任务 | 独立文档 | 复杂度 | 依赖 |
|---|------|----------|--------|------|
| 01 | Chat mode | `w1-01-chat-mode.md` | 中 | 无 |
| 02 | Multi-provider adapter | `w1-02-multi-provider.md` | 高 | 无 |
| 03 | 安装体验 (npx tianshu) | `w1-03-install-experience.md` | 中 | #02 |
| 04 | 用户文档重写 | `w1-04-user-docs.md` | 中 | #03 |
| 05 | Error recovery pipeline | `w1-05-error-recovery.md` | 高 | 无 |
| 06 | Verification dashboard | `w1-06-verification-dashboard.md` | 中 | 无 |
| 07 | Session replay | `w1-07-session-replay.md` | 高 | 无 |
| 08 | Confidence indicator + auto-escalation | `w1-08-confidence-escalation.md` | 中 | 无 |
| 09 | Cross-session memory 产品化 | `w1-09-cross-session-memory.md` | 高 | 无 |
| 10 | 多 session 协作协议 | `w1-10-multi-session-protocol.md` | 高 | 无 |
| 11 | Subagent orchestration Phase 1 | `w1-11-subagent-orchestration.md` | 高 | 无 |
| 12 | Performance baseline | `w1-12-performance-baseline.md` | 中 | 无 |
| 13 | E2E test suite | `w1-13-e2e-test-suite.md` | 高 | #02, #03 |

## 并行执行策略

```
Session A: #01 (chat mode) → #06 (verification dashboard)
Session B: #02 (multi-provider) → #03 (install) → #04 (docs)
Session C: #05 (error recovery) → #08 (confidence)
Session D: #07 (session replay) → #09 (cross-session memory)
Session E: #10 (multi-session) → #11 (subagent)
Session F: #12 (performance) → #13 (E2E)
```

## 数据记录

每个任务完成后在 `docs/superpowers/reports/w1-execution-data.yaml` 追加：

```yaml
- task: W1-XX
  session_id: <session 标识>
  model: <使用的模型>
  turns: <总轮数>
  duration_min: <耗时分钟>
  rework: <返工次数>
  challenged: <模型是否主动质疑> yes/no
  verified: <模型是否主动验证> yes/no
  boundary_found: <是否独立发现设计边界> yes/no
  degraded: <是否观察到退化> yes/no
  reliability_triggered: <是否触发 reliability mode> yes/no
  notes: ""
```

## 完成标准

- 13 个任务全部交付（≤ 3 天）
- 多 session 并行无 git 冲突
- 至少 8 个任务中模型主动质疑或主动验证
- 单 session 40+ 轮无退化
- `npx tianshu` 可安装可运行
- E2E test suite 全绿
- 内存稳态 <256MB
