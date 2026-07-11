# 探针纪律 · 封锁出路 · 焦虑对冲 — agent 工作流补全

> 日期：2026-07-11
> 来源复盘：session 20b9714e + virtue-verification-loop 交付复盘
> 姊妹文档：`2026-07-11-virtue-verification-loop.md`（美德核销闭环）

## 1. 三个失败模式 → 三层机制

天枢复盘暴露的共同根因（原文）：

> 我在实现效用谓词时没有先读 `checkPositive` 实现来理解每种
> `AdvisoryExpectation.kind` 的精确语义，而是凭计划文档的描述推断了谓词行为。
> 交叉验证读了公开接口，但没有读内部实现——对谓词语义的理解是基于接口签名
> 推断而非实现验证。

> 镜面 ctx="10%·1M" 反驳了我上一轮"上下文紧张建议新会话"的判断——那个判断
> 不基于物理事实，是习惯性焦虑。

| 失败模式 | 机制 | 层 |
|---------|------|-----|
| 接口推断代替行为验证 | 行为语义验证纪律 + 微探针一等公民化 | W1 |
| 工具被拦即放弃排查 | 封锁出路契约 + gate-block-guard | W2 |
| 上下文焦虑收尾 | wrapup-anxiety-guard + kick 焦虑源修正 | W3 |
| 手段散落无升级路线 | 诊断手段阶梯（骨架 + 胶囊） | W4 |

## 2. W1 — 行为语义验证纪律 + 微探针机制

- `static.ts` workflow ②：新增"行为语义验证"段——接线/依赖某函数行为前，
  接口签名不作数；要么读内部实现，要么 15 秒微探针实测。"结构信心 ≠ 行为信心"
  点名写入。workflow ⑥ 收尾补 `.rivet/scratch/` 探针清理约定。
- `evidence-gate.ts` `BASH_PROBE_RE` 两类扩展：
  - 微探针执行：`tsx -e` / `node -e`（含 `npx` 前缀与中置 flag）
  - 取证型只读 bash：`grep -c/-n/-o`（含合并 flag 如 `-rno`）、`wc -l`、
    `head -n/-c/-N`。词边界防误伤；管道尾部命中（`git stash list | grep -c`）
    整条归类探针——整条命令仍是只读，语义正确。
  - 裸 `grep pattern file`（无统计 flag）不算——避免过宽。
- TDD scratch 豁免（双点）：
  - `evidence.ts` `trackFileModified`：`isScratchPath()` 命中不进
    `editsSinceLastTest` / `hasCodeEdits`（探针不该喂 RED 门计数）
  - `tdd-gate.ts` `evaluateTddGate`：目标是 scratch 路径时直接 allow
    （enforce 模式下探针本身不被拦）
  - `isScratchPath` 与 `reliability-mode.ts` 的 self-rescue 白名单同一路径
    约定（`.rivet/scratch/`，兼容 Windows 反斜杠与相对路径）

## 3. W2 — 封锁出路契约 + gate-block-guard

三处无出路文案补全（出路契约：每条拦截文案必须给替代路径）：

| 位置 | 原文案 | 补全 |
|------|--------|------|
| `tool-pipeline.ts` generic deny | "matches an active deny rule" 即止 | + 只读取证 / scratch 探针 / 请用户调 permissions |
| `tool-pipeline.ts` PreToolUse 无 reason | "no reason given" 即止 | + 标准替代路径 + 指向 .rivet/hooks.json |
| `mcp/policy.ts` MCP block | "explicitly blocked." 即止 | + 内置工具替代 / 其他 MCP / 请用户解封 |

`gate-block-guard` hook（postTurn，`RIVET_GATE_BLOCK_GUARD=0` 禁用）：

- 数据源：`tool-pipeline` 8 个拦截点（cerebellar / tdd / destructive /
  pre-tool-hook / reliability / doom-loop / plan-mode / deny+self-kill）经
  `onGateBlocked(kind)` 上报，`loop.gateBlockedKinds` 持 turn 级累计。
- 触发：单 turn 被拦 ≥2 → discipline advisory（"被拦不是死路——逐条执行
  拦截文案里的替代路径"），expect = 2 轮内探针工具出现（转向取证 = 采纳）。
- **per-key cooldown 放 hook 侧（发射端）**：同 key 3 轮内不重发。
  advisory-bus 的同 key dedup 是渲染层单轮的；spam 源是 hook 每 turn
  重新 submit ttl=1 条目，必须在发射端拦。冷却期内计数照 drain（清零），
  防跨 turn 累积假阳性。
- `static.ts` delivery-contract 补"被拦标准动作序列"：读出路 → 执行替代 →
  无替代转探针，被拦本身不进结论。

## 4. W3 — 焦虑收尾对冲

`wrapup-anxiety-guard` hook（postTurn，`RIVET_WRAPUP_ANXIETY_GUARD=0` 禁用）：

- 话术正则两组：
  - 直接：上下文(紧张|快满|压力|不足|有限|吃紧)、建议(开)新会话、
    先交付这部分、受限于篇幅
  - 间接（来自实际 session 证据"剩余 T3-T6 交给新会话"）：
    `(剩余|余下|剩下)[^。\n]*新会话`、`新会话[^。\n]*(继续|实施|接手|完成)`、
    交给/留给新会话。`[^。\n]*` 限单句内匹配，防跨句误配。
- **三段 ctxRatio 阈值**：
  - `< 0.5` → 注入反驳 advisory，引用实测数据（"实测 ctx=N%·window——
    该判断不基于物理事实，用 session_vitals 取证后再定"）
  - `0.5 ≤ ratio < 0.7` **灰区 → 不注入**（既不反驳也不附和——此区间焦虑
    话术可能确实有道理，反驳是 false positive 风险区）
  - `≥ 0.7` → 不触发（context-pressure hook 的收束建议在此区间合法）
- 冷却 5 轮。文本 <20 字符或 token 指标不可用时静默。

`dissipative-kick` 焦虑供给源修正：

- `buildKickActions` 新增第 4 参 `ctxRatio`（实测比率）。`s.pressure > 0.7`
  分支不再翻译成"上下文快满了"——pressure 是含 CVM 开销的复合值，用它做
  上下文声称在 10% 实际使用率时制造了焦虑（session 20b9714e 实锤）。
  实测 ratio ≥ 0.7 才提上下文（引用具体百分比）；否则如实说"系统复合压力
  偏高（资源/开销复合值，非窗口余量告急）"。
- `kick-hook` 经 `getEstimatedTokens`/`getContextWindow` deps 计算实测比率，
  create-runtime-hooks 接线（与 context-pressure 同源）。
- `static.ts` workflow ③ 的"交给新会话"建议补硬性判据：以 mirror ctx /
  session_vitals 实测为准（≥70% 才算），10% 时建议新会话是习惯性焦虑。

## 5. W4 — 诊断手段阶梯

- `static.ts` 诊断循环扩为六级阶梯（骨架版，常驻字节可控）：
  ① grep/read 取证 → ② **读内部实现**（switch/正则/边界条件——不是只读
  签名；结构信心来自接口验证，行为信心来自实现验证，两者是不同的操作；
  本次复盘的根因级别，独立成级）→ ③ 微探针 → ④ 最小复现测试 →
  ⑤ git 基线对照 → ⑥ 多视角。
  升级条件：上一级连续 2 次无新信息。准入规则：从匹配问题量级的层级进入，
  不逐级履历（⑤ 对回归类问题可直接跳入）。
- 详细版落 `docs/seed-capsule-diagnostic-ladder.md`（star="诊断阶梯"），
  经 recall_capsule(诊断阶梯) 按需拉取——冻结前缀只挂 gist 一行索引。
  胶囊额外含三条横切纪律：被拦不弃、焦虑对照、悖论即切换。

## 6. 缓存安全分级

| 改动 | 通道 | 缓存影响 |
|------|------|---------|
| static.ts 四处增补 | 冻结前缀 | 版本发布级一次性全局重建（惯例可接受，无会话内翻转） |
| seed-capsule 新胶囊 | 冻结前缀 gist 索引 + recall 工具通道 | 索引加一行 = 同上一次性重建；正文走工具结果通道，cache-safe |
| gate-block-guard / wrapup-anxiety-guard | advisory 通道 B（appendix） | 纯运行时计算，语义变化才字节变化 |
| 拦截文案改动 | tool_result 通道 | 在 anchor 之后，天然 cache-safe |
| dissipative-kick 文案 | advisory 通道 B | 同上 |
| BASH_PROBE_RE / TDD scratch 豁免 | 纯运行时判定 | 零 prompt 字节影响 |

无 frozenBase 重写、无 user 边界前插入、无工具定义变更。

## 7. 瑶光反证

- **反证 1（W1 探针激励被刷分）**：BASH_PROBE_RE 扩展后模型可能用无意义
  `grep -c` 刷证得分。→ 证得分分母是"决策工具总数"，无决策的探针不改变
  active 判定；探针→决策要求 target 关联，纯刷分不形成闭环。接受残余风险，
  efficacy 台账观察。
- **反证 2（W2 guard 在 reversal 季叠加噪音）**：被拦 ≥2 高度关联 doom loop /
  reversal 季——convergence、destructive-gate、kick 可能同轮在发。→ guard
  文案功能与其他条目不重叠（其他说"你在循环"，它说"被拦有出路"），且
  reversal 恰是"被拦→放弃"转折点、它最有价值的时刻。走 discipline 类别参与
  Top-N 竞争，预算挤占由 bus 仲裁，不做季节静默。per-key 3 轮冷却已防连发。
- **反证 3（W3 灰区误伤）**：0.5-0.7 灰区不注入是显式决策——宁可漏掉部分
  习惯性焦虑，不在"有点紧张"时错误反驳合理收束。阈值 0.5 若实测偏保守
  （大量 <0.5 焦虑话术漏网），由 vitals-lite 遥测回放校准，不在 v1 猜。
- **反证 4（W3 正则语言脆弱性）**：只覆盖中文措辞，英文会话
  （"hand off to a new session"）漏检。→ v1 接受：主用户场景中文；英文变体
  留待遥测证明需要后再加。
- **反证 5（W4 阶梯僵化）**：阶梯可能被当成必须逐级走的流程。→ 文案显式写
  "从匹配问题量级的层级进入，不逐级履历"；升级条件（2 次无新信息）是升级
  判据不是准入判据。

## 8. 验证记录

- `npm run typecheck` 通过。
- 直接相关测试 107/107 绿（evidence-gate 19 / tdd-gate+evidence 44 /
  gate-block-guard 5 / wrapup-anxiety-guard 10 / dissipative-kick 26 /
  mcp policy 3）。
- 回归测试 163/163 绿（create-runtime-hooks / hook-sensorium-ordering /
  kick-hook / runtime-hooks / tool-pipeline ×2 / static / reliability-mode）。
- 美德姊妹链 92/92 绿（virtue-settlement / virtue-signals / advisory-bus /
  stigmergy-hook）。
- 胶囊加载探针：`getCapsuleByStar(cwd, '诊断阶梯')` 实测返回 gist 正常。
