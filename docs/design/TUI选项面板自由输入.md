# TUI 选项面板自由输入

## 背景

桌面端已经支持：
- `desktop/src/surfaces/QuestionCard.tsx`：Other… 自由输入
- `desktop/src/surfaces/PlanPanel.tsx`：Reject 带 comment 文本框

TUI 端原有 `choice-panel` 只能上下选择预定义选项，缺少自由文字输入入口。用户反馈希望在弹窗内直接输入，而不是关闭 overlay 后再到主输入框打字。

## 目标

让 TUI 的计划审批面板与 `ask_user_question` 面板支持在 overlay 内直接输入文字，且不关闭 overlay、不丢失前面选项的上下文。

## 改动对照

| 文件 | 改动内容 | 原因 |
|------|---------|------|
| `src/tui/format/overlay.ts` | `ChoicePanelData` 增加 `inputSubMode` 字段；`renderChoicePanel` 在底部渲染输入区 | 让选项面板具备内嵌输入能力 |
| `src/tui/engine/app.ts` | 新增 `choicePanelSubMode` / `choicePanelInputBuffer` / `choicePanelInputFor`；`openPlanApprovalPanel` / `openAskUserQuestionPanel` 初始化这些状态；`handleOverlayKey` 处理输入子模式的字符输入/退格/提交/取消；`registerOverlays` 把输入状态传给 `renderChoicePanel` | 管理 overlay 内输入状态与键盘事件 |
| `src/main.ts` | `choicePanelData` 给 `plan-approval` 增加 `__reject_comment__` 选项、给 `ask-user-question` 增加 `__other__` 选项；`choicePanelExec` 处理这两个 id，分别调用 `rejectPlan` + 提交反馈，或 `submitText` 提交自定义回答 | 把新的交互选项接入业务逻辑 |
| `src/tui/__tests__/format-choice-panel.test.ts` | 新增 2 个测试用例，覆盖输入子模式的渲染 | 防止回归 |

## 交互说明

### 计划审批面板

选项列表：
- 批准并执行
- 驳回修订
- 驳回并退出计划模式
- **驳回并填写反馈…**（新增）

选中「驳回并填写反馈…」并回车 → 进入输入子模式：
- 选项列表保持可见
- 底部显示「驳回反馈」输入框
- 可输入文字，Enter 提交，Esc 返回选项列表
- 提交后调用 `rejectPlan`，并把反馈作为用户消息提交给 agent

### 用户问题面板

选项列表末尾新增 **Other… / 自定义输入**。
- 选中并回车 → 进入输入子模式
- 输入文字后 Enter 提交，作为普通用户消息回传

## 前缀缓存影响

overlay 的打开、关闭、取消、子模式切换都是 TUI 本地状态，不进 LLM wire messages，因此不会影响前缀缓存命中率。

## 验证

- `npm run typecheck` 通过
- `npx tsx --test src/tui/__tests__/format-choice-panel.test.ts` 通过
- 相关测试（overlay、ask-user-question、plan-mode）通过
