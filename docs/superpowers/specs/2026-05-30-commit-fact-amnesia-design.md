# 提交事实失忆链路 深度头脑风暴结果

## 背景

### 用户需求（原文意图）
事故链：agent 提交了代码 → **用户看不到提交的标签号，没法拿来审查** → 用户事后追问标签 → agent 已压缩失忆、**混乱忘记自己提交了什么** → 去裸查工作区 → 看到别人未提交的、优化过的文件 → 误判"值得提交" → 连同别人的代码一起提交。上一轮已补 git 三件套补丁，本轮要查这条链路**打补丁后还有没有缺陷**，包括压缩上下文之后，以及 **200k 与 1m 窗口的区别**。

### 项目上下文
rivet 多会话 AI agent 系统。7-8 个会话协同：write-capable worker 跑在隔离 git worktree，primary 会话共享 cwd。已有 git 三件套（`stash_pop` guard、commit 回读 `--stat`、`bashGitBypassesScope`）作为提交动作末端兜底。

### 调研发现摘要（7 scout + 1 反证）
- **Scout1/7（压缩+持久化）：** commit 事实（hash/标签/文件）**只活在 tool_result 会话消息里**；`claim-extractor.ts` 无 commit→claim 分支（grep 零命中）；TaskLedger 的 git_action 只存截断命令串、无 hash/标签、且不进 prompt。压缩后**必丢**，agent 无结构化回忆通道。
- **Scout6（回答路径）：** 用户追问"已发生事实"时无任何"先查账本再回答"机制；`recentToolHistory` 硬上限 5 条、bash target 截断 50 字符；verify-first 护栏只覆盖"写代码前"，不覆盖"回答事实前"。
- **Scout3（归属）：** `505533e` 引入的 `autoOwnFromBaseline`（`ownership-ledger.ts:75-84`）把 baseline 外 dirty 文件**无论谁改的**都收 owned；三件套的 `--only` 反而**精确提交**这个误判文件。
- **Scout2（展示）：** `git.ts:146` 的 `git show --stat --format=`（空 format）**抹掉了 commit hash**；UI 折叠 tail 15 行又截断顶部 hash。**这是用户"看不到标签号"的直接成因。**
- **Scout4（窗口）：** 窗口大小是阈值乘数，**只调频率不改机制**；1M 压缩晚但单次 session-split 整体塌缩（几十万 token→2048 摘要），单次丢失规模远大于 200k 的频繁小切。
- **Scout5（外部领域）：** WAL / Event Sourcing / MemGPT pinned core memory / 手术 Sign-Out 读回 —— 共同原理：**关键事实写进决策点强制可见的不可变外部记录，不信任工作记忆**。
- **Scout8（反证）：** 推翻"失忆为主因"——用户痛点直接成因是**展示 bug（两行可修）**；recall 是**冗余路径**（真机制是 active-claim 自动注入）；autoOwnFromBaseline 误判**低频**（worker 隔离 worktree）；claim 受 TTL+50 上限约束，要持久必须 `decision` kind+durable。

---

## 三轮思考过程

### 合成假设（Step 0.4）
七 scout 交叉：「三件套堵的是'提交动作范围'，但根因是'归属集合算错'+'事实不持久化'。」→ **被反证部分推翻**：用户最痛是展示 bug，归属误判低频，recall 冗余。

### 第一轮：变异
- **V1（主流·展示）：** `git.ts:146` `--format=` → `--format=%h%d`，hash/标签进 content 首行，避开 UI tail 折叠。治"看不到标签号"。
- **V2（邻近·持久化）：** commit 后 propose `kind:'decision'`(TTL∞)+durable 的 commit-fact claim，靠现有 `<active-claims>` 自动注入，失忆 agent 不需 recall 也能看见。治"追问混乱"。
- **V3（空位·归属）：** `autoOwnFromBaseline` 加第二维度（仅 ledger 有 file_write 痕迹才自动 own），否则退回 YELLOW。治"误提交他人文件"。
- **V4（突变·回答前核实）：** 追问已发生事实时强制先查 git log/claim 再答 —— **已灭绝**。

### 第二轮：选择
- **灭绝 V4** —— 改主链路 perceive/intent 成本最高，可能误伤正常回答，且 V2 自动注入已让 agent 被动看见事实（反证证明主动 recall/核实是冗余）。
- **存活 V1（最强）** —— 直击用户最痛症状，2 行，可逆，因果链最硬。
- **存活 V2（中·需正确设计）** —— 必须 `decision`+durable+自动注入，**不靠 recall**；对 1M 窗口收益更大。
- **存活 V3（中低·低频）** —— 恢复 `505533e` 删掉的安全信号。
- **discarded_trait 回收：** V4 的"回答前核实"护栏降级吸收进 V2 —— commit-fact claim 写成祈使句式事实陈述，自动注入即"持续在 agent 眼前重述事实"（= Scout5 的 closed-loop read-back）。

### 第三轮：适应
- **套路清除：** "上下文丢失→必建持久记忆层+教 agent recall" 是 agent-memory 行业套路；反证证明用户最痛是展示 bug，且 recall 是伪解法（真机制是自动注入）。
- **扩展适应：** 复用已存在的 `<active-claims>` 自动注入（`claims.ts:184`→`volatile.ts:330`）作为"提交事实持续在场"载体，零新基础设施。
- **收敛验证：** V1（当场回执）、V2（每轮 active-claims）、Scout5（WAL/Sign-Out）收敛到**核心真相**：提交事实必须写进 agent 决策点强制可见的不可变外部记录，不信任工作记忆。

---

## 最终方案（分层，按用户症状痛感排序）

| 层 | 治哪个症状 | 动作 | 文件:行号 | 成本 |
|---|---|---|---|---|
| **A（展示）** | "看不到标签号" | `git show --stat --format=` → `--format=%h%d`；hash 进 content 首行；deliver_task 路径同步 | `src/tools/git.ts:146`、`src/agent/scoped-git-commit.ts` | 极低（2-3 行） |
| **B（持久化）** | "追问时混乱失忆" | commit 后 propose `kind:'decision'`(TTL∞)+durable claim；git 工具经 ToolCallParams 拿 store 引用；靠 `<active-claims>` 自动注入（**非 recall**） | `src/context/claim-extractor.ts:30`(加 commit 分支)、`src/tools/git.ts:150` | 中 |
| **C（归属）** | "误提交他人文件" | `autoOwnFromBaseline` 加 ledger 痕迹第二维度；无痕迹的 baseline 外 dirty 退回 YELLOW | `src/agent/ownership-ledger.ts:75-84` | 低（低频兜底） |

### 实施路径
- **Phase 1（A）：** 改 `--format=%h%d` + hash 进首行 + deliver_task 同步。成功标准：提交回执首行匹配 `/[0-9a-f]{7}.*\(S\d+\)/`。退出条件：`%d` 无 tag 时杂乱 → 退回纯 `%h`。
- **Phase 2（B）：** claim-extractor 加 commit 分支，`kind:'decision'`+durable。成功标准：模拟压缩后 prompt 仍含该 claim。退出条件：注入挤占过多 → 降级 TTL=24h + 每会话软上限。
- **Phase 3（C）：** autoOwnFromBaseline 加第二维度。成功标准：重放 baseline 外+无 ledger 痕迹 dirty → YELLOW 不自动 own。退出条件：YELLOW 过多 → 只对"明显属他会话"的文件警告。

---

## 风险与应对

- **最强适应点：** 三层同源于"提交事实写进决策点强制可见的外部记录"；B 复用已有 `<active-claims>` 自动注入（零新基础设施），A 是两行展示修复。
- **脆弱点 1（B）：** Infinity TTL 的 commit claim 累积过多挤占注入名额（前 20 条）→ 应对：`decision` kind + 每会话只留最近 N 条 commit-fact 软上限，或降级 TTL=24h。
- **脆弱点 2（C）：** baseline 单维度本就低频（worker 隔离 worktree），过度收紧反增摩擦 → 应对：只警告、不阻断。
- **窗口差异（200k vs 1m）：** 非独立根因，是频率调节器。但 1M 单次 session-split 塌缩规模大，**B 对大窗口模型（deepseek-v4-pro/mimo-v2.5-pro）收益更大**。

## 下一步
Phase 1 第一个动作：把 `src/tools/git.ts:146` 的 `git show --stat --format= HEAD` 改为带 `%h%d` 的格式，让 commit hash 和标签进入回执首行。
