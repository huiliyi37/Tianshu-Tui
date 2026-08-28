# known-issues/ — 单点问题追踪

本目录收录**单点问题的跟踪档案**：现象、根因、修复方案、状态。一篇一问题（Diátaxis 的 issue 型）。

## 当前未结项（置顶维护）

| 文档 | 一句话 | 状态 |
|------|--------|------|
| [2026-08-05-desktop-scroll-stream-follow.md](2026-08-05-desktop-scroll-stream-follow.md) | 桌面端滚动 S2「完成后划不到底」两条候选根因待实机验证 | active |
| [2026-08-15-desktop-scroll-timeline-collapse-tug.md](2026-08-15-desktop-scroll-timeline-collapse-tug.md) | 桌面滚动时间线塌陷/拉扯——thinking 休眠遗留未动 | in-progress |
| [2026-06-07-volatile-test-hang-待办.md](2026-06-07-volatile-test-hang-待办.md) | volatile.test.ts fire-and-forget git spawn 死锁拖垮 `npm test`（开发者侧） | 待安排 |

> 桌面滚动线（前两条）的共同外部依赖：Windows/macOS 实机验收，见
> [2026-08-12-windows-session-stability-refactor.md](2026-08-12-windows-session-stability-refactor.md) 的验收待办。

## 状态口径

每篇开头应有状态行：`🔴 待修复` / `⏳ 待安排` / `🟡 进行中` / `✅ 已修复` / `✅ 已失效`（载体不存在）。
2026-08-28 起新文档建议直接带 frontmatter（`type: issue` + `status`，见 `docs/README.md` 总纲）；
存量篇目多为「状态行」旧式，二者并存合法——但**状态变化时必须更新**（2026-08-28 曾有两篇
「待修复」实际早已修复/失效，误导了后续排期）。

## 写作约定

- 命名 `YYYY-MM-DD-主题.md`（日期前缀排序友好）；零散的机制档案可语义命名
- 现象 → 证据（会话/日志/行号）→ 根因 → 修复方案 → 验证；关闭时写明关闭证据
- 修复落地后把状态改为 ✅ 并在此 README 的未结表移除
