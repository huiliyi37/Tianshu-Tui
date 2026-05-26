# MiMo 前缀缓存配置接入记录

> 日期：2026-05-27
> 分支：tianshu-pangu-2.9.1
> 提交：（见 git log）

---

## 1. 背景

MiMo v2.5-pro 使用 1M token 上下文窗口，但此前配置为 `cacheType: 'none'`，导致：

- compaction 策略为 `aggressive`（watch=500K, compact=700K）
- 每轮对话重新发送完整历史，无前缀复用
- 约 8-15 轮工具密集对话后即触发压缩

MiMo 后台实际支持自动前缀缓存（类似 DeepSeek），只需在配置层声明即可。

## 2. 修改内容

### 2.1 Provider Profile（编译时默认值）

**文件**：`src/api/provider-profile.ts`

```diff
- mimo: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
+ mimo: { cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 0 },
```

`cacheType: 'exact-prefix'` + `persistent: true` 表示：
- 服务端自动缓存请求的共同前缀
- 缓存跨请求持久（不因 TTL 过期）
- 命中时 `input_tokens` 中 cached 部分计费更低

### 2.2 Provider Capabilities（运行时配置）

**文件**：`src/config/default.ts`

```diff
  capabilities: {
    cacheControl: false,
    stripParams: [],
    toolJsonBug: false,
-   prefixCache: 'none' as const,
+   prefixCache: 'deepseek-native' as const,
    prefixCompletion: false,
  },
```

`prefixCache: 'deepseek-native'` 启用 DeepSeek 风格的原生前缀缓存策略。

### 2.3 测试更新

**文件**：`src/api/__tests__/provider-profile.test.ts`

```diff
  it('returns mimo profile', () => {
    const p = getProviderProfile('mimo')
-   assert.equal(p.cacheType, 'none')
+   assert.equal(p.cacheType, 'exact-prefix')
+   assert.equal(p.persistent, true)
  })
```

## 3. 影响范围

### 3.1 Compaction 策略切换

| 指标 | 修改前（aggressive） | 修改后（cache-preserving） | 变化 |
|------|---------------------|---------------------------|------|
| watch | 500K | 720K | +44% |
| compact | 700K | 860K | +23% |
| reactive | 840K | 920K | +10% |
| ceiling | 950K | 950K | 不变 |

策略选择逻辑（`src/compact/constants.ts`）：

```ts
function strategyForCacheType(cacheType: CacheType, persistent: boolean): CompactProviderStrategy {
  if (cacheType === 'exact-prefix' && persistent) return 'cache-preserving'
  if (cacheType === 'none') return 'aggressive'
  return 'balanced'
}
```

### 3.2 Token 预算变化

- **toolResultMaxTokens**：`min(contextWindow * 0.3, 200K)` = 200K tokens（不变，已是 1M 窗口上限）
- **autoFloor**：`min(720K, 500K)` = 500K（MINIMUM_AUTO_COMPACT_TOKENS 硬下限）
- **autoThreshold**：920K（reactive 触发点）

### 3.3 预期效果

- 更多上下文保留：watch 阈值从 500K 提升到 720K，可多保留约 220K tokens 的历史
- 减少不必要的压缩：缓存命中时前缀不重新计费，延迟压缩不影响成本
- Prefix cache 命中率提升：frozen prefix（系统提示 + 项目知识 + 会话记忆）在每轮请求中保持字节稳定

## 4. 验证

```bash
# provider-profile 测试
npm exec -- tsx --test src/api/__tests__/provider-profile.test.ts
# → 12 passed, 0 failed

# compaction 相关测试
npm exec -- tsx --test src/api/__tests__/*.test.ts src/compact/__tests__/*.test.ts src/agent/__tests__/compaction*.test.ts
# → 225 passed, 0 failed
```

## 5. 后续观察

- [ ] 监控 MiMo API 响应中的 `usage.prompt_tokens_details.cached_tokens` 确认缓存命中
- [ ] 观察实际 compaction 频率是否下降
- [ ] 如果 MiMo 缓存有 TTL（非永久），需调整 `persistent: false` 并降低 watch 阈值
- [ ] 如果 MiMo 缓存需要显式 breakpoint（类似 Anthropic），需改用 `explicit-breakpoint` 类型

## 6. 相关文件索引

| 文件 | 作用 |
|------|------|
| `src/api/provider-profile.ts` | Provider 缓存类型定义 |
| `src/config/default.ts` | 运行时 capabilities 配置 |
| `src/compact/constants.ts` | compaction 策略与阈值 |
| `src/agent/compaction-controller.ts` | compaction 执行逻辑 |
| `src/prompt/volatile-git.ts` | git status 30s TTL 缓存 |
| `src/prompt/engine.ts` | prefix cache 稳定性维护 |
