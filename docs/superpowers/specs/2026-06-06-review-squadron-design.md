# Review Squadron — 多智能体并行代码审查机制

> 日期：2026-06-06
> 状态：设计稿
> 触发：2026-06-06 外部审查暴露本会话 4 个偏差 + 18 个缺陷（2C + 6H + 6M + 4L），全为代码级可验证事实。
> 问题：如果审查能力内置，这些缺陷本应在交付前被拦截。

---

## 0. 背景：一次高质量外部审查的解剖

2026-06-06 会话实现了 Spec A（对抗式 Verifier + Cron 租约锁）和 Spec B（TaskRegistry + 审计 + 通知）的全部代码。随后收到一份外部审查报告，覆盖 22 个问题，按严重度分四档：

```
CRITICAL (2): C1 server 绑 0.0.0.0, C2 auth fail-open
HIGH     (6): H1 allowedTools 丢失, H2 transition 竞态, H3 dedup TOCTOU,
              H4 cron 静默删, H5 目录不存在丢数据, H6 SSE 无断连检测
MEDIUM   (6): M1 tick 重入, M2 seq 不持久, M3 空 tools 反转, M4 JSON 无校验,
              M5 全系统吞错, M6 /status/abort 零鉴权
LOW      (4): L1 id 无校验, L2 手搓 timingSafeEqual, L3 in-place 变异,
              L4 方括号绕私有
```

### 审查方法论分析

审查者使用了**主从并行**模式：

| 角色 | 职责 | 审查的文件 |
|------|------|-----------|
| 主控 | 通读所有文件、交叉验证 spec 承诺 vs 代码实现、逐文件标注缺陷 | 全部 10 个文件 |
| lifecycle agent | 专查 task-registry 的生命周期正确性（状态机、竞态、序列化） | task-registry.ts |
| cron agent | 专查 cron-scheduler 的时间触发正确性（解析器、持久化、触发语义） | cron-scheduler.ts |
| （推测）security agent | 专查认证、授权、网络暴露面 | index.ts, task-routes.ts |

### 审查输出特征

每个发现都包含四个要素：
1. **严重度标签** + 简短结论（如 `H2 — transition 非原子,丢更新 + 违反优先级裁定`）
2. **代码锚点**：`task-registry.ts:154-182`（精确到行号）
3. **根因解释**：为何这是问题、在什么条件下触发
4. **修复建议**：一行描述最小修法

### 为什么这批缺陷在交付前没被拦截

 | 缺陷 | 如果你自己做审查，你能发现吗？ |
|------|-------------------------------|
| C1 bind 0.0.0.0 | ✅ 能 —— 读 index.ts 一眼可见，但当时注意力在功能实现上 |
| C2 auth fail-open | ✅ 能 —— 读 checkAuth 逻辑时可见，但编写时"无 token 则开放"曾是便利设计选择 |
| H1 allowedTools 丢失 | ⚠️ 部分 —— 意识到传了 allowedTools 但没追到 execute 签名 |
| H2 transition 竞态 | ❌ 难 —— 需要并发思维模型，串行测试不暴露 |
| H3 dedup TOCTOU | ❌ 难 —— 同 H2，串行思维下的盲区 |
| H4 cron 静默删 | ⚠️ 部分 —— 知道 nextCronTime 只支持简单格式，但没追溯到 tick 里的删除路径 |
| H5 目录不存在 | ⚠️ 部分 —— 测试通过了所以没注意，实际是因为 test-tmp 已存在 |
| M1-M6 | ⚠️ 分散 —— 每个单独看都可能注意到，但实现时注意力被功能正确性占据 |

**核心根因**：单一 agent 串行实现时，"功能正确性"占据了全部注意力，"安全边界""并发正确性""失败模式"三类关注面被挤占。审查者从外部视角切入，不受实现者的注意力分配影响。

---

## 1. Review Squadron 设计

### 1.1 核心概念

**Review Squadron** = 一个主控（Commander）+ 3~5 个专精审查者（Inspector），并行审查一批代码变更。

```
                     ┌─────────────────┐
                     │    Commander    │
                     │   (主控审查)     │
                     │ 通读全量 + 交叉   │
                     │ 验证 spec 承诺    │
                     └───────┬─────────┘
                             │ 委派
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
   │  Security   │   │  Lifecycle  │   │  Data Flow  │
   │  Inspector  │   │  Inspector  │   │  Inspector  │
   │             │   │             │   │             │
   │ 认证/授权   │   │ 状态机/竞态 │   │ 参数传递链  │
   │ 网络暴露面 │   │ 序列化/原子性│   │ 工具白名单  │
   │ 输入校验   │   │ 超时/取消   │   │ 持久化完整性│
   └─────────────┘   └─────────────┘   └─────────────┘
```

### 1.2 角色定义

**Commander（主控）**
- 读取所有变更文件的 diff
- 读取关联的 spec/设计文档
- 验证 spec 中的承诺在代码中是否全部兑现（"spec→code 一致性"）
- 委派 Inspector 到专项审查维度
- 汇总所有发现，去重，按严重度分级
- 输出结构化审查报告

**Security Inspector（安全审查者）**
- 审查维度：认证机制（fail-open/fail-closed）、授权粒度、网络绑定（0.0.0.0 vs 127.0.0.1）、输入校验、路径遍历、敏感信息泄漏
- 检查模式：`grep` 搜索 `listen(`、`checkAuth`、`extractToken`、`authorization`、`..`、`ENOENT`
- 输出：安全发现列表，带严重度

**Lifecycle Inspector（生命周期审查者）**
- 审查维度：状态机转换规则的正确性和完整性、并发竞态（check-then-act、load-check-save）、序列化/原子性、取消/超时传播
- 检查模式：`grep` 搜索 `transition`、`createTask`、`AbortController`、`setTimeout`、`setInterval`
- 输出：并发/状态机发现列表

**Data Flow Inspector（数据流审查者）**
- 审查维度：参数从入口到执行点的完整传递链、工具白名单是否在传递中丢失、持久化路径的完整性（目录存在性、原子写）
- 检查模式：trace 函数签名链 → 调用处，检查每层是否有字段丢失
- 输出：数据流断裂发现列表

**Silence Inspector（静默吞错审查者）**
- 审查维度：所有 `catch {}` / `.catch(() => {})` 空块、错误是否被正确传播或日志记录
- 检查模式：`grep` 搜索 `catch\s*\{`、`catch\s*\(\s*\)`、`.catch(() => {})`
- 输出：静默吞错位置列表

### 1.3 审查流程

```
Phase 1: 集结
  Commander 读取变更文件列表 + diff
  Commander 读取关联 spec 文档
  Commander 提取 spec 中的显式承诺清单（路由列表、接口签名、状态转换规则）

Phase 2: 委派（并行）
  Commander → delegate_batch(4 个 Inspector, policy: all_required)
  每个 Inspector 收到：变更文件列表 + 专精审查指南

Phase 3: 汇总
  Commander 收拢所有发现
  去重（同一代码位置的不同维度发现合并）
  按严重度分级：CRITICAL（安全/数据丢失）> HIGH（正确性）> MEDIUM（鲁棒性）> LOW（代码质量）

Phase 4: 输出
  结构化报告：每个发现 = 严重度 + 锚点（file:line） + 根因 + 修法
  输出到 docs/reviews/YYYY-MM-DD-{topic}.md
```

### 1.4 Inspector Prompt 模板

**Security Inspector**:
```
你是安全审查者。审查以下文件的安全属性：
- 认证：是否 fail-closed？token 从哪里读（header? body?）？
- 网络：server.listen 是否 bind 了具体地址？
- 输入：路径参数是否有校验？是否有路径遍历风险？
- 敏感信息：是否有 token/key 泄漏到日志/响应？

对每个发现，给出：严重度 + file:line + 问题描述 + 修复建议。
如果没发现问题，明确声明"安全审查通过"。
```

**Lifecycle Inspector**:
```
你是生命周期审查者。审查以下文件的状态机和并发属性：
- 状态转换：是否有缺失的转换？优先级规则是否正确？
- 并发：所有 load-check-save 序列是否原子？check-then-act 是否有 TOCTOU？
- 取消/超时：AbortController 是否正确传播？超时是否覆盖所有路径？

对每个发现，给出：严重度 + file:line + 问题描述 + 修复建议。
```

### 1.5 触发条件

Review Squadron 应在以下时机启动：
1. **交付前门禁**：任何超过 3 个文件的变更，在提交前自动触发
2. **新子系统上线**：任何新增 `src/**/` 目录 + 超过 200 行代码
3. **手动触发**：用户说 "review" / "审查" / "检查一下代码"

---

## 2. 与现有 delegate 系统的关系

Review Squadron **复用**现有 `delegate_batch` + `delegate_task` 基础设施：

| Review Squadron 概念 | 现有系统映射 |
|---------------------|-------------|
| Commander | 主 agent 会话 |
| Inspector | `delegate_task(profile: 'reviewer')` |
| 并行审查 | `delegate_batch(policy: 'all_required')` |
| 审查维度 | work-order 的 `objective` 字段（含专精指南） |
| 发现汇总 | `aggregateResults(policy: 'primary_decides')` |

**关键差异**：现有 `reviewer` profile 是通用代码审查者，Review Squadron 需要**专项 Inspector**——但可以用同一个 `reviewer` profile + 不同的 `objective`（objective 中包含专精审查指南）来实现。不需要新增 profile。

---

## 3. 实施计划

### Phase 0: 文档化（本任务）
- [ ] 将本设计文档写入 `docs/superpowers/specs/`
- [ ] 将背景案例（本次审查的 22 个发现）写入 `docs/reviews/2026-06-06-server-subsystem-review.md`

### Phase 1: 工具化（后续）
- [ ] 实现 `review_squad` 工具：接收变更文件列表 + spec 文档路径 → 委派 4 路 Inspector → 汇总输出
- [ ] Inspector objective 模板化（安全/生命周期/数据流/静默吞错四个模板）
- [ ] 输出格式标准化（严重度 + 锚点 + 根因 + 修法）

### Phase 2: 集成（后续）
- [ ] 交付门禁集成：超过阈值自动触发
- [ ] CI 集成：PR 级别自动审查

---

## 4. 一句话总结

> **Review Squadron 是一套多智能体并行代码审查机制——一个主控通读全量 + 交叉验证 spec，四个专精审查者并行检查安全/生命周期/数据流/静默吞错四个维度。复用现有 delegate_batch 基础设施，通过 objective 注入专精指南实现维度分化，不需要新增 profile。**

---

## 5. 经验教训：H3 假修复与"验证回避"

### 5.1 事件回顾

2026-06-06 第二轮审查发现：`51a26a3` 声称修了 H3（dedup TOCTOU），但实际上只把锁加在了单独的 `find` 调用上——`find` 返回 `null` 后锁立即释放，`build` + `save` 在锁外执行，两个并发 `createTask` 仍然可以各自读到 `null` 再各自建 task。**真正的临界区是整个 find→build→save 序列**，锁只保护了其中的读。

这是教科书级的 **verification avoidance**：
- 提交 `51a26a3` 时声称修了 H2/H3/H4，但没有新增任何测试
- 用旧测试的通过来"验证"并发修复——旧测试全部是串行路径，不可能暴露并发竞态
- 这正是对抗 verifier prompt 里点名的 #1 失败模式：**"读了代码就盖 PASS，没用能暴露问题的输入去打它"**

### 5.2 对 Review Squadron 设计的补强

基于此教训，Inspector 的审查指南增加一条**硬性规则**：

> **修复验证规则**：任何声称修复了并发/竞态类缺陷的提交，必须同时包含至少一个 `Promise.all([...])` 式的并发测试。Inspector 在审查修复提交时，若看到"声称修复并发但测试全是串行"，应立即标注为 `VERIFICATION_AVOIDANCE` 并升级严重度（至少 HIGH）。

同时，Squadron Phase 1 新增基线检查步骤：

```
Phase 1.5: 基线检查（Commander 在委派前执行）
  检查修复提交的 diff：
  - 若 diff 涉及并发/竞态修复（串行化、dedup、锁）
    但未新增 Promise.all 式并发测试 → 标记 VERIFICATION_AVOIDANCE
  - 若 diff 声称修了 N 个缺陷但测试文件行数无新增 → 同样标记
  该标记不等同于"提交有 bug"，而是"验证不充分 —— 需要补测试后重新评估"
```

---

## 附录 A：本次外部审查发现的完整清单（作为测试用例）

用于验证 Review Squadron 实施后能否复现同样的发现。

| # | 严重度 | 发现 | 锚点 | Squadron 能发现？ |
|---|--------|------|------|-----------------|
| C1 | CRITICAL | server.listen 无 host → 绑 0.0.0.0 | index.ts:73 | Security ✓ |
| C2 | CRITICAL | auth fail-open + 只读 body token | task-routes.ts:28-29 | Security ✓ |
| H1 | HIGH | allowedTools 持久化但执行时丢失 | task-registry.ts:35,298 | DataFlow ✓ |
| H2 | HIGH | transition 非原子 | task-registry.ts:154-182 | Lifecycle ✓ |
| H3 | HIGH | dedup TOCTOU | task-registry.ts:113-134 | Lifecycle ✓ |
| H4 | HIGH | cron 解析器静默删 | cron-scheduler.ts:81-107 | Lifecycle ✓ |
| H5 | HIGH | .rivet/ 不存在丢数据 | cron-scheduler.ts:60-64 | DataFlow ✓ |
| H6 | HIGH | SSE 无断连检测 | prompt-route.ts:26-65 | Lifecycle ✓ |
| M1 | MEDIUM | tick 可重入 | cron-scheduler.ts:203-209 | Lifecycle ✓ |
| M2 | MEDIUM | seq 单调性不持久 | task-routes.ts:108-121 | DataFlow ✓ |
| M3 | MEDIUM | 空 allowedTools 反转 | cron-wiring.ts:60 | DataFlow ✓ |
| M4 | MEDIUM | JSON 损坏无校验 | cron-scheduler.ts:66-76 | DataFlow ✓ |
| M5 | MEDIUM | 全系统吞错 | 几乎所有文件 | Silence ✓ |
| M6 | MEDIUM | /status /abort 零鉴权 | routes.ts:14-23 | Security ✓ |
| L1 | LOW | task id 无校验 | task-store.ts | Security ✓ |
| L2 | LOW | 手搓 timingSafeEqual | task-routes.ts:35 | Security ✓ |
| L3 | LOW | in-place 变异 | cron-scheduler.ts:261 | DataFlow ✓ |
| L4 | LOW | 方括号绕私有 | cron-wiring.ts | DataFlow ✓ |
