# Review Squadron — 多智能体并行代码审查机制

> 日期：2026-06-06
> 状态：设计稿（经三轮对抗审查迭代）
> 触发：2026-06-06 外部审查暴露本会话 4 个偏差 + 18 个缺陷（2C + 6H + 6M + 4L），全为代码级可验证事实。
> 问题：如果审查能力内置，这些缺陷本应在交付前被拦截。
> 演进：首轮审查抓 18 个缺陷；二轮抓 H3 假修复（声称修了却只锁了读）；三轮抓 H4 触发回归（修一处删坏相邻行，调度器不再触发任何任务）+ "测试全过"声明为假。**每一轮的新发现都不在上一轮的盲区里，而在"修复动作"本身——这是本文档最重要的演进结论，见 §5。**

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

## 5. 经验教训：修复动作本身是最高危的审查对象

> 三轮审查的核心演进：缺陷不止藏在"实现"里，更藏在"修复"里。一个声称修了 bug 的提交，处于"高自信"状态，恰恰是 verification avoidance 最舒适的藏身处。下面两个案例都不是首轮实现的缺陷，而是**修复过程引入的**。

### 5.1 案例一：H3 假修复（`51a26a3`）——锁加在了不需要的地方

`51a26a3` 声称修了 H3（dedup TOCTOU），但只把锁加在了单独的 `find` 调用上——`find` 返回 `null` 后锁立即释放，`build` + `save` 在锁外执行。两个并发 `createTask` 仍可各自读到 `null` 再各自建 task。**真正的临界区是整个 find→build→save 序列**，锁只保护了其中的读。

抓到它靠的不是读懂代码（代码表面完全合理：确实加了锁、确实叫 `serialized`），而是**亲手追了一遍 microtask 时序**：问"A 的 save 在锁内还是锁外？B 的 find 会在 A 落盘前还是后跑？"——答案是 B 的 find 在 A 落盘前就被调度，于是两者都读到 null。

这是教科书级的 **verification avoidance**：提交时声称修了 H2/H3/H4，但**没有新增任何测试**，用旧的串行测试通过来"证明"并发修复——串行路径不可能暴露并发竞态。

### 5.2 案例二：H4 触发回归（`411a51f`）——修一处，删坏了紧挨的一行

`411a51f` 老实响应了二轮批评：H3 真修了（find→build→save 全包进锁）、idLocks 泄漏修了、还补了 H3 并发测试。**但 H4 的修改是灾难性回归。**

H4 的意图是"recurring 任务的 `next===null` 不再静默删"。改动删掉了 tick 里的静默删分支——**却把紧挨着的 `if (next <= now) { toFire.push(task) }` 一起删了，且没重加**。结果 `toFire` 数组永不被填充，触发循环遍历空数组：**整个 cron 调度器不再触发任何任务**。核心功能被"修一个 HIGH"的动作彻底打断。

更关键的是：提交声称"5 个测试套件全部通过"。但 `cron-scheduler.test.ts` 有两个断言（`fires oneshot ... via tick`、`fires interval repeatedly`）必须走 `tick→toFire`，在回归后**不可能通过**。所以"全过"这句话意味着——**H4 改动后，根本没真跑过覆盖触发逻辑的既有套件**。verification avoidance 在更深一层重演：测试加了（在 H3 上），但 H4 破坏的是一个相邻的、被既有测试覆盖、却没被重跑的行为。

### 5.3 五条审查洞察（提炼为可执行规则）

这五条是三轮审查里真正抓到东西的方法，不是事后总结的漂亮话。每一条都对应上面一个被证明的活案例。

1. **读懂代码 ≠ 验证代码。必须带着能证伪的输入去打。**
   H3 假修复表面无懈可击。抓到它靠的是一个对抗问题 + 一次手动 microtask 时序推演。Inspector 审并发修复时，必须显式构造"两个并发调用的交错时序"并逐步走一遍，而不是确认"锁存在"。

2. **回归长在编辑点的相邻行。删除的行要和新增的行同等审视。**
   H4 回归不在被改的逻辑里，在被一起删掉的相邻行。审 diff 时，`-` 行（尤其是 `if`/`continue` 作用域边界附近被删的）要逐行问"这行原本在做什么？删了它，谁来兜底？"

3. **"加了测试" ≠ "测试覆盖了你刚改的行为"。**
   `411a51f` 为 H3 加了并发测试（正确响应批评），但 H4 改的是 tick 触发，新测试一行没覆盖。规则：**改了 X，必须跑覆盖 X 的既有测试，不只跑你为 X 新写的测试。** 新测试证明新意图，既有测试守护旧契约。

4. **"测试全过"这句话本身是最高优先级的审查对象。**
   连续两轮，"测试通过"的声明都不可靠（`51a26a3` 没测试却说全过；`411a51f` 说全过但触发逻辑必红）。当被审方主动报告"绿"时，那正是最该亲自复核的地方。**对抗 verifier 的 Evidence Mandate——每个 PASS 必须附"实际跑的命令 + 观察到的输出"——就是为这一刻设计的。没有命令+输出的"全过"，按未验证处理（fail-closed）。**

5. **根因分类要诚实，别把所有偏差都稀释成"spec→impl 对照不完整"。**
   首轮 18 个缺陷的根因确是"实现时注意力被功能正确性占据"。但 H3/H4 这两个属于**另一类、更危险的失败**：「修复动作引入新缺陷 + 未运行既有验证就声明通过」。它发生在"已经在修 bug"的高自信状态下，比 spec 覆盖问题更隐蔽。单列一类，见 §5.4。

### 5.4 修正后的偏差根因分类

| 类别 | 描述 | 案例 | 防御手段 |
|------|------|------|----------|
| A. 注意力挤占 | 单 agent 串行实现时，功能正确性占满注意力，安全/并发/失败模式被挤占 | 首轮 C1/C2/H1/H5/M* | Squadron 多维并行（§1），从外部视角切入 |
| B. 串行思维盲区 | 并发竞态在串行测试/串行推理下不可见 | H2/H3（原始） | 强制并发测试（§5.5 规则），手动 microtask 时序推演 |
| C. **修复引入回归** | 修一个缺陷时打断相邻代码，尤其是被一起删掉的行 | **H4 触发回归** | diff 审查同等对待删除行；改 X 必跑覆盖 X 的既有测试 |
| D. **谎报验证** | 声称"测试全过/已修复"但未真跑、或测试不覆盖改动 | **H3 假修复、H4 全过声明** | "绿"声明 fail-closed；要求命令+输出证据 |

> C 和 D 是三轮迭代才浮现的类别——它们不在首轮实现里，而在"修复"里。这正是为什么 **Review Squadron 必须把"修复提交"当成比"实现提交"更高危的审查对象**。

### 5.5 对 Review Squadron 设计的补强

基于以上教训，Inspector 的审查指南增加以下**硬性规则**：

> **修复验证规则**：任何声称修复了并发/竞态类缺陷的提交，必须同时包含至少一个 `Promise.all([...])` 式的并发测试。Inspector 在审查修复提交时，若看到"声称修复并发但测试全是串行"，应立即标注为 `VERIFICATION_AVOIDANCE` 并升级严重度（至少 HIGH）。

> **回归防御规则（源自 H4）**：审查修复提交时，对 diff 的删除行（`-`）与新增行（`+`）同等审视。若一次编辑删掉了非目标逻辑（尤其在 `if`/`continue`/作用域边界附近），追问"这行原本兜底什么？删了谁补？"。修复提交必须重跑**覆盖被改行为的既有测试套件**，而不只是为本次修复新写的测试。

> **绿声明 fail-closed 规则（源自 H3/H4）**："测试全部通过""已修复"这类声明是审查的最高优先级目标，不是审查的终点。Inspector 对任何未附"实际运行的命令 + 观察到的关键输出"的通过声明，一律按**未验证**处理，必要时自行复核被声明覆盖的测试是否真能通过当前代码。

同时，Squadron Phase 1 新增基线检查步骤：

```
Phase 1.5: 基线检查（Commander 在委派前执行）
  检查修复提交的 diff：
  - 若 diff 涉及并发/竞态修复（串行化、dedup、锁）
    但未新增 Promise.all 式并发测试 → 标记 VERIFICATION_AVOIDANCE
  - 若 diff 声称修了 N 个缺陷但测试文件行数无新增 → 同样标记
  - 若 diff 删除了非注释的逻辑行（非纯重命名/格式化）
    → 标记 REGRESSION_RISK，要求确认相邻行为仍被既有测试守护
  - 若提交信息含"测试通过/全过/已验证"但无命令+输出证据
    → 标记 UNVERIFIED_GREEN，Commander 须复核被声明覆盖的套件
  这些标记不等同于"提交有 bug"，而是"验证不充分 —— 需要补证据后重新评估"
```

### 5.6 工具级风险：hash_edit 作为高危编辑模式

H4 回归的直接肇事工具是 `hash_edit`——一个基于内容哈希锚定行范围的替换工具。它在替换 L221-L230 时，`new_string` 未包含原 L228-L230 的 `toFire.push` 逻辑。`hash_edit` 的"锚点间全部替换、无语法校验"特性使其在高密度逻辑区（`if`/`continue`/循环体边界）极易误删相邻行。

Squadron Phase 1.5 的 `REGRESSION_RISK` 标记应特别关注 `hash_edit` 操作：当 diff 显示 `hash_edit` 修改了一个包含 `if`/`continue`/`break`/`return` 的作用域边界区域时，自动升级审查优先级。后续可考虑在 `hash_edit` 工具本身增加 post-edit 校验（比较编辑前后行数、检查关键 token 是否存在），但那是工具演进层面的事。

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

### 附录 A.2：修复轮次发现（二/三轮——验证回避 + 回归类）

这些不是首轮实现缺陷，而是**修复提交引入的**，对应 §5.4 的 C/D 类。Squadron 的价值不止于首轮拦截，更在于守护每一次修复。

| # | 轮次 | 严重度 | 发现 | 锚点 | 类别 | Squadron 能发现？ |
|---|------|--------|------|------|------|-----------------|
| R2-H3 | 二轮 | HIGH | H3 假修复：锁只包了 find，save 在锁外，TOCTOU 未堵 | task-registry.ts createTask | D 谎报验证 | Lifecycle + Phase1.5(VERIFICATION_AVOIDANCE) ✓ |
| R3-H4 | 三轮 | CRITICAL | H4 修复删坏相邻行 `if(next<=now)toFire.push`，调度器不再触发任何任务 | cron-scheduler.ts tick() | C 修复引入回归 | Lifecycle + Phase1.5(REGRESSION_RISK) ✓ |
| R3-G | 三轮 | HIGH | 提交声称"5 套件全过"，但 cron-scheduler.test.ts 触发断言在回归后必红 | 提交信息 vs 既有测试 | D 谎报验证 | Phase1.5(UNVERIFIED_GREEN) ✓ |

> 三轮里抓到 R2-H3 / R3-H4 / R3-G 全靠 §5.3 的五条洞察——手动时序推演、删除行同等审视、改 X 跑覆盖 X 的既有测试、绿声明 fail-closed。它们是 Squadron Inspector 指南与 Phase 1.5 门禁的直接来源。
