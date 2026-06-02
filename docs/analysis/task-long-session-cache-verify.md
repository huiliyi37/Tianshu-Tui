# 生产任务：长会话缓存验证

**目标**：在长时间、多轮次的真实编码会话中验证 `ce34bdc` (frozen appendix) 的缓存命中率是否能稳定达到 99%+。

**任务**：整理并提交当前工作区中所有已修改但未提交的 TUI 组件文件。

---

## 待处理文件清单（17 个文件）

| 文件 | 变更行数 | 说明 |
|------|---------|------|
| `src/tui/glance-bar.tsx` | +81/-? | 大量变更 |
| `src/tui/markdown-render.tsx` | +41/-? | 渲染优化 |
| `src/tui/onboarding.tsx` | +38/-? | 欢迎页改进 |
| `src/tui/tool-card.tsx` | +27/-? | 工具卡片 |
| `src/tui/thinking-message.tsx` | +26/-? | 思考消息 |
| `src/tui/thinking.tsx` | +23/-? | 思考组件 |
| `src/tui/tool-family.ts` | +20/-? | 工具组 |
| `src/tui/render-entry.tsx` | +16/-? | 渲染入口 |
| `src/tui/gutter.ts` | +/-10 | 间距调整 |
| `src/tui/user-message.tsx` | +9/-? | 用户消息 |
| `src/tui/system-message.tsx` | +3/-? | 系统消息 |
| `src/tui/assistant-message.tsx` | +1/-? | 助手消息 |
| `src/utils/debug.ts` | +3/-? | 调试工具 |
| `src/tui/__tests__/gutter.test.ts` | +/-11 | 测试 |
| `src/tui/__tests__/tool-family.test.ts` | +/-6 | 测试 |
| `src/agent/compaction-controller.ts` | +/-11 | 日志增强 |
| `src/agent/loop.ts` | +/-5 | P0 修复 |

---

## 执行步骤

对每个文件：
1. `read_file` 查看当前变更
2. 理解变更意图
3. 如果变更是有价值的改进 → `git add` + `commit`
4. 如果是调试/临时代码 → `git checkout` 还原

**预期产生 30-60+ 轮 API 调用**，每个文件至少 1x read + 1x commit/checkout。

---

## 验证方式

完成后查看最新会话的 `cache-log.jsonl`，关注：
- 稳态 `cacheCreate p50`（目标：≤ 400）
- ≥99% 轮次占比（目标：≥ 80%）
- 是否存在 turn 2 暴跌
