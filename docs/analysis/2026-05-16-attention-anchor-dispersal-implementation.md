# 工作记录：Attention Anchor Dispersal

**日期**: 2026-05-16
**分支**: main

## 背景

实施 `docs/superpowers/plans/2026-05-16-rivet-attention-anchor-dispersal-implementation.md` 完整计划（5 任务），解决复杂任务中模型注意力坍缩到最小补丁的问题。

## 提交记录

| Commit | 任务 | 内容 | 测试 |
|--------|------|------|------|
| `25903e1` | 1 | Git log 注入 `<recent-commits>` | 474 |
| `d5b2dd8` | 2 | Behavior Mirror 检测器（3 种模式） | 479 |
| `1ce9cab` | 3 | Decision Anchor 提取器 | 485 |
| `cad54df` | 4 | VolatileContext 扩展 mirror + decisions | 485 |
| `be2c91c` | 5 | Agent Loop 集成 | 485 |
| `2902a60` | docs | 计划标记完成 + README | 485 |
| `xxx` | fix | Code review: 补充 volatile.test.ts 新 section 测试 | 496 |

## 架构

三层注意力分散，各有独立触发条件：

| 层 | 触发 | XML section | 来源 |
|----|------|-------------|------|
| Git log | 每次 volatile 刷新（30s TTL） | `<recent-commits>` | `volatile-git.ts` |
| Behavior Mirror | turn 3+ | `<behavior-mirror>` | `behavior-mirror.ts` |
| Decision Anchors | 模型无 tool_use 的 turn | `<decisions>` | `decision-anchor.ts` |

### Behavior Mirror 检测优先级

1. 重复错误类（2+ 次相同 errorClass）
2. 重复编辑同一文件（3+ 次 edit_file/write_file）
3. 未验证的编辑（3+ 次连续 edit/write 无 test/bash）

### Decision Anchor 提取

正则匹配 `I'll`、`approach:`、`方案是` 等模式，最多 3 条，最少 15 字符。使用 `[^.。]` + lookahead 防止跨句匹配。

## Code Review 修复

| 问题 | 修复 |
|------|------|
| 新 XML section 无测试覆盖 | 追加 9 个测试（recent-commits 3 + behavior-mirror 3 + decisions 3） |

## 测试覆盖

最终: 496/496 pass

新增测试分布:
- `volatile.test.ts`: +9（recent-commits, behavior-mirror, decisions 各 3 个）
- `behavior-mirror.test.ts`: 5（子代理创建，含 length<3 guard 修正）
- `decision-anchor.test.ts`: 6（子代理创建，含正则修正）

## 关键决策

1. **turn 3+ 激活**：mirror 和 task-state 在 turn 3 后才注入，避免浪费早期 turn 的 token
2. **fresh block only**：三层数据仅注入最新 turn 的 fresh volatile block，不影响 frozen prefix cache
3. **question-style mirror**：mirror 使用问句形式（"What is the root cause?"）而非指令，模型无关
4. **decisions at break path**：decision 提取在模型无 tool_use 时执行，捕获最终决策而非工具选择
