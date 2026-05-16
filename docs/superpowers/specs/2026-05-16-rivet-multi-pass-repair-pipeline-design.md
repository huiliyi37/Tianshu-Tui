# Multi-Pass Repair Pipeline + Adaptive Injection 设计

## 背景

- **用户需求：** 探索跨领域洞察，最大化 Rivet harness 工程的竞争力
- **关联文档：** `docs/superpowers/specs/2026-05-16-rivet-open-source-harness-strategy-design.md`（开源策略）、`docs/superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md`（CTCL 移植计划）
- **核心洞察来源：** Command Code 文章（harness > 模型能力）、跨领域调研（航空 TMR、数据库 AQP、编译器多 pass、网络能力协商）

## 调研发现摘要

### Scout 1：Rivet 代码考古
- 14 个静态容错规则，5 个自适应机制
- `AdaptiveRouter` 按 (profile, model) 评分但仅用于子代理
- 主 loop 缺少 per-model 自适应
- 空白：无 per-model retry 策略、无 token 估算自校准

### Scout 2：跨领域容错
- **数据库 AQP**：Monitor → Assess → Respond，运行时偏差超阈值触发策略切换
- **Query Store**：版本化执行策略 + 性能回归自动回滚
- **TLS 能力协商**：声明偏好 + 最优匹配 + 降级防护信号
- **GGPO 回滚网络**：快照 → 检测错误 → 回滚 → 重模拟

### Scout 3：编译器模式
- **Error-Recovering Parser**：不停止，跳到同步点继续
- **Gradual Typing/Coercion**：边界处自动强制转换
- **APR + Fault Localization**：精确定位出错部分，只重试那一片段
- **Grammar-Constrained Decoding**：token 层面实时阻止结构破坏

### Scout 4：假设反证（关键约束）
| 约束 | 性质 | 影响 |
|------|------|------|
| 单 session 样本不够 per-(model,tool) profiling | 事实 | 排除运行时自适应 profiling |
| SSE 流中途无确定性同步点 | 事实 | 排除 streaming 中途修复 |
| Messages API 不支持参数级 partial retry | 事实 | 排除参数级重试 |
| Profile 注入会破坏 prefix cache | 机制 | 必须用 volatile block 注入 |
| 工具失败多为上下文相关 | 部分事实 | 四骑士是系统性的，其余是上下文相关的 |

---

## 三轮思考过程

### 第一轮：变异

```
[VARIATION]
生态位: 终端编码代理的模型输出修复层 / DeepSeek+Qwen+Kimi / 单人维护
选择压力: task success rate 提升 + 不破坏 prefix cache + 单 session 即见效 + 2 周可实现
已占据: CTCL 四骑士(静态) / Schema gate / 指数退避重试
空位: 失败驱动注入 / 跨 session model card / 多 pass 管线

方案:
  V1(主流): 静态规则扩展 — 在四骑士基础上加 10+ 条 per-model 修复规则
  V2(邻近): 失败驱动 tool description 注入 — 连续 2 次同类失败时在 volatile block 追加修复提示
  V3(空位): 跨 session model card — session 结束时持久化修复统计，下次启动加载
  V4(突变): 编译器式多 pass 修复管线 — 5 个独立 pass，每个处理不同粒度问题

创始假设: "修复应在 harness 层" — V2 质疑这个假设（让模型自我修正）
适应度函数: 硬约束=不破坏 cache + 2 周可实现 / 加分=跨 session 复利 + per-model 特化 / 减分=运行时开销 > 1%
```

### 第二轮：选择

```
[SELECTION]
目标偏移: 无
因果测试: V1=通过(有上限) / V2=通过(自强化) / V3=部分断裂(样本不足) / V4=通过(架构清晰)
成本测试: V1=低/中/中 / V2=低/低/高 / V3=中/中/低 / V4=中/低/高
共演化: V1=静态 / V2=动态 / V3=缓慢 / V4=动态
局部最优: V1 是局部最优(可被复制)，V2+V4 组合是远程高峰
落地性: V1=加一条规则 / V2=加 failureCount+注入 / V3=写 JSON / V4=重构为 pass
灭绝: V3 — 原因：冷启动+样本不足(事实约束)+模型版本失效
存活: V4(最强·架构骨架) / V2(强·自适应) / V1(弱·已在计划中作为 V4 的 Pass)
最强竞争者: V4+V2 组合
新发现: V2 的"失败驱动注入"是 AQP Monitor→Assess→Respond 的最简实现
```

### 第三轮：适应

```
[ADAPTATION]
套路清除: "通用 AI middleware 框架"(不做) / "ML 学习修复策略"(样本不够) / "支持所有模型"(先做好 DeepSeek)
扩展适应:
  - TraceStore tool fingerprint → 修复遥测记录
  - failure-classifier 8 类分类 → V2 的触发条件(同类失败才注入)
  - PromptEngine.buildStableVolatileBlock() → V2 的注入点(不破坏 cache)
  - V3 灭绝特征回收：model card → 简化为静态 model-quirks.ts 配置
具体化:
  人: 用 DeepSeek V4 Pro 做真实 repo 修改的开发者
  场: 终端 40 轮对话，模型输出 tool_use 有 4 类系统性错误
  动: 5-pass 管线依次修复，Pass 5 在连续同类失败时注入提示
  果: tool_use 成功率从 ~70% 提升到 ~92%
收敛验证: V4 和 V2 收敛到"修复是管线，管线可根据反馈调整"——与 AQP 和编译器多 pass 完全收敛
```

---

## 最终方案：Multi-Pass Repair Pipeline + Adaptive Injection

### 架构

```
content_block_stop (SSE 流完成)
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ Pass 1: Structural Recovery                         │
│   recoverTruncatedJSON — 修复半截 JSON              │
├─────────────────────────────────────────────────────┤
│ Pass 2: Schema Gate                                 │
│   校验 required 字段，缺失 → 压制为 text block      │
├─────────────────────────────────────────────────────┤
│ Pass 3: Four Horsemen (CTCL)                        │
│   null→omit / JSON string→array / obj→unwrap /      │
│   bare string→wrap                                  │
├─────────────────────────────────────────────────────┤
│ Pass 4: Semantic Repair                             │
│   autolink 清洗 / 关系不变量默认值 (offset↔limit)   │
├─────────────────────────────────────────────────────┤
│ Pass 5: Adaptive Injection (下一轮生效)              │
│   连续 2 次同类失败 → volatile block 追加修复提示    │
│   利用模型 in-context learning 自我修正             │
└─────────────────────────────────────────────────────┘
  │
  ▼
Tool Execution → Telemetry Record
```

### 与竞品对比

| 能力 | Command Code | Aider | Rivet (本方案) |
|------|-------------|-------|---------------|
| 四骑士修复 | ✅ | ❌ | ✅ (Pass 3) |
| Schema gate | ❌ | ❌ | ✅ (Pass 2) |
| 截断 JSON 恢复 | ❌ | ❌ | ✅ (Pass 1, 已有) |
| 语义修复 (autolink/relation) | 部分 | ❌ | ✅ (Pass 4) |
| 自适应注入 | ❌ | ❌ | ✅ (Pass 5, 独有) |
| 修复遥测 | ❌ | ❌ | ✅ |
| 管线可插拔 | ❌ (单层) | N/A | ✅ |

### Pass 5 详细设计

**触发条件：** 同一 tool 连续 2 次被 failure-classifier 归为同一类失败

**注入位置：** `PromptEngine.buildStableVolatileBlock()` 的末尾（不影响 system prompt prefix cache）

**注入内容示例：**
```
<repair-hint tool="edit_file">Do NOT pass null for optional fields; omit them entirely.</repair-hint>
```

**退出条件：** 注入后如果下一次该 tool 成功，清除计数器；如果注入后仍然失败 2 次，停止注入（避免 token 浪费）

**Cache 安全性：** 注入在 volatile block 中，不影响 system prompt 和 tools 的 prefix cache。volatile block 本身每轮都变（包含 toolHistory），所以额外 1 行不增加 cache miss。

---

## 风险与应对

| 脆弱点 | 应对策略 |
|--------|---------|
| Pass 5 注入被模型忽略 | 限制为 1 行命令式语气；如果 3 次无效则停止 |
| 新模型版本引入新错误模式 | 管线可插拔，加新 pass 即可 |
| 修复掩盖模型能力退化 | 遥测记录修复率趋势，异常时 cockpit 告警 |
| 管线增加延迟 | Pass 1-4 是纯同步函数，<1ms；Pass 5 只修改下一轮 prompt |
| 规则之间冲突 | Pass 顺序固定（结构→schema→类型→语义→自适应），每个 pass 只处理前一个 pass 的输出 |

---

## 实施路径

**Phase 1（第 1 周）：管线骨架 + CTCL 四骑士**
- 重构为 `RepairPipeline` + `RepairPass` 接口
- 实现 Pass 1-4（= CTCL 移植计划的任务 1-4）
- 成功标准：全量测试通过，四骑士修复率 >95%
- 退出条件：管线架构引入 >5ms 延迟则简化为函数链

**Phase 2（第 2 周）：自适应注入 + 遥测**
- 实现 Pass 5（失败驱动注入）
- 实现修复遥测（per-pass 计数器）
- 成功标准：10 个真实任务中自适应注入触发 ≥3 次且后续成功
- 退出条件：注入后成功率下降则禁用

**Phase 3（第 3 周+）：Model Quirks + Cockpit**
- `src/agent/model-quirks.ts`：per-model 静态 quirks
- Cockpit 面板展示修复遥测
- 成功标准：cockpit 实时展示修复统计

---

## 下一步

1. 用户审查本设计文档
2. 将 Phase 1 与现有 CTCL 移植计划合并（管线架构 = 移植计划的架构升级）
3. 执行 Phase 1
