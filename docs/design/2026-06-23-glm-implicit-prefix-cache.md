# GLM-5.2 隐式前缀缓存接入（修复超时风暴）

> 2026-06-23 · 关联计划 `glm cache enablement`

## 背景

GLM 会话（如 `d08bfc0c`）在 1M 窗口下频繁超时、中断。初步怀疑是「GLM 没有前缀缓存」，
但官方文档证伪了这个假设：

- [上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache)：GLM-5.2 支持**隐式缓存**
  （自动识别重复前缀，无需 `cache_control` 断点），命中量通过
  `usage.prompt_tokens_details.cached_tokens` 返回，命中 token 按约 50% 计费。
- [GLM-5.2](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2)：Solid 1M 无损上下文。

也就是说 GLM 的缓存模型与 **DeepSeek 的隐式 exact-prefix 缓存同构**，而非 Anthropic 式显式断点。

## 根因

Rivet 在三处把 GLM 标成「无缓存」provider，导致缓存保护机制对它整体失效：

| 文件 | 旧值 | 影响 |
|------|------|------|
| `src/api/provider-profile.ts` | `cacheType: 'none', persistent: false` | `isCachePreservingProvider()` 恒 false |
| `src/api/provider.ts`（capabilities） | `prefixCacheStrategy: 'none'` | 关闭 `engine.ts` 的会话常量快速晋升 + 缓存指纹 |
| `src/config/provider-presets.ts` | `prefixCache: 'none'` | 同上（preset 覆盖层） |

关键伤害路径在 `compaction-controller.ts`：

```
isCachePreservingProvider() = providerProfile.cacheType === 'exact-prefix' && persistent
```

GLM 命中 false → 1M 路径在 60%/75% 跳过 `cacheAdvisor.shouldDelayCompact` 的缓存保护检查 →
在 ~600K token 处无条件触发 LLM 压缩：

1. 压缩请求本身把 ~600K token 的提示发给 GLM（缓存未命中的整段 prefill）→
   超过 `SLOW_FIRST_BYTE_TIMEOUT_MS`(180s) → 报 `operation aborted due to timeout`
   （正是用户看到的 "Problem 2: LLM Compact summary timeout"）。
2. 压缩重写消息历史 → 作废 GLM 的隐式前缀缓存 → 此后每回合都退化为整段 prefill →
   更多超时。

DeepSeek 因为是 `exact-prefix + persistent`，`cachePreserving=true`，缓存热时延迟压缩，
不会陷入这个重写风暴。

## 实证（来自既有 cache-log，非假设）

每回合缓存面包屑写在 `<sessionDir>/<sid>/cache-log.jsonl`（`loop-factory.ts` 的
`recordTurnCache`），含 `model / input / cacheRead / hitRate / historyRewritten`。

翻历史 GLM 会话证实：**GLM coding 端点 `/api/coding/paas/v4` 确实返回 `cached_tokens`**，
且前缀稳定时命中率极高（多个会话 turn≥2 命中 87%–99.7%）。问题会话 `d08bfc0c` 的序列：

```
turn0 0.0%(冷启动) → turn1 87.1% → 46.0%(前缀部分失效) → 0.0%(整段失效) → 99.7% → 99.7% → 97.0% → 99.2%
```

99.7% 与 0.0%/46.0% 的交替，正是「前缀被压缩/重写打断」的指纹——也就是
`cachePreserving` 保护要消除的事件。

> 旁证：cache-log 的 `input`≈30K，而 meta 的 API `prompt_tokens`≈700K/回合（约 20× 虚高），
> 印证保留 `usageCalibrationFactor: 0` 的决定（见下「非目标」）。

## 改动

把 GLM 重新归类为「隐式 exact-prefix 缓存」provider（DeepSeek 同族），保留原生 1M 窗口：

- **`src/api/provider-profile.ts`** — `glm` → `cacheType: 'exact-prefix'`, `persistent: true`,
  `minCacheTokens: 64`。最高杠杆改动：翻转 `isCachePreservingProvider()` → 1M 压缩路径
  改为先问 `shouldDelayCompact`，缓存热时延迟压缩、不再无脑重写前缀。保留原 `attentionProfile`。
- **`src/api/provider.ts`**（glm capabilities）— `prefixCacheStrategy: 'deepseek-native'`
  （隐式 exact-prefix，无断点）+ `mapUsage: mapDeepSeekUsage`（稳健地把
  `prompt_tokens_details.cached_tokens` 读进 `cache_read_input_tokens`）。
- **`src/config/provider-presets.ts`**（glm）— `capabilities.prefixCache: 'deepseek-native'`
  （`resolveCapabilities` 仅在 `!== 'none'` 时才应用覆盖，必须显式写）。
- **`src/api/provider-registry.ts`** — 更新 glm notes。

## `shouldDelayCompact` 为何安全（自纠偏）

保护强度公式 `protection = hitRate × (1 − pressure)`，阈值 0.45：

- 若 GLM 缓存真的热（高 hitRate）+ 压力不高 → 延迟压缩，保住前缀。
- 若某回合缓存没命中（hitRate=0，比如 TTL 过期/端点冷）→ protection=0 → **不延迟**，
  退回原行为。即「只在缓存确实在命中时才保护」，不会把压缩拖到 OOM。

因此即便个别回合缓存未返回，也只是保护失效（无回归），绝不会比改前更差。

## 测试

- `src/api/__tests__/provider.test.ts` — 新增 GLM `resolveCapabilities`（deepseek-native +
  有 mapUsage）+ `prompt_tokens_details.cached_tokens → cache_read_input_tokens` 映射断言。
- `src/api/__tests__/provider-registry.test.ts` — glm = exact-prefix + persistent +
  deepseek-native + hasUsageMapping。
- `src/prompt/__tests__/engine-cache-stability.test.ts` — 新增 GLM(deepseek-native) turn1
  快速晋升；把原「无缓存不晋升」反例从 `glm-5.2` 换成 `minimax-m3`（glm 已不再是 none）。
- 目标套件全绿（provider/registry/conformance/engine-cache-stability、usage-calibration/presets/factory）。
  `compaction-controller.test.ts` 的 "P1.2 prune" 失败为既有问题（该用例不配 providerProfile，
  与本改动无关）。

## 非目标

- **不动 `usageCalibrationFactor: 0`**：保留既有「GLM coding API prompt_tokens 虚高」修复。
  `calibrateUsage` 在 factor=0 时按同一比例缩放 cache_read，命中**比率**保持不变 → 缓存感知压缩仍正确。
- **不缩窗口**：取代早先「给非缓存 provider 封顶窗口（root_window）」的方案——文档与日志已证明
  GLM 是 Solid 1M + 可用缓存，封顶会丢掉其招牌能力。改为正确对待缓存、保留 1M。
