# Rewind 后续待办

> 审查发现的问题，非阻塞，留待后续迭代处理。

## P2 — 代码质量

### 1. use-double-esc.ts 死代码
- **文件**: `desktop/src/hooks/use-double-esc.ts`
- **问题**: 创建了 hook 但 ThreadView 直接内联了相同逻辑，hook 无人调用
- **修法**: ThreadView 改用 hook，删除内联逻辑

### 2. event-reducer 截断用前 40 字符模糊匹配
- **文件**: `desktop/src/state/event-reducer.ts`
- **问题**: `prompt.slice(0, 40)` + `includes` 匹配，两条相似消息会误截断
- **修法**: rewind 事件携带 seq 或 block key，精确匹配而非文本搜索

### 3. window.dispatchEvent 全局事件 hack
- **文件**: `desktop/src/surfaces/ThreadView.tsx`
- **问题**: `window.dispatchEvent(new Event('rewind-complete'))` 触发重新拉取
- **修法**: 用 TanStack Query 的 `invalidateQueries`

## P3 — 功能补全

### 4. 桌面端 RewindOverlay 不支持 rollbackFiles
- **文件**: `desktop/src/components/RewindOverlay.tsx`
- **问题**: UI 只有一种操作（直接 rewind），没有"Restore code & conversation"选项
- **修法**: 选中消息后弹出操作选择（仅对话 / 对话+文件）

### 5. listRewindPoints timestamp 恒为 0
- **文件**: `src/server/session-manager.ts`
- **问题**: OaiMessage 无时间戳字段，返回 timestamp: 0
- **修法**: 从事件日志反查对应 user message 的 timestamp

### 6. rollbackFiles 路径无测试覆盖
- **文件**: `src/server/__tests__/rewind.test.ts`
- **问题**: `rollbackFiles: true` 的 getRollbackPreview + rollbackToCheckpoint 无测试
- **修法**: 补一条 mock checkpoint 的测试

## P4 — 已知限制（不修也行）

### 7. filesModified / filesRead 未随 rewind 重置
- **文件**: `src/agent/context.ts`
- **问题**: replaceMessages 重置了 turnCount/turnCacheHistory/compactedAtTurns，但 filesModified 和 filesRead 未重置
- **影响**: agent 自我追踪的文件列表可能包含已回滚的文件；仅影响显示，不影响 LLM 上下文

### 8. main.ts rewindExec 用 content 字符串匹配消息索引
- **文件**: `src/main.ts`
- **问题**: 通过 content === content 匹配找 index，重复消息场景可能误匹配
- **影响**: 低概率（用户极少发完全相同的消息）
