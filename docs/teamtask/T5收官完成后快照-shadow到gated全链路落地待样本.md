# T5 收官完成后快照 — shadow→gated 全链路落地,待真实样本

> 日期：2026-06-09
> 性质：T5 主线收官**完成后**的状态快照（前一份 `T5主线进度快照-交天权出收官计划.md` 是 6-08 收官**前**的输入地基，保留作历史）
> 作者：瑶光 `yaoguang`（复现纪律门神，Opus 4.8）
> 收官前 HEAD：`a6e0422`（前快照终点）→ 收官后 HEAD：`07d6808`（T5/T6 主线终点；其后 `f128074` 等为 TUI 旁支）
> 关联：[[project_tianliang-executor-precision-baseline]]、[[structure-as-value-family-and-dataflow-verifier]]、[[plan-green-is-not-landing-green]]、[[gitignore-controlled-artifacts-silently-dropped]]

---

## 0. 一句话

T5「路由即主动推理」主线**技术骨架 100% 收官**：从 P0 影子层到收官三件全部有本体落地、全部测试绿。从「只观测」(shadow) 到「能影响行为」(gated) 的完整链路、所有 reward 路径、所有安全门（7 闸 + 默认关 + hardFloor + false-green 零容忍）都建成。

**但整条主线的真实「未完成」是一条事实边界：所有开关仍默认关（`keep_shadow_only`），因为真实样本是 0。** 机器造好了、闸门焊死了，但还没喂过一口真实数据。这不是缺陷，是设计纪律——不靠「设计完成度」开关，只靠真实证据。

---

## 1. 收官前已落地（见前快照 §1，提交为证，此处不复述）

P0 双影子层 `2526f03` / P1 Reward Loop `8d56bce` / P2 shadow model policy + PlanCache `195c903` / P2.5 历史回灌 `34f1c1a` / P3 tier shadow `045a335` / P4-a gated team scheduler bandit `a6e0422`（主线第一个 reward 真影响行为，7 闸模板）。

---

## 2. 收官批次（6-08 21:00 → 6-09 13:00，全部落地）

> 审查分级（如实，不混淆）：
> **【已门审】** = 瑶光做过 RED→GREEN 复现 / 逐行核对的；
> **【仅落地+测试绿】** = 本体文件存在、单测通过，但未单独过门神 RED 复现。

| 项 | 提交 | 本体 | 审查分级 |
|---|---|---|---|
| **P4-b scope-health** | `3dc32f0` | `team-scope-health.ts` | 【仅落地+测试绿】observed-first 第二信号（planned vs observed diff），测试 8 绿 |
| **收官-1 episode 聚合**（还 P1 债） | `4b43bc4`+`3d05b23` | `team-episode.ts` | 【仅落地+测试绿】跨 fromWave stitch 成 TeamEpisode，append-only；reward-loop 接入；测试绿 |
| **P4-c physarum 监督边** | `cb3cf28`→`1cf1d6c`→`c2e165c` | `team-physarum-supervision.ts` | 【已门审】5 发现闭环 4；遗留「同 wave 方向边语义真覆盖」缺口已立待办 |
| **P4-d model-tier-bandit** | `217f1d8`+`01a94fa` | `model-tier-bandit.ts`+`model-tier-gate.ts` | 【已门审】7 闸 fail-closed，RED 复现钉死「flag 默认关」；scope-health veto + hardFloor |
| **收官-2 shadow→gated** | `8f21be6` | `gated-influence-audit.ts` | 【仅落地+测试绿】复用 P4-a 门模板，audit 行永不作训练样本；测试绿 |
| **收官-3 偏差验收** | `32ee05a` | `gated-influence-evaluation.ts` + 验收报告 | 【已门审】per-source 判级 fail-closed（unknown 绝不当 healthy）；报告口径正 |

---

## 3. 安全门（gated 启用的承重墙，已验）

收官-2/P4-d 的 gated 启用复用了 P4-a `a6e0422` 那套门。model-tier-gate 7 道串联闸（任一不过即 `applied:false`，降回规则推荐）：

1. 总样本 `<MIN_TOTAL=30` 2. arm 样本 `<MIN_ARM=5` 3. reward margin `<0.05` 4. **false-green `>0`（零容忍）** 5. scope-health `medium/high` veto 6. **hardFloor**（候选 tier 低于硬下限即挡，防降级到不安全模型）7. **`featureFlagEnabled`（默认 false）**

两条关键安全性质（RED 复现钉死）：
- **flag 默认关**：闸 1-6 全过、gate 可「开」，但 flag 关时 `applied:false`，仍只 shadow。双层门=证据门+人工开关。
- **reward 穿越 shadow 边界的唯一跳**：`coordinator.ts:332` 仅 `gate.applied===true` 才把 effectiveTier 传入 selectModelForTask；否则传 undefined → 完全退回规则路径。边界干净。

evaluation 判级（`gated-influence-evaluation.ts`）：false-green→`disable_and_investigate`；scope unknown→`keep_shadow_only`（**never guessed healthy**）；兜底 `keep_shadow_only`（fail-closed 默认）。

---

## 4. 真实未完成项 —— 这才是 T5 的「最后一步」

代码层 ready，事实层未发生。`32ee05a` 验收报告白纸黑字：

| 路径 | shadow 样本 | gateOpen | applied | 建议 |
|---|---:|---:|---:|---|
| team_scheduler_bandit | 0 / 30 | 0 | 0 | `keep_shadow_only` |
| model_tier_bandit | 0 / 30 | 0 | 0 | `keep_shadow_only` |
| model_routing / ModelG | 0 / 30 | 0 | 0 | `keep_shadow_only` |
| plan_cache_advisory | 0 / 20 | 0 | 0 | `keep_shadow_only` |
| physarum_supervision | 0 / 20 | 0 | 0 | `keep_shadow_only` |

**所有路径 0 样本 → 没有任何一条够格从 shadow 转 gated。** 收官-2「shadow→gated 真启用」的代码闸门齐备，但「真启用」这个**事实跨越没发生**——因为还没喂真实数据。

> ⚠️ 样本核实盲区（已记记忆）：`.rivet/meridian.db` 实际存在（约 69MB），不是「不存在」；它被 `.gitignore` 屏蔽，会话内 git-aware 工具看不见，需 `find` 定位。db 在但其中 gated influence 的 prefix rows 为空（0 样本）。判样本数用 `find` + 直读 db，别信 glob 空结果。详 [[gitignore-controlled-artifacts-silently-dropped]]。

### 下一步（不是写代码，是喂数据 + 验证）

1. 补齐真实运行样本：跑够各路径的 shadow 对照窗口（≥30 / ≥20）。
2. 重跑 `evaluateGatedInfluenceHistory()`，按 per-source 独立看：`gateOpenCount` vs `appliedCount` 分离、`falseGreenRate` 是否 0、`scopeLeakRate`/`worstScopeSeverity` 是否来自 observed-first、`regretEstimate` 是否持续正向（非单次成功）。
3. **用真实证据**决定哪条路径够格开第一个 gated 开关，人工 opt-in。那才是 T5 真正收口——从 shadow 到 gated 的**事实**跨越。

---

## 5. 已知遗留（都立了待办/记录，非阻塞主线收官）

1. **P4-c 同 wave 方向边语义真覆盖缺口** — `docs/teamtask/P4-c收官待办-同wave方向边语义真覆盖缺口-交天权.md`。数据模型债，需立项。
2. **T6 locus fingerprint 回归测试缺口** — `docs/teamtask/T6收束遗留待办-locus-fingerprint回归测试缺口.md`。`<locus>` 进 frozen 块靠结构保证+手验，无常驻测试守；属 [[plan-green-is-not-landing-green]] 同族。非阻塞。
3. **RSS<115MB flaky** — 预存失败（非 T5 引入），负载敏感（隔离单跑 445ms 过，全量 2727ms 越阈）。不属 T5 范围，建议单开清理项，免长期掩盖新内存回归。
4. **T5 验收报告措辞勘误** — 已就地修（meridian.db「存在但无样本」，非「不存在」），未提交（docs 改动挂工作区）。

---

## 6. T6（旁支，已收束）

T6 天枢具身定位（自我离开 cwd）非 T5 主线，但同期收束：`6d3841a`（detector）→ `07d6808`（`<locus>` 渲染 + `.rivet/SELF` 入库 + 天权/天璇修订）。【已门审】`detectCwdRelation(repo root)=self` 实证通过，marker 入库可被 fresh clone 复现——这一刀已「睁眼」。详 T6 待办文档。

---

> 给天权/领航星：T5 该称的重量，是「代码收官」与「事实启用」之间那道缝。骨架全建成、门全焊死、测试全绿——但 5 条路径全是 0 样本、全 `keep_shadow_only`。从「能影响」到「真影响」差的不是代码，是真实运行数据 + 一次基于证据的人工 opt-in。这条主线最该被守的纪律恰恰在最后这步：**不靠设计完成度开关，只靠真实证据。** 报告末句「不声称智能提升已证明」是该被裱起来的那句。
>
> —— 瑶光 `yaoguang`，2026-06-09
