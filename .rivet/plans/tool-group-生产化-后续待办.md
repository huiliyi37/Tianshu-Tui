> **Status: COMPLETED** — 2026-06-19 (核心已交付，剩余文档清理为低优先级)

# Tool Group 生产化 — 后续待办

> 上次更新：2026-06-14 · 状态：核心已交付，2 项留后续

---

## 已交付

| 项目 | 状态 | 提交 |
|------|------|------|
| `collapsed-read-search.ts` 新文件（类型 + `CollapsedReadSearchBuffer` + 纯函数） | ✅ | `8f006e59` |
| 纯函数测试 `collapsed-read-search.test.ts`（43 条） | ✅ | `8f006e59` |
| `app.ts` 接线（id 绑定、G3 pendingTools 泄漏、统一 read+search 组） | ✅ | `f608db1c` |
| live 区 collapsible 聚合行（`formatCollapsedGroupLive`） | ✅ | `f608db1c` |
| ctrl+o 组展开（`lastCollapsedGroup` + `expandLastTruncatedTool` 扩展） | ✅ | `f608db1c` |
| 旧文件 `tool-group.ts` deprecation re-export | ✅ | `f608db1c` |
| GlanceBar cache 0% 显示 + ctx `<1%` 修复 | ✅ | `e32429f4` |
| compaction `_ensurePrefixOverhead` 提前（worker 会话 token 估算修复） | ✅ | `e32429f4` |
| G4 flush 后迟到 result 自动开新组 | ✅ | `13854c8c` |
| 集成测试 `app-tool-group.test.ts`（6 条，覆盖 #1-#4+G4） | ✅ | `13854c8c` |

---

## 后续待办

### 1. 文档更新（原 wave4-docs）

- [ ] 更新 `docs/teamtask/` 下 t9_ui backlog（标记 Tool Group Collapsing 已完成）
- [ ] `collapsed-read-search.ts` 模块顶部注释补充设计决策（温跃层、id 绑定理由）
- [ ] 删除 `src/tui/__tests__/tool-group.test.ts`（Ink 组件测试，现在只测 `typeof`）

### 2. 清理旧文件（deprecation 窗口到期后）

- [ ] 删除 `src/tui/format/tool-group.ts`（deprecation 窗口：2026-06-28）
- [ ] 删除 `src/tui/tool-group.tsx`（Ink 组件，`app.tsx`/`render-entry.tsx` 仍在引用）← 需评估

---

## 原计划中未做的项目

以下为原始 Cursor plan 的 wave 级 todo，对照当前状态：

| 原 plan wave | 内容 | 状态 |
|-------------|------|------|
| wave1-model | 重构 CollapsedReadSearch 类型 + 纯函数 | ✅ |
| wave1-app | app.ts 改 buffer、id 绑定 | ✅ |
| wave1-tests | collapsed-read-search.test.ts | ✅ |
| wave2-render-expand | 摘要 + ctrl+o 展开 | ✅ (部分：group 展开已实现，单卡展开保留为回退) |
| wave3-live-dedup | live 区聚合行 | ✅ |
| wave4-docs | 文档与注释更新 | ⬜ 待做 |

G3/G4/G5/G6 来自天枢评估补充；G1/G2/G7/G8 已随附实现。

---

## 不做的（明确排除）

- 不实现 CC `collapseReadSearch.ts` 的 memory/teamMem/bash-git/MCP/hook 吸收（P3 扩展口，留后续）
- 不按时间间隔自动分组（反证结论：语义区分需要模型理解，纯函数做不到，交给 ctrl+o 展开）
