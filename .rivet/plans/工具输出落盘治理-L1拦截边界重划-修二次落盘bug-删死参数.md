> **Status: COMPLETED** — 2026-06-19

# 工具输出落盘治理 — L1 拦截边界重划 + 修二次落盘 bug + 删死参数 + 陈旧度 compact

> 状态：设计已定稿，待执行 Phase 1
> 方法：deep-brainstorm 三轮（变异→选择→适应）+ 4 路 scout 外部/内部调研
> 日期：2026-06-18
> 触发：审查未提交工作单元里 `tool-pipeline.ts` 的 artifact 拦截改动（grep/glob/bash 引入 3x 阈值），评估效果并探查"能否做得更好、让 agent 高效使用"

---

## 一、背景：这次改动效果的实证评估

未提交改动对 `artifactIntercept`（L1 层）做了三件事：
1. `read_file`/`read_section` 完全豁免 L1（`tool-pipeline.ts:330`）——**正确**，有 2026-05-25 post-mortem 背书（L1 重复 wrap 会把每次 `read_section` 恢复变成 `[artifact:NEW_ID]→read_section(NEW_ID)→…` 无限嵌套）。
2. 其余 read 类工具（grep/glob/bash 只读）引入 `threshold = base*3 = 7500`（`tool-pipeline.ts:338-340`）。
3. worker 选定 model 写入会话 JSONL（`worker-session.ts`，与本议题无关）。

**关键发现：第 2 项基本是被自己架空的死参数。** 紧随 3x 的 `floor` 行（`tool-pipeline.ts:351-354`）`Math.max(threshold, getToolArtifactThreshold(tool, w))` 会把 7500 抬回到 L0 同款阈值：

| 窗口 | grep 的 3x 起步 | floor(=L0 阈值) | 最终阈值 | 3x 是否生效 |
|------|----------------|-----------------|---------|------------|
| 1M | 7,500 | 100,500 | 100,500（budget 后 301,500） | **否（死代码）** |
| 200K | 7,500 | 26,800 | 26,800 | **否** |
| 64K | 7,500 | 804→7,500 | 7,500 | 是（仅小窗口） |

commit message 宣称的"3x 保持 inline、拦截 >7.5K 病态结果"在 1M/200K 不成立——7.5K 这个界被 floor(75K–100K) 完全覆盖。`cacheAdvisor.getArtifactThreshold` 传入的 `thresholdOverride` 也被 3x 整段覆盖，对 read 工具失效。

---

## 二、4 路 scout 调研结论（交叉点）

**竞品（7 个终端 agent）**：截断（Codex/Aider）不可逆丢信息；落盘+引用+按需取回（Claude Code/opencode/Cline/Goose）更优；行业共识 = 50KB 单工具阈值 + 行/字节双闸门 + 保尾 + 截断标记；只有 Claude Code 真正兼顾 prefix cache（单层落盘+服务端删旧+append-only）。

**经济学**：缓存读普遍 ~10% 输入价，**DeepSeek 是异类 ~2%（命中省约 98%），且写缓存不收费**（无 Anthropic 回本门槛）。**context rot 普遍**——所有模型远未填满窗口就退化，有效预算常仅标称 1/4–1/10；**语义相似的旧内容是最毒的干扰项**（旧版文件、已完成步骤会主动误导模型）。检索/卸载不免费（选择误差、查表非记忆、安全退化）。

**内部审计**：落盘是 L0–L5 六层、阈值散落 4+ 文件；死参数：`find_files`/`search` 是 READ_TOOLS 死条目、3x 在 1M/200K 死、cacheAdvisor 对 read 工具被覆盖；疑似真 bug：L0 把 `[artifact:]` 放**末尾**，L1 用 `startsWith` 检测**开头**。

**反证（红队）**：**六层不可坍缩**——L4 管 JS 堆内存、L5 管前缀缓存经济学、L1 独占 `turnBudget`/`cacheAdvisor` 动态信号，互为正交维度。**"对标 Claude 50K 单层"前提不成立**——DeepSeek `exact-prefix + persistent` 缓存使本项目逻辑是"热缓存时更 inline、更晚 compact"（1M floor=150K 是有意偏离 Claude，不是疏漏）。**二次落盘是特定条件触发的真 bug**（见下）。

---

## 三、已确认的真 bug：grep/bash 大输出 L0+L1 二次落盘

**触发链（grep @ 1M 窗口）**：
1. L0：grep raw ≥ `getToolArtifactThreshold('grep')` ≈ 100K → 已 wrap 落盘，返回串 = `truncateContent(~200K inline) + summary + "\n[artifact:id]"`（标记在**末尾**，`grep.ts:130`）。
2. L1：grep ∈ READ_TOOLS，floor ≈ 100K；返回串 ~200K > 100K → **不 skip**。
3. `content.startsWith('[artifact:')` → **false**（标记在末尾）→ **再次 `artifactStore.save`**，且 rawContent 存的是已截断的 inline 串（非 L0 原始结果）。

**不触发的保护**：`read_file`/`read_section` L1 硬豁免；纯 L1 工具（run_tests）标记在开头不自触发；小输出不超阈值。
**测试盲区**：`tool-pipeline.test.ts` 只 mock 纯字符串返回，未覆盖"L0 wrap + L1 intercept"组合。

正确实现已存在：`extractTrailingArtifactId`（`tool-result-tiering.ts:37`，用 `$` 末尾锚定）——直接复用即修。

---

## 四、三轮 brainstorm 结论

### 核心收敛（多方案收敛到的真相）
> **L1 应只拦截"没有 L0 wrap 的工具"。有 L0 的（read_file/grep/bash）一律 L1 豁免。**

这一刀同时：① 消灭二次落盘 bug ② 删掉对它们恒死的 3x ③ 不丢任何 wrap 能力（glob/repo_map/inspect_project 仍由 L1 兜底）④ 顺手删 `find_files`/`search` 死条目。零新增复杂度，且顺应 DeepSeek "少卸载"经济学。

### 被否决的方向（记录灭绝原因，防回潮）
- **坍缩六层为单层**：被反证否决——删掉的是正交维度（堆内存/缓存经济学/动态预算），不是冗余。
- **对标 Claude 50K 单层阈值**：前提不成立——DeepSeek 应更高 inline（150K floor 是有意为之），照搬反增 cacheCreate。
- **卸载决策从 L0 上移 L1（V2）**：因果断裂——L0 的 summarize 需要 raw 全文，L1 只拿到已截断串。

### 正交进阶（陈旧度，落 L5 不落 L1）
context rot 最强红利在"语义干扰项最毒"——但按陈旧度处理必须在 L5 compaction（本就负责改写历史的层），**绝不能在 turn 内改历史**（破坏 append-only 前缀缓存）。

---

## 五、实施计划

### Phase 1 — 修正 + 清理（最小风险，确定收益，先做）

**动作**：
1. L1 `artifactIntercept`：对有 L0 wrap 的工具统一早退。当前仅 `read_file`/`read_section` 早退（`tool-pipeline.ts:330`），扩展到 `grep`、`bash`（只读）——即"凡有 L0 的工具，L1 不再做 save 决策"。
2. 标记检测：`tool-pipeline.ts:370` 的 `startsWith('[artifact:')` → 改用 `extractTrailingArtifactId`（`tool-result-tiering.ts:37`）末尾检测。
3. 删 `READ_TOOLS` 里的 `find_files`、`search` 死条目（`tool-pipeline.ts:256-257`）。
4. 删 read 工具上恒死的 `base*3` 分支（`tool-pipeline.ts:338-340`）与被它覆盖的 cacheAdvisor 路径；保留 `budgetFraction` 用于"无 L0 工具"的动态阈值。
5. 清理死 import：`bash.ts:10`、`read-file.ts:11` 的 `pruneThresholds`。

**成功标准**：
- 现有 `tool-pipeline.test.ts` / `artifact-threshold.test.ts` 全绿。
- 新增回归测试：grep 大输出（raw>100K @1M）走完整 L0→L1，断言 `artifactStore.save` 调用计数 = 1（当前会是 2）。
- 死参数清零（`find_files`/`search`/3x/被覆盖的 cacheAdvisor 路径）。

**退出条件**：若 `read_section` 取回链或 worker per-session 隔离测试转红 → 回退，重新评估 L0 边界。

### Phase 2 — 陈旧度感知 compact（兑现 context rot 红利，落 L5）

**动作**：给 L5 `prune`/`stale-round` 的保留判据，从"纯位置(protectRecent)"升级为"位置 + 语义干扰度"——优先折叠"早先探索、现已被更新内容取代"的旧工具输出（旧版本文件读、已完成步骤的 grep），而非单纯按字符大小。复用 `cacheAdvisor` ghost-registry 自适应骨架作为信号输入。

**成功标准**：长会话回放上，相同 turn 数下 effective context 里"陈旧重复内容"占比下降，缓存命中率不降。
**退出条件**：若改写历史导致 cacheCreate 上升 → 收紧到只在 compact 边界触发。

#### Phase 2 缓存断裂成本量化（DeepSeek V4-PRO，代码实证）

缓存断裂的本质（`prompt/engine.ts:30-32,40-50`）：改写历史中任一条消息，会让从被触碰消息往后的 exact-prefix 缓存**全部失效**，触发一次性 cache-MISS rebuild。

**单价公式**：
```
一次断裂成本 = 改写点之后失效的 token 数 × (3元 − 0.025元)/M ≈ 失效 token × 2.975元/M
```
- cacheRead ≈ **0.025元/M**（缓存里的旧 reasoning/tool 结果"留着"几乎免费）
- cacheCreate/rebuild ≈ **3元/M**（≈120× read price）
- 代码实证案例（`engine.ts:47-49`）：一次 fillRatio≈0.2 时的过早 collapse 造成 **169K token 断裂 ≈ 0.5 元**（169K×3元/M=0.51元 重算 vs 本可 0.004元 缓存读），外加 TTFT 退化（128K prompt 有缓存 ~500ms → 断裂后退回 ~13s）。

**成本完全由"是否改变改写点位置/时机"决定，与"折叠谁"无关。** 现有三道 floor 已防过早断裂：
- `FULL_COLLAPSE_FILL_RATIO=0.85`（`compact-boundary-coordinator.ts:34`）：仅窗口填到 85% 才跑断缓存的 full pass
- `COLLAPSE_FLOOR_FILL_RATIO=0.5`（同文件:52）：低于 50% 完全不改写（就是为防那次 169K 事故）
- 1M 窗口 stale-round 仅在 `turn===0`(用户边界) 且 `contextWindow<1_000_000` 才改写（同文件:113-114）

| 情形 | 描述 | 增量断裂成本 |
|------|------|------------|
| **A 守纪律** | Phase 2 只在已触发的改写点内，按语义干扰度排序折叠谁；改写点位置/时机不变 | **≈ 0**，且后续每轮 cacheRead 减少 + context rot 缓解 → **净省钱** |
| **B 破纪律** | 为清理中段旧内容把改写点前移 | 每前移 ΔN token 多失效 ΔN；按 169K 标度，长会话多触发 5–10 次 → **额外 2.5–5 元 + 每次秒级 TTFT 退化** |

**Phase 2 设计铁律（把成本永久锁死在情形 A）**：
> "陈旧度"只能作为「**在已经触发的改写点之内、优先折叠谁**」的排序依据；**绝不能为了折叠某条更靠前的旧内容而把改写点前移**。改写点的位置仍由现有 floor（0.5/0.85/turn0）唯一决定，Phase 2 不得触碰这三个触发条件。

### Phase 3 — 统一 L0 / 自适应阈值（锦上添花）

**动作**：给无 L0 的 READ 工具（glob/repo_map/inspect_project）评估补 L0 wrap（用回收的"行/字节双闸门 + 保尾 + 末尾标记"规范），让 L1 退化为纯安全网；或让 cacheAdvisor 按 DeepSeek 实测命中率动态抬高 inline 阈值。

**成功标准**：所有 READ 工具走统一 L0 wrap 路径，L1 仅作兜底。

---

## 六、风险与应对

| 风险 | 应对 |
|------|------|
| Phase 1 扩大 L1 豁免后，grep/bash 大输出失去 L1 兜底 | 不会——它们有 L0 wrap，L0 已覆盖所有需 wrap 的体积；L1 本就是冗余 |
| Phase 2 改写历史破坏 append-only 前缀缓存 | 严格限定只在 L5 compact 边界触发，绝不在 turn 内改历史。成本已量化（见 Phase 2「缓存断裂成本量化」）：守纪律(情形A)增量≈0 甚至省钱；破纪律(情形B)每次过早断裂约 0.3–0.5 元 + 秒级 TTFT 退化。铁律：陈旧度只决定"折叠谁"，不得前移改写点 |
| 复用 `extractTrailingArtifactId` 改变检测语义 | 它已用 `$` 末尾锚定，与 L0 末尾约定一致，比 startsWith 更正确；加测试锁定 |
| 多会话/worker 并发 | 不动 artifactStore per-session 隔离，Phase 1 只改 L1 判定逻辑 |

---

## 七、下一步（Phase 1 第一个具体动作）

为 grep 大输出"L0 wrap → L1 不应二次 save"写一个失败的回归测试（红），再改 `artifactIntercept` 让有 L0 的工具早退 + 末尾检测，使其转绿。
