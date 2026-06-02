## 任务：验证 ce34bdc 修复后的缓存表现

### 背景
新的 `ce34bdc` 提交移除了 standalone appendix push（之前 appendix 被包含了两次：一次合并到 lastUser msg，一次作为独立消息）。修复后的会话 `2f0d8e6a` 已表现出 99.5-99.8% 命中率。

### 任务步骤

1. **确认代码状态**：检查 `src/prompt/engine.ts` 中 `buildOaiRequest()` 末尾是否还有 `cachedAppendix` 作为独立消息 push。
   - 应该只有合并到 lastUser msg 的版本（line 235-236），没有 `result.push({ role: 'user', content: this.cachedAppendix })`

2. **运行测试**：执行 prompt 测试验证 fix 正确
   ```bash
   npx tsc --noEmit && npm exec -- tsx --test src/prompt/__tests__/*.test.ts
   ```

3. **观察缓存**：任务完成后，读取当前 session 的 cache-log.jsonl，记录每轮命中率和 cacheCreate 数值。

4. **报告结果**：输出以下指标：
   - 总命中率
   - 稳态命中率（预热后的轮次）
   - cacheCreate 中位数
   - 是否有任何 100% 命中轮次
   - 大工具输出后的恢复速度

### 预期
- 稳态命中率应达到 99.5%+
- cacheCreate 应 < 500 tokens/轮（预热后）
- 大工具输出后应在 1-2 轮内恢复到 99%+
