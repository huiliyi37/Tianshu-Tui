# Deep Brainstorm: Prefix Cache 位置跳动问题的跨领域灵感搜索

> 日期：2026-05-25
> 参与者：天璇（审查）+ 10 个并行 Scout
> 触发：Phase 1.1/1.2/1.3 修复后，cache-log 仍显示偶发 20%+ 骤降

## 0. 问题定义

`cachedFreshBlock`（dynamic appendix）每轮跟着 `lastUserIdx` 跳位置，导致上一轮的 last user message 位置字节变化，DeepSeek exact-prefix cache 从该点之后全部失效。

实测证据：
```
T7: input=41241 hit=39808 rate=96.5%
T8: input=43519 hit=30592 rate=70.3%  ← hit 下降 9216 tokens
T9: input=43780 hit=43520 rate=99.4%  ← 立刻恢复
```

## 1. Scout 调研结果

### Scout 1: AI 论文（KV Cache 优化）

**关键发现：**
- **EPIC (ICML 2025)**: Position-Independent Caching — KV 向量模块化编码后任意拼接，7x TTFT 提升
- **Irminsul (arXiv 2605.05696)**: Content-hash keying + MLA δ-rotation，恢复 ~83% prompt tokens
- **Stream2LLM (arXiv 2604.16395)**: 形式化 append-mode vs update-mode，11x TTFT 改进
- **SmartCache (NeurIPS 2025)**: Semantic Forest 层级索引，59% KV cache 内存缩减
- **KVFlow (NeurIPS 2025)**: Agent Step Graph 指导 cache 驱逐，2.19x 并发加速
- **CachedAttention (USENIX ATC 2024)**: KV cache 持久化到 host memory/disk，87% TTFT 降低

**启示**：学术界正在从 exact-prefix 向 position-independent 演进，但 DeepSeek API 层面仍是 exact-prefix。我们只能在消息布局层面优化。

### Scout 2: CDN/HTTP 缓存

**关键发现：**
- **HTTP Range 分片缓存**：文件分片独立缓存，追加只影响新分片
- **Stale-While-Revalidate**：cache miss 时返回旧内容，后台异步刷新
- **Surrogate-Key 精准失效**：依赖标签定向 purge，不波及无关缓存
- **Vary 归一化**：减少 cache key 变异维度
- **Irminsul** 和 **Stream2LLM** 也被此 scout 独立发现（交叉验证）

**核心洞察**：CDN 用 20 年从"整个 URL 是 cache key"演进到"分层 key"。LLM prefix cache 还在原始阶段。

### Scout 3: 竞品分析

**关键发现：**
- **Claude Code**: 动态内容只通过 `<system-reminder>` 注入到 user message 内部，system prompt 永不变，tools 永不增删
- **Cursor**: 每轮重建 prompt，依赖 provider 自动 cache
- **Aider**: `--cache-keepalive-pings` 每 5 分钟保持 cache 热度；architect/editor 双 cache 链
- **DeepSeek-TUI (Hmbown)**: 禁用 auto_compact 因为它破坏 prefix cache

**核心洞察**：Claude Code 的 "static first, dynamic last" + "动态内容注入到 user message 内部" 是已验证的最佳实践。

### Scout 4: 数据库 WAL/Append-Only Log

**关键发现：**
- **Segmented Log (Kafka/Prometheus)**: 数据 segment 密封后永不修改，摘要在 side-index
- **Copy-on-Write B-tree**: 修改只复制 leaf-to-root 路径，其余节点共享
- **LSM-Tree**: SSTable 不可变，manifest 是唯一可变部分
- **Git Packfile**: 内容寻址 + delta chain，base 不可变

**核心洞察**：所有 5 种技术用同一原则——"把可变摘要从不可变数据流中分离出来"。

### Scout 5: 视频编码（I-frame + P-frame）

**关键发现：**
- **GOP 结构**: I-frame 完整，P/B-frame 只存差异。中间插入需要重编码 boundary GOP
- **HLS Segment**: segment 边界对齐 keyframe，每个 segment 可独立解码
- **SVC 分层**: base layer 永不丢弃，enhancement layer 可任意丢弃
- **CRDT delta-mutator**: 只传输差异，不全量重传

**核心洞察**："把稳定部分和变化部分分离到不同层/粒度/时间线上"。

### Scout 6: DeepSeek 官方文档

**关键发现：**
- 最小缓存粒度：**64 tokens**
- TTL：**数小时到数天**（磁盘存储，MLA 压缩）
- 匹配方式：**精确前缀，从 token 0 开始**
- 无 cache_control 标记，全自动
- 无写入惩罚（90% 折扣）
- 跨 session 共享（同一 API key）

**硬约束确认**：我们无法改变匹配算法，只能优化消息布局。

### Scout 7: 编译器增量编译

**关键发现：**
- **Rust Fingerprint**: 内容哈希比对，相同则复用
- **Salsa Durability 分层**: 高 durability 输入（标准库）对低 durability 变化免疫
- **Salsa Firewall**: 粗粒度节点截断脏传播
- **Bazel Change Pruning**: 重建后结果不变则下游 cache 复活
- **LLVM CAS**: IR 级别内容寻址，函数粒度缓存

**核心洞察**：Salsa 的 "durability 分层 + firewall 截断" 直接映射到我们的 "system prompt(高) > tools(高) > history(中) > dynamic context(低)" 分层。

### Scout 8: CRDT 位置无关更新

**关键发现：**
- **RGA**: 每个字符有全局唯一 ID，操作锚定在 ID 而非索引上
- **Yjs RelativePosition**: 通过 (clientID, clock) 引用元素，不受插入影响
- **Merkle DAG 结构共享**: 修改一个节点只影响 leaf-to-root 路径
- **内容寻址 vs 位置寻址**: cache key = hash 链而非 token 范围

**核心洞察**：从"位置寻址"到"内容寻址"能实现插入不变性。但需要推理引擎支持——我们在 API 层无法实现。

### Scout 9: 网络协议 Trailer/Epilogue

**关键发现：**
- **HTTP/2 Trailers**: 动态元数据（checksum、签名）放在 body 之后
- **gRPC Trailing Metadata**: 状态码放在流末尾（需要处理完才知道结果）
- **TCP FIN**: 结束信号在最后（数据发完才能结束）
- **Protobuf**: 新字段追加新 field number，旧 parser 忽略未知字段
- **MIME Multipart**: 正文在前，附件在后

**核心洞察**：5 个协议都遵循"prefix 稳定 + 动态内容放末尾"。这是信息论层面的优化——结论需要处理完才能得出，所以放末尾是自然位置。

**实战验证**：ProjectDiscovery 案例——把动态内容从 prefix 移到 tail，cache hit 从 7% → 85%。

### Scout 10: Rivet 代码分析

**关键发现：**
- `cachedFreshBlock` 在 `lastUserIdx` 前面作为独立 user message 注入（line 174）
- `volatileBlock`（frozenBase）在 `firstUserIdx` 前面注入（line 178），永不变
- `cachedFreshBlock` 在同一 user message 的 tool-call 轮次内不变（缓存机制 line 123）
- 当 `firstUserIdx === lastUserIdx` 时存在消息重复

## 2. 假设合成

基于 [Scout 3: Claude Code 的 system-reminder 注入模式] + [Scout 9: 协议 trailer 原则] + [Scout 4: WAL 的"摘要从数据流分离"]：

**假设**：把 cachedFreshBlock 从"独立 user message"合并到"最后一条 user message 的 content 开头"，消息数组结构变为纯 append-only，prefix 字节 100% 稳定，cache hit 从 88% 提升到 95%+。

## 3. 方案演化

### 第一轮：变异（4 个方案）

| 方案 | 生态位 | 核心选择 |
|------|--------|----------|
| A（合并进 user msg） | 最简改动 | cachedFreshBlock 拼接到最后一条 user message content 开头 |
| B（固定位置） | 位置稳定 | cachedFreshBlock 永远在 firstUserIdx+1，内容每轮变 |
| C（trailer 末尾） | 协议对齐 | cachedFreshBlock 作为消息序列最后一条 user message |
| D（keepalive ping） | 补充方案 | 用户 >5min 无输入时发 max_tokens=1 请求保持 cache 热度 |

### 第二轮：选择

**灭绝：**
- **B 灭绝**：因果链断裂。位置固定但内容每轮变 → DeepSeek 从变化点起全部 miss → 和当前问题等价
- **D 降级**：不解决核心问题，DeepSeek TTL 数小时，优先级极低

**存活：** A（强）、C（中）

**A vs C 对比：**
- A：模型 attention 权重最优（dynamic context 紧邻用户输入）
- C：模型可能忽略末尾 context
- A：Claude Code 已验证
- C：无先例

### 第三轮：适应

**最终选择：方案 A**

理由：
1. Claude Code 已验证（`<system-reminder>` 注入到 user message 内部）
2. 实现最简（改 1 处逻辑）
3. 模型 attention 权重最优
4. 消除 firstIdx===lastIdx edge case

**融合 C 的 trait**：如果未来发现模型混淆问题，可切换到 C（trailer 位置）作为 fallback。

**融合 D 的 trait**：作为 Phase 2 补充，在用户思考超过 5 分钟时触发 keepalive。

## 4. 跨领域灵感总结

| 领域 | 核心原则 | 对我们的启发 |
|------|---------|------------|
| AI 论文 | Position-Independent Caching | 未来方向，当前 API 层不可用 |
| CDN | 分片独立缓存 + stale-while-revalidate | prefix 分层，变化只影响末尾 |
| 竞品 | Claude Code: dynamic 注入到 user msg 内部 | **直接可用，已验证** |
| WAL | 可变摘要从不可变数据流分离 | cachedFreshBlock 不应是独立消息 |
| 视频 | SVC 分层：base 永不丢弃 | system + frozenBase = base layer |
| DeepSeek | 64-token 粒度，精确前缀，磁盘存储 | 硬约束，只能优化布局 |
| 编译器 | Salsa durability + firewall | 分层截断脏传播 |
| CRDT | 内容寻址替代位置寻址 | 需引擎支持，当前不可用 |
| 协议 | Trailer = 动态放末尾 | 合并进最后一条消息 = trailer |

## 5. 未来方向（不在当前实施范围）

1. **Cache Keepalive Ping**：用户 >5min 无输入时发轻量请求（优先级低，TTL 已经很长）
2. **Compaction Cache-Cost Awareness**：compaction 前计算 cache 损失，如果损失 > 节省则不 compact
3. **Position-Independent Caching**：等 DeepSeek 引擎支持（EPIC/Irminsul 方向）
4. **Semantic Cache**：跨 session 的语义匹配（vCache 方向）

## 6. 论文/项目引用

- EPIC (ICML 2025): https://bytez.com/docs/icml/43926/paper
- Irminsul (arXiv 2605.05696): https://export.arxiv.org/abs/2605.05696
- Stream2LLM (arXiv 2604.16395): https://arxiv.org/html/2604.16395v1
- SmartCache (NeurIPS 2025): https://neurips.cc/virtual/2025/loc/san-diego/poster/116287
- KVFlow (NeurIPS 2025): https://neurips.cc/virtual/2025/loc/san-diego/poster/119883
- CachedAttention (USENIX ATC 2024): https://www.usenix.org/system/files/atc24-gao-bin-cost.pdf
- SGLang RadixAttention: https://arxiv.org/abs/2312.07104
- DroidSpeak (跨模型 KV 共享): https://arxiv.org/abs/2411.02820
- KVCOMM (多 agent KV 通信): https://github.com/HankYe/KVCOMM
- DeepSeek Context Caching: https://api-docs.deepseek.com/guides/kv_cache
- Claude Code Prompt Caching Blog: https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything
- ProjectDiscovery 案例 (7%→85%): https://dev.to/parag_d/prompt-caching-works-your-prompt-assembly-code-does-not-5edc
