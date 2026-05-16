# ACF Research Findings

## 调研日期：2026-05-16

---

## Provider 缓存机制对比

| Provider | 窗口 | 缓存机制 | 稳定性要求 | TTL | 折扣 |
|----------|------|---------|-----------|-----|------|
| DeepSeek V4 | 1M | 自动精确前缀匹配 | 从第一个 token 精确匹配 | 磁盘持久化 | 90% |
| Claude | 200K | 显式 cache_control 断点 | 断点前字节相同 | 5min/1hr | 90% |
| OpenAI GPT-4o | 128K | 自动部分前缀匹配 | 128-token 粒度 | 5-10min | 50% |
| Gemini 2.5 | 1M | 显式命名缓存 + 隐式 | 精确匹配 | 1hr | 90% |
| Qwen | 128K | 显式 cache_control | 反向匹配最后 20 块 | 5min | 可变 |
| vLLM (本地) | 可配 | 块级 KV cache | 哈希块匹配 | LRU 淘汰 | 延迟节省 |

### 关键差异
- DeepSeek: 精确前缀，磁盘持久化（跨会话复用），64 token 最小
- Claude: 需要显式注入 `cache_control: { type: "ephemeral" }`，写入有 25% 附加费
- OpenAI: 128-token 粒度部分匹配（尾部小变动不影响缓存）
- Qwen: 反向匹配（从后往前），与其他 provider 完全不同

---

## 学术论文关键数据

### 压缩安全阈值
- 4x 压缩: <3% 精度损失
- 8x 压缩: ~8% 精度损失
- 16x 压缩: 15-25% 精度损失（灾难性）
- **结构化数据（代码/JSON）退化比散文更快**

### Lost-in-middle 效应
- 中间位置 (30-70% of window) 是注意力死区
- 20-30% 准确率下降
- 100K+ tokens 后中间位置 ~15-20% recall 损失

### BudgetMem (arXiv 2511.04919)
- 72.4% 内存节省，仅 1.0% F1 损失
- 结论：~70% 的累积上下文是冗余的

### MEMENTO (Microsoft 2026)
- 自压缩（模型写自己的摘要）比外部摘要好 10-15%
- 2.5x KV cache 缩减

### 单次提及事实
- 在摘要中被不成比例地丢失
- 需要 mention-count 保护机制

---

## 竞品实现分析

| 代理 | 触发阈值 | 策略 | 创新点 | 弱点 |
|------|---------|------|--------|------|
| Claude Code | 95% | LLM 摘要 | CLAUDE.md 控制 | buffer 问题 |
| Aider | 可配 token 预算 | 递归 head-tail + repo map | PageRank 动态预算 | 无 recall |
| OpenCode | usable tokens 计算 | prune tool outputs → LLM | 两阶段避免不必要 LLM | 无安全保证 |
| Cline | 接近限制 | condense + /newtask | 可视化进度条 | 大文件溢出 |
| OpenHands | 可配 max_size | 非破坏性 event condensation | 可逆压缩 | 仅限其架构 |

### 共同弱点
- 全部被动策略（到阈值才压缩）
- 无人解决"单次大响应溢出"问题
- 无人有结构性安全保证

---

## OS 内存管理可迁移算法

| 概念 | 算法 | LLM 适配 |
|------|------|---------|
| PSI 压力阶梯 | 60/75/85/95% 分级响应 | 测量压缩频率，不只看利用率 |
| 工作集 (Denning) | 追踪活跃引用段 | 工作集 > 窗口 → 任务分解 |
| LRU-2 | 区分读一次 vs 反复引用 | 一次性 tool_result 优先驱逐 |
| 反抖动 | 驱逐后 K 轮内 recall → 增加粘性 | 防止压缩→回忆→再压缩 |
| COW | 子代理传 manifest 不传全文 | 按需 fault-in |

---

## 隐含前提风险（反证 scout）

| 假设 | 风险 | 应对 |
|------|------|------|
| A14: 模型能检测何时需要 recall | HIGH | 用结构性锚点 + 主动预注入绕过 |
| A4: 摘要保留足够信息 | HIGH | 锚点保证关键信息一行引用永存 |
| A8: Provider 可统一抽象 | MEDIUM-HIGH | 不做统一抽象，用策略模式 |
| A9: 小窗口上开销可忽略 | HIGH (8K-32K) | 自动降级为 checkpoint-resume |
| A11: 对话有时间局部性 | MEDIUM | 锚点不依赖局部性 |
