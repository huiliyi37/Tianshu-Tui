# CTCL Cache Preservation Spine 方案记录

## 背景

Rivet 的终端架构以 CTCL（Claude Tool Compatibility Layer）为核心建设方向。当前讨论的目标不是让 cache 状态更可见，而是避免 DeepSeek exact-prefix cache 在真实请求路径中被无意义打穿。

本记录修正一个关键判断：**DeepSeek prefix cache 与压缩本身没有直接冲突**。用户在 Claude Code + CTCL 上观察到即使随意压缩，DeepSeek cache 仍可达到约 99.7% 命中。这说明只要主要请求前缀保持稳定，压缩发生在后段或非关键前缀区域时，不必然破坏 cache。

因此本方案不应以“限制压缩”为主线，而应以 **CTCL canonical prefix contract** 为主线。

## 已实现基础

Rivet 已经实现了多项与 cache preservation 相关的能力，后续设计应补齐缺口，而不是从零设计。

### PromptEngine 层

已有能力：

- system prompt 与 tools 作为稳定前缀。
- stable volatile block 与 latest-turn volatile block 分离。
- historical user message 前的 context 不重新生成，避免历史前缀漂移。
- prefix fingerprint 已覆盖 system、tools、stable volatile block。

需要补齐：

- fingerprint 稳定不等于真实请求字节稳定。
- tools 在 fingerprint 中排序，但真实 request body 仍需 canonical order。
- stable volatile 中动态字段需要持续审计，避免动态信息进入历史前缀。

### Provider Profile / Cache Strategy 层

已有能力：

- `deepseek` 标记为 `exact-prefix`。
- `anthropic` 标记为 `explicit-breakpoint`。
- `openai` 标记为 `partial-prefix`。
- `vllm` 标记为 `block-kv`。
- `cache-strategy.ts` 已区分 exact-prefix 与 explicit-breakpoint 行为。

需要补齐：

- provider profile 必须进入 runtime request path。
- `applyCacheStrategy()` 不能只停留在单元测试，应成为 CTCL/request builder 的一部分。
- DeepSeek exact-prefix 下禁止注入 Anthropic-style `cache_control`。

### ApiClient / Stream 兼容层

已有能力：

- unsupported params stripping。
- DeepSeek usage mapping hook。
- SSE `tool_use` partial JSON buffering。
- schema gate。
- tool JSON in text fallback。

这些能力本质上属于 CTCL，而不是普通 HTTP client。长期应收敛为 Rivet 自有的 CTCL Kernel。

## 修正后的核心判断

### 1. 压缩不是 cache killer

错误判断：

```text
压缩会打穿 DeepSeek cache，所以必须优先改 compact policy。
```

修正为：

```text
压缩只有在改写 DeepSeek 正在匹配的 cache-sensitive prefix 时，才会打穿 cache。
```

如果压缩改变的是后段消息，或者 DeepSeek 仍能复用前面巨大稳定段，那么 hit rate 仍可能保持很高。

### 2. Canonical prefix contract 比 compaction 更关键

Claude Code + CTCL 的高命中说明关键不是“不能压缩”，而是：

- 请求结构稳定；
- provider params 稳定；
- tool schema 稳定；
- session routing 稳定；
- provider 差异被稳定归一化。

DeepSeek-Reasonix 进一步证明：**CTCL 不是 99%+ 命中的必要条件**。它没有外置 CTCL，但通过 DeepSeek-native cache-first loop 仍公布了 99.82% 的真实使用命中率。必要条件不是“有没有 CTCL”，而是请求循环是否维持了 canonical prefix invariant。

Reasonix 的关键机制是：

```text
ImmutablePrefix: system + tool specs session 内冻结
AppendOnlyLog: 历史消息只追加，不重排、不就地改写
VolatileScratch: per-turn scratch 不进入下一轮 cache prefix
DeepSeek-only client: provider shape 单一，减少协议归一化需求
```

因此 Rivet 要补的核心能力不是“为了 cache 一定要经过 CTCL”，而是复制这种稳定请求形态。CTCL 在 Rivet 里更准确的定位是：当 Rivet 需要兼容 Anthropic-style 工具、OpenAI-style transport、多 provider 和 DeepSeek 特性时，用 CTCL Kernel 来守住同一个 canonical prefix contract。

### 3. CTCL 不能只是假设为本地 sidecar

当前本地 CTCL 是开发期参考形态，不应成为 Rivet 独立终端的永久依赖。

未来架构应是：

```text
Rivet Terminal
  -> PromptEngine
  -> CachePreservingRequestBuilder
  -> CTCL Kernel
  -> Provider Transport Adapter
  -> DeepSeek / Qwen / Kimi / GLM / OpenAI-compatible providers
```

CTCL 是 Rivet 终端自己的协议兼容内核，而不是用户本机某个固定路径脚本。

## 目标

让 Rivet 在 CTCL-based 架构下形成可测试、可执行的 cache preservation contract：

```text
同一 session 的 cache-sensitive request prefix 必须稳定；
provider/tool/params/routing/context 任意一层不能无意义扰动 prefix；
压缩只在改写 cache-sensitive prefix 时被标记为 cache boundary。
```

## 非目标

- 不优先做 cache 可视化。
- 不把 compaction 视为首要风险。
- 不禁止压缩。
- 不依赖用户本机固定 CTCL 脚本作为最终架构。
- 不一次性重写整个 ApiClient。

## 架构方案

### 1. CachePreservingRequestBuilder

位置：PromptEngine 与 CTCL Kernel 之间。

职责：

- 接收 PromptEngine 输出的 logical request。
- 固定 tools 顺序。
- 固定 provider params 顺序与存在性。
- 对 provider unsupported params 做深度剥离。
- 调用 provider cache strategy。
- 输出 canonical request body。
- 输出与真实 request body 对齐的 prefix hash。

关键约束：

```text
fingerprint 必须反映真实请求字节，而不是只反映逻辑对象。
```

### 2. CTCL Kernel

Rivet 自有协议兼容内核。

职责：

- request normalization；
- provider strategy；
- tool schema repair；
- SSE stream normalization；
- usage mapping；
- session routing key；
- provider-specific compatibility gates。

短期可以先从 `ApiClient` 内部抽边界，不需要一次性大拆。长期目标是让 `ApiClient` 退化为 transport adapter，只负责 HTTP/SSE IO。

### 3. Provider Transport Adapter

职责：

- HTTP fetch；
- SSE parsing transport；
- auth headers；
- abort signal；
- OpenAI Responses / Anthropic-compatible protocol 分流。

不应负责 tool repair、cache strategy、provider semantic normalization。

### 4. Lightweight Compaction Boundary Rule

压缩策略只保留轻量 cache 边界规则：

```text
如果压缩没有改写 cache-sensitive prefix，则不视为 cache risk。
如果压缩改写了 system/tools/stable context/early prefix，则标记为 cache boundary。
```

这不是优先实现线，只是防止未来错误地把 cache miss 全归因于 compaction。

## CTCL 产品形态演进与部署落点

### 当前开发链路：local CTCL + cliproxy

当前已验证的本地部署链路是：

```text
Claude Code / Rivet dev mode
  -> ANTHROPIC_BASE_URL
  -> cliproxy: 127.0.0.1:8891
  -> CTCL Bridge: 127.0.0.1:8893
  -> DeepSeek /anthropic-compatible endpoint
```

当前关联位置：

| 组件 | 当前落点 | 职责 | 是否最终产品依赖 |
|------|----------|------|------------------|
| cliproxy config | `~/.cli-proxy-api/config.yaml` | API key 管理、模型路由、payload filter、session affinity | 否，只是当前本地开发形态 |
| CTCL Bridge | `/Users/banxia/bin/claude-tool-compat-layer.mjs` | tool schema repair、SSE normalizer、usage/capability adaptation | 否，只是当前参考实现 |
| CTCL telemetry | `http://127.0.0.1:8893/stats` | 修复统计与调试面板 | 否，后续应迁入 Rivet 内部诊断 |
| Rivet provider path | `src/api/*` | 当前部分承担 CTCL 职责，如 stream buffer、schema gate、usage mapping | 是，后续应抽象为 CTCL Kernel |

这个链路证明了 DeepSeek cache 可在 CTCL 归一化后保持高命中，但它不能作为独立终端的交付假设。

### Phase A：开发期 local sidecar

```text
Rivet dev mode -> local CTCL sidecar -> provider
```

用途：对齐当前本地 CTCL 行为，验证 DeepSeek cache preservation 与 tool repair 经验。

部署关系：Rivet 可以显式配置 `ctcl.mode = "external"`，指向本地 CTCL Bridge；该模式只用于开发、迁移和对照验证。

限制：不能作为独立终端的最终依赖。

### Phase B：bundled managed sidecar

```text
Rivet package/binary
  |- TUI
  |- Agent Loop
  |- bundled CTCL sidecar
  |- Provider Transport Adapter
```

推荐部署落点：

```text
node/npm distribution:  dist/ctcl/sidecar.js
standalone binary:      embedded resource extracted to Rivet-managed runtime dir
runtime socket:         Rivet-managed local port or Unix socket
config owner:           Rivet config, not ~/.cli-proxy-api/config.yaml
```

Rivet 自己管理 CTCL 生命周期、端口/socket、provider config、session routing key。

适合近期开启独立发布。

### Phase C：in-process CTCL Kernel

```text
Rivet process
  -> src/ctcl/*
  -> Provider Transport Adapter
```

推荐部署落点：

```text
source boundary:        src/ctcl/
request normalizer:     src/ctcl/request-normalizer.ts
stream normalizer:      src/ctcl/stream-normalizer.ts
tool repair:            src/ctcl/tool-repair.ts
provider strategies:    src/ctcl/provider-strategy.ts
transport adapters:     src/api/* or src/transport/*
```

长期最优形态：无端口依赖，无外部 proxy 配置漂移，请求 canonicalization 可在进程内测试。

### Phase D：team/enterprise remote gateway（可选）

```text
Rivet Terminal
  -> Rivet CTCL Gateway
  -> Provider fleet
```

用途：团队统一 provider policy、审计、限流和集中式路由。它不能替代本地 CTCL Kernel contract；即使远程 gateway 存在，本地 Rivet 仍应先生成 canonical request 与 stable route key。

## 部署决策原则

1. 当前本地路径必须记录为参考实现，但不能写死进最终架构。
2. 独立终端发布时，CTCL 至少要进入 bundled managed sidecar。
3. 长期应迁入 `src/ctcl/*` in-process kernel。
4. 无论哪种部署形态，cache route key 与 canonical prefix contract 必须由 Rivet 拥有。

## 关键缺口

### 缺口 1：真实请求没有 canonical serializer

当前风险：`JSON.stringify(finalRequest)` 可能让 object key 顺序、provider param 顺序、工具顺序与 fingerprint 认知不一致。

补齐方向：新增 canonical serializer 或 canonical request builder，确保 DeepSeek cache-sensitive body 稳定。

### 缺口 2：tools 真实顺序未锁定

当前风险：fingerprint 对 tools 排序，但真实 request 使用注册顺序。

补齐方向：真实 request body 使用 canonical tools order。

### 缺口 3：provider profile 未进入 runtime 主链路

当前风险：`provider-profile.ts` 和 `cache-strategy.ts` 是正确基础，但还没有成为真实请求路径的必经环节。

补齐方向：`createProviderClient()` 或上游 factory 解析 provider profile，并传入 CTCL Kernel / RequestBuilder。

### 缺口 4：unsupported params strip 不够深

当前风险：只删顶层字段，message/content/tool schema 内部 provider 不支持或不稳定字段仍可能扰动 request bytes。

补齐方向：provider allowlist 优先，按 top-level / message-level / content-block-level / tool-schema-level 分层规范化。

### 缺口 5：session routing key 未产品化

当前风险：同一 Rivet session 如果在 provider worker、model、auth scope 或 fallback path 上漂移，prefix cache namespace 可能变化。

补齐方向：CTCL Kernel 生成稳定 route key：

```text
hash(provider + model + authScope + sessionId)
```

该 key 是 Rivet 自有协议契约，不依赖用户本地 proxy。

## 验收标准

1. 同一 session 内，system/tools/provider params/stable volatile 组成的 cache-sensitive prefix 在无实际变更时字节稳定。
2. tools 注册顺序变化不改变 DeepSeek request 的 canonical prefix。
3. DeepSeek request body 中不残留 `cache_control` 等 unsupported/cache-breaking 字段。
4. provider profile 与 cache strategy 进入真实 request path。
5. CTCL Kernel 边界明确：tool repair、stream normalization、usage mapping 不再被视为普通 HTTP client 职责。
6. 压缩不会被默认视为 cache miss 主因；只有改写 cache-sensitive prefix 时才标记为 cache boundary。
7. 未来独立终端不依赖用户本机固定 CTCL 脚本路径。

## 实施优先级

### P0：Canonical Prefix Contract

- canonical tools order；
- canonical request serialization；
- deep unsupported param normalization；
- provider profile 接入 runtime。

这是防 cache 打穿的主线。

### P1：CTCL Kernel 边界

- 从 ApiClient 中划出 request normalization / stream normalization / usage mapping 的职责边界；
- 保留兼容层测试；
- transport adapter 只保留 IO 职责。

### P2：Session Route Contract

- 生成稳定 cache route key；
- provider/model/auth/session 切换时明确 cache namespace boundary。

### P3：Compaction Boundary Annotation

- 不大改压缩；
- 只标注压缩是否改写 cache-sensitive prefix；
- 避免后续误把 compaction 当作主要 cache 风险。

## 最终结论

Rivet 要学习 Claude Code + CTCL 和 DeepSeek-Reasonix 高命中的共同点，不是“不要压缩”，也不是“必须有外置 CTCL”，而是：

```text
稳定请求结构 + 冻结 system/tools + append-only history + volatile scratch 隔离 + 稳定 provider/routing 归一化。
```

因此，下一轮方案和实施计划应围绕 **Canonical Prefix Contract** 展开。CTCL Kernel 是 Rivet 在多协议/多 provider/Anthropic-style 工具兼容下守住该 contract 的实现手段；压缩只作为条件性边界风险处理，不再作为 cache preservation 的主轴。
