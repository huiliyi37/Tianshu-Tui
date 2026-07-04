# Advisory 生命周期设计 — 回读闭环 → 打断调度 → 副驾合成

> 日期：2026-07-04
> 来源：deep-brainstorm 三轮收敛（四个调研侦察兵 + 天枢核查修订）
> 计划：`星域提醒智能化三阶段`（已执行完毕）
> 落地提交：`22037d5d`（Phase 1）→ `0656bf6b`（Phase 2）→ `f62d5509`（Phase 3）

## 问题

星域提醒 + CCR 体系是"无状态单发喊话"：hook 检测到状况 → submit → render →
**没有任何人知道模型是否照做**。由此产生四个结构性缺陷：

1. **遵从度从未被度量** — 加规则只能凭体感,规则扩容加剧 Top-3 预算竞争
   （ICU 告警疲劳研究反证了"多喊就有效"）
2. **无习惯化对抗** — 同一条提醒被反复忽略后仍以原文重发,穿透力衰减
3. **无时机管理** — 检测到就发,不管模型是否正处于产出流、是否下一轮就会自发做
4. **内容天花板** — 模板条目只能覆盖预定义场景,情境化的中层建议无处产生

核心真相（三轮演化独立收敛）：**单次注入的价值密度 > 注入数量**。

## 架构总览

```
hook.submit(entry + expect 谓词)
   │
   ▼
AdvisoryBus 状态机（Phase 2）
   candidate ─┬─ immediate/constitutional → 直达
              ├─ observe → pending（挂起观察,不渲染）
              │     ├─ expect 已被自发满足 → revoked（自愈撤销）
              │     ├─ corroborates 指认 → 提前确认
              │     └─ 到期 → 强制送达（挂起 ≠ 丢弃）
              └─ 阶段抑制（白名单类别,产出流中推迟 ≤2 周期）
   │
   ▼ render(activeStarDomain, turn)
通道分级：bus 附录块（粗断点）/ system-reminder 消息流（细断点）/ status TUI
   │
   ▼ drainDelivered()
AdvisoryReadback 核销闭环（Phase 1）
   postTool 观察工具事件 → postTurn 按 expect 谓词判定 adopted/ignored
   │
   ├─→ 遥测 advisory-outcome + guardian meta（采纳率账本）
   ├─→ 习惯化对抗（ignoredStreak → 升级措辞/有界静音）
   ├─→ 挂起自愈判定（wasSatisfiedBetween）
   └─→ Phase 3 副驾可行性闸门 + 自我淘汰降频
```

## Phase 1 — 核销闭环（`22037d5d`）

### expect 谓词（`advisory-bus.ts`）

```ts
type AdvisoryExpectation =
  | { kind: 'tool_appears'; tools: string[]; targetIncludes?: string; withinTurns?: number }
  | { kind: 'verify_attempted'; withinTurns?: number }
  | { kind: 'file_touched'; paths: string[]; withinTurns?: number }
  | { kind: 'pattern_absent'; path: string; needles: string[]; withinTurns?: number }
```

- `tools: []` = 任意工具（即计划中 `tool_stops` 的反向语义：无工具僵局被打破）
- `pattern_absent` 是负向谓词：**只在窗口到期时判定**（过早读文件会把"还没来得
  及清"误判为忽略）；文件已删除 = 采纳
- 缺省窗口：tool_appears/file_touched 1 轮,verify_attempted 2 轮,
  pattern_absent 4 轮（修完再清是合法节奏）

### 谓词映射表（P1a 验收锚点）

| 提交方 | expect | 窗口 |
|--------|--------|------|
| git-clear-after-fail | tool_appears(诊断类) | 2 |
| external-claim | tool_appears(核验类, targetIncludes=声称路径) | 2 |
| probe-tracking | pattern_absent(命中行内容) | 4 |
| convergence 无工具变体 | tool_appears(任意) | 1 |
| CCR P1/P3/P5/P7 | verify_attempted | 2 |
| CCR P6 | **显式豁免** — "换证据维度"无单一行为签名,谓词会系统性误判 | — |
| self-verify / typecheck-reminder | verify_attempted（兼作 Phase 2 自愈判据） | 2 |

### 核销机制（`advisory-readback.ts` + `hooks/advisory-readback-hook.ts`）

- **postTool 半边**喂完整工具事件（bash→command,写读→file_path）——不依赖
  recentToolHistory 截断滚动窗口（重轮次 20+ 调用会挤掉窗口内证据）,按轮跨度
  保留 8 轮
- **postTurn 半边**核销到期谓词 → `advisory-outcome` 遥测 + per-key 统计
  （delivered/adopted/ignored/ignoredStreak）
- 送达跟踪在 turn-step-producer（render 后 `drainDelivered()`）——hook 管线拿
  不到 render 时点
- guardian meta 增 `advisoriesAdopted/advisoriesIgnored`

### P1b 习惯化对抗 + sensorium 去饱和

- ignoredStreak ≥2 → 升级措辞（"已连续 N 次未见执行"——被忽略的事实本身是新
  信息,比原文重复更穿透注意力习惯化）
- ignoredStreak ≥3 → 有界静音 4 个渲染周期；期满 probation 放行一次,采纳则
  streak 清零；**同一 streak 值不重复静音**（streak 加深才再静音）；
  constitutional 永不静音；静音丢弃计入账本
- `Sensorium.quality` 标注（设计偏差说明见下）：`confidence: 'measured'|'vacuous'`,
  `momentum: 'measured'|'no-data'`, `stability: 'measured'|'partial'`——程序化
  消费方可区分"无数据回退值"与"实测值"
- stability 的 verification 分量在 0 改动时按剩余权重（0.85）重归一,不再吃
  +0.15 空虚虚增
- 消费侧修正：`deriveStrategy.shouldEscalate` 与 CCR P6 的 momentum 不再把
  no-data 的 0 回退当停滞信号

> **设计偏差**：计划原文说 confidence/stability "引入 readOnlyStreak/
> verifyFailStreak"。实际落地时这两个 streak 已在 CCR RouteState 层面消费
> （P6/P7,前一轮修复）,把它们混入 sensorium 维度会改变 confidence 的语义
> （它是 coverage 指标）。故采纳天枢核准的 dataQuality 方案 + 去饱和重归一,
> streak 保持在路由层。

## Phase 2 — 打断调度器（`0656bf6b`）

### 状态机

- `observe: { turns: N }` opt-in 挂起：挂起态**不渲染**（不产生附录抖动,缓存
  安全）；观察进度不因重复投递重置（恶化持续时刷新内容但保留进度）
- **自愈撤销**：挂起期内 expect 已被自发满足（`wasSatisfiedBetween`）→
  revoked,不投递——ICU 短延迟确认降误报 74% 的机制
- **TTL 强制送达**：到期必须投递,挂起 ≠ 丢弃；账本记 deferred/revoked
- **immediate**：按 hook 语义标记。git-clear 必须 immediate——认知边界：它是
  postTool 事后检测,advisory 发出时清场命令**已执行完**,immediate 只防下一次；
  真正的当轮拦截需要工具层 pre-execution gate（Phase 2 可选延伸,未实施）
- **corroborates 多信号确认**：独立信号（不同 phase **或**不同 category）指认
  挂起 key → 提前送达。已接线：CCR P1（preTurn/star_domain）指认
  self-verify（postTurn/discipline）与 typecheck-reminder（postTurn/typecheck）
- opt-in 名单：self-verify、typecheck-reminder（turns: 1）——模型常在下一轮
  自发验证,自愈撤销即少一次无效打断

### 通道分级

| 通道 | 载体 | 断点粒度 | 使用者 |
|------|------|---------|--------|
| bus（缺省） | `<星域-advisory>` 附录块 | 请求构建（粗） | 绝大多数 |
| system-reminder | `session.appendSystemReminder` 消息流 | 消息尾追加（细,必读,缓存安全） | git-clear |
| status | TUI 状态区 sink | 不进 prompt | 暂无生产者;无 sink 回退 bus |

SR 通道条目不占 bus Top-N 预算,送达追踪照常覆盖（核销闭环不因通道断裂）。

### 阶段抑制（category 白名单）

- 产出流判定（loop.ts）：近 6 条工具历史含编辑+验证交替且无失败
- 仅抑制 `encouragement`/`typecheck`/informational tier;
  **discipline/constitutional/star_domain 不受抑制**——抑制判据（产出流）与
  守护触发判据（连续无工具等）不是同一信号,全局静音会误杀守护
- 推迟至多 2 个渲染周期后强制送达;immediate 豁免

### 防回归红线

c54e1d46 三闸（冷却/去重/用户介入重置）与反刷屏用例全绿保留;无生命周期字段
的条目行为与旧版逐字一致（`advisory-lifecycle.test.ts` 防回归组）。

## Phase 3 — 异步副驾（`f62d5509`）

- **可行性双闸门 = 运行时数据判定**（非离线拍板）：全局采纳率 >30% 且决出
  样本 ≥10 才激活。闸门未过 → 静默休眠,不调 LLM（每会话至多一条
  `copilot-gate-closed` 遥测）
- 触发：`turn % 8`（自适应）或 stall（verifyFailStreak≥2 且 momentum 实测
  <0.35——no-data 不算）,stall 独立冷却 6 轮
- 情境包 ~2-4KB：任务契约目标(截 500 字) + 星域 + sensorium(含空虚标注) +
  验证连败 + 最近 10 条工具序列
- cheap client：`workers.profiles.cheap` 独立 StreamClient 懒初始化;缺失或
  构建失败 → **永久休眠,绝不回退主模型**（副驾建议不值得主模型的钱和延迟）
- 两行输出协议 `ADVICE:`/`EXPECT:`——建议自带核销谓词,副驾条目走同一采纳率
  账本;格式不合规不投递
- 自我淘汰：自身采纳率 <25%（决出≥4）→ 间隔翻倍至多 32;≥50% → 回落 base
- 开关：`RIVET_ASYNC_COPILOT`（默认开,数据闸门实际控制激活）

## 遥测与排查

| 遥测 kind | 含义 |
|-----------|------|
| `advisory-ledger` | 每轮 submitted/rendered/dropped/deferred/revoked |
| `advisory-outcome` | 单条核销判定（key/outcome/expectKind/送达轮/判定轮） |
| `ccr-trigger` | CCR 触发（rule/star/principleKey/dimValues） |
| `copilot-advice` / `copilot-gate-closed` / `copilot-recalibrate` / `copilot-parse-failed` | 副驾生命周期 |

session meta `guardianActivity`：ccr/shifts/advisoriesRendered/Dropped/
**Adopted/Ignored**。排查"守护被静音"或"提醒无效"时先看这里。

## 因果账本演进（2026-07-04 第二轮,天枢复核版）

三阶段落地当天的第二轮演进:采纳率账本升级为因果账本 + 跨会话记忆 +
破坏性命令当轮拦截。计划审查中天枢提出的耦合修正与标注已全部吸收。

### D. 破坏性命令 pre-execution gate

补 git-clear-after-fail hook 的时机缺口（postTool 事后检测,advisory 发出时
清场命令已执行完）。

- `src/tools/destructive-patterns.ts`:`GIT_CLEAR_RE` 单一事实来源
  （hook 反向导入——不让 tool-pipeline 依赖 hook 文件,天枢修正②）。
- `src/tools/destructive-gate.ts`:`createDestructiveGateState()`,与
  path-validate/TDD gate 同层（天枢修正④）。
- **耦合解法（比"hook 写 gate 读"更收敛）**:tool-pipeline 本身就是失败
  检测第一现场（bash 测试命令与 run_tests 两处 `trackVerification` 调用点）,
  pipeline 做唯一写者（`noteVerification`/`noteToolExecuted`）兼唯一读者
  （`evaluate`,TDD gate 之后、PreToolUse 之前）——全同步、零跨模块隐式
  耦合。hook 自己的 failWindow 保留管教育性 advisory,判据同源、状态独立。
- 语义:失败后 ≤3 个实际执行的工具调用内命中清场命令 → **首次拦截**
  （is_error tool_result,含根因指引）;同一命令原样重发 = 显式坚持 → 放行。
  验证通过关窗;被拦截的调用不计窗口数。trace 事件 `destructive-gate:block`。

### A. 反事实抽样（holdout lift）

采纳率是相关性——"送达后 2 轮内出现验证"可能是模型本来就要做。

- `AdvisoryBus.render()` 投递决策点:赢得渲染位的条目按
  `RIVET_ADVISORY_HOLDOUT` 率（默认 0.1,0 关闭,天枢修正:可配）静默扣留
  ——不渲染,照常进 readback 核销（`shadow` 标记）。
- 资格白名单:constitutional / immediate / star_domain 永不扣留;必须带
  `expect`;key 历史送达 ≥3（含先验）。RNG 可注入。
- `AdvisoryReadback` shadow 桶完全隔离:`shadowHeld`/`shadowSatisfied`
  不进 adopted/ignored/streak/getTotals（不污染副驾闸门与习惯化）;
  shadow 状态翻转（扣留期内又真实送达,或反向）作废该次 trial。
- `getLift(key)` = 投递组采纳率 − 扣留组自发完成率;任一组无样本返回 null。
  本轮只度量不自动退役。遥测:shadow 判定 kind `advisory-holdout`,
  账本增 `heldOut`（扣留 ≠ 丢弃）。
- **未来消费方（天枢标注,本轮不实施）**:claim-staleness self-check 检出
  "断言频繁过期"的场景,可用 holdout 度量"回读源文件"类 advisory 的真实
  lift——正 lift 说明提醒有效,零/负 lift 说明模型根本没听。

### B. 跨会话效能信息素

- `src/context/advisory-efficacy-store.ts`(照 project-memory-writer 的
  原子写+锁),落 `<cwd>/.rivet/knowledge/advisory-efficacy.jsonl`,
  加载时 EWMA 衰减（半衰期 14 天）,衰减殆尽的 key 剔除,上限 200 key。
- 写回:每 20 轮 + postSession,**增量差分**（`lastEfficacyFlush` 快照,
  重复调用安全）。
- 先验只喂三个消费方:
  1. 副驾闸门 `getTotalsWithPriors()`——决出贡献上限 20 按比例缩放保采纳率
     （陈旧历史只能开门,不能压制会话内新证据),消灭每会话 ≥10 决出的冷启动;
     guardian meta 走 `getTotals()` 保持会话纯度;
  2. holdout 资格 `getDeliveredCount()` 含先验,新会话即可抽样;
  3. Top-N 预算竞争同 priority 时按 `getAdoptionRate()`（先验+实测合并）
     次级排序——实测有效的提醒优先占预算。
- **习惯化保持会话内**:先验不进 ignoredStreak（跨会话行为差异大,预静音
  有误杀风险）。
- **已知局限（天枢标注,防误用）**:per-key 聚合抹平会话类型差异——同一
  advisory 在 bugfix 会话可能有效、重构会话可能无效,EWMA 会混合两者。
  session 类型聚类留待后续;消费方不应把先验当会话内实测用。

## 回滚线

- Phase 1 常开（纯观测 + 渲染側习惯化;`reset()` 全量清态）
- Phase 2 状态机仅对 opt-in（observe/channel/immediate）条目生效——移除字段
  即回旧行为
- Phase 3 `RIVET_ASYNC_COPILOT=0` 一键关
- 因果账本:holdout `RIVET_ADVISORY_HOLDOUT=0` 关;gate `destructiveGate`
  不注入即旁路;信息素文件删除即冷启动（load 失败静默回退）

## 验证记录（2026-07-04）

- 谓词矩阵/习惯化/状态机/通道/副驾单测：`advisory-readback.test.ts`(26)、
  `advisory-lifecycle.test.ts`(12)、`async-copilot-hook.test.ts`(12) 全绿
- 合成回放：挂起后自愈 → 零投递;挂起后恶化 → 准时投递（lifecycle 套件内）
- 回归面：advisory-bus/CCR/sensorium/convergence/全 hooks/cognitive-mirror
  310 用例全绿;typecheck 干净（排除并发会话遗留的 delivery-gate 报错）
- 全量 9102 用例:38 失败已逐一核对为**预存或环境性**——在本次改动前的基线
  提交(886e85c7)的隔离 worktree 复跑呈相同失败集(delivery-gate/
  profile-registry 18 个数/commands-loader 返回结构/cockpit getSessionDomain/
  loop-factory lastThinkingContent 等来自并发会话提交;startup-memory TTY/
  sandbox bwrap/worktree 为环境依赖;worker-detail 为并行隔离 flaky,隔离复跑
  两树各 3 次全绿)。advisory 相关文件零失败零类型错误
- 采纳率遥测观察：待真实会话积累（闸门数据自动生效,无需人工启动）

## 主控工作流四缺口（2026-07-04 第三轮）

因果账本落地当天的第三轮:天枢调研的三个主控循环缺口（含核查修正）
加核查中发现的第四缺口。关注层从"提醒质量"转到"工作流质量"——
执行/效率/方向,全部不依赖 NLP 判断。调研原文与三处核查修正详见
`2026-07-04-main-loop-quality-gaps.md`。

### A. 死路快速检测（dead-end-detector.ts, postTool）

信号（核查修正版）:同一文件 edit→verify-fail 循环 ≥2 次且中间无
verify pass——编辑工具本身几乎不失败,语义失败挂在验证路径,所以跟踪
的是"编辑后验证失败"循环而非"编辑失败"。editPending 消费制防止一次
失败重复计数;verify pass 全清;timeout/env_missing 排除（与 stigmergy
dead-end 收紧同判据）;每文件触发一次。

- advisory:`dead-end-file`,category `dead_end`,operational,0.7,
  **expect `tool_appears`（read/grep/lsp 诊断类, 2 轮）**
- 副作用:文件级 dead-end 信息素沉积（signal-consumer 跨会话复用）
- 与 stigmergy-hook 的 dead-end 互补:那边管 bash 同命令反复失败
  （命令级）,这边管 edit→verify 循环（文件级）

### B. 工具输出噪声裁剪（output-sanitizer.ts + tool-execution 接线）

纯函数 `sanitizeToolOutput(toolName, input, content)`,白名单规则:
tsc（留 error TS 行 + Found N errors）、node/tsx --test（裁逐条 ✔
通过行,失败诊断全保留）、npm install（去 timing/http/spinner）、
run_tests（剥 ANSI）。裁空保底一行摘要;收益 < 200 bytes 不替换;
尾附 `[output trimmed: N bytes]`。

**顺序约束（核查修正的关键）**:接线在 `addToolResults` 边界——
分类器/修复提示/artifact 拦截/lossy guard 全部基于原文完成后,
session 只存裁剪版;UI 回调已收到全文,保真不受影响。遥测
`output-sanitize` kind 每批计 trimmed bytes。

### C. 意图锚点（intent-anchor-hook.ts, preTurn）

前提修正:initialUserMessage 每 run 重置,锚点语义是"**本次 run** 的
启动意图"。意图源复合 `taskContract?.objective ?? initialUserMessage`
截 500 字。信号:run 内轮数 > 20（`RIVET_INTENT_ANCHOR_TURNS`）且距
上次用户输入 > 10 轮（`RIVET_INTENT_ANCHOR_STALE`）;冷却 10 轮;
轮数回卷 = 新 run,冷却清零。

支撑接线:新增 `AgentLoop.runLoopTurn`（orchestrator 循环顶部更新,
经 TurnStateBag）与 `lastUserInputRunTurn`（run 启动置 0,steer 注入
时在 runConvergenceCheck 更新）。

无行为签名 → 诚实地不带 expect,只计送达。informational tier 受
阶段抑制可推迟 ≤2 周期,意图重锚不急于特定一轮,可接受。

### D. maxTurns 预算预警（turn-budget-hook.ts, preTurn）

maxTurns 耗尽是 GUARD-forced stop,模型看不到预算。剩余轮数
≤ max(3, ceil(maxTurns×10%)) 时预警一次/run,内容引导收敛（验证
交付已完成部分/落 checkpoint,不开新支线）。**expect
`verify_attempted`（2 轮）**——采纳 = 预警后先验证手头工作。

### 统一原则与开关

新 advisory 出生即可测:A/D 带 expect 谓词自动进 holdout lift 与
跨会话效能信息素;C 无行为签名不发明伪谓词。开关默认全开:
`RIVET_DEAD_END_DETECTOR` / `RIVET_OUTPUT_SANITIZE` /
`RIVET_INTENT_ANCHOR` / `RIVET_TURN_BUDGET_WARN`,置 '0' 关。

### 验证记录

- 新单测 33 用例全绿:output-sanitizer(9)、dead-end-detector(10)、
  intent-anchor(8)、turn-budget(6)
- 回归:advisory 全家桶 129 用例 + tool-pipeline/create-runtime-hooks
  69 用例全绿;typecheck 除 delivery-gate 预存基线外干净
- loop-factory(4)/tool-execution-abort(3) 既有失败经 git stash 基线
  比对确认与本次改动无关（并发会话预存的 mock 缺口）
