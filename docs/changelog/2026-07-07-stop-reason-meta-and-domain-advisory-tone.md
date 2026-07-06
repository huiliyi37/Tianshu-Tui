# 2026-07-07 — 停止原因落盘 + 星域个性化 advisory（会话 519216c0 复盘四项跟进）

## 背景

对缓存验证会话 `519216c0`（YOLO 模式，102 个 API 轮，含一段 46 轮连续执行）
的深度复盘暴露了四个问题：

1. **停止原因不可取证**。run 3（46 轮）的终止原因在会话文件里零痕迹——
   `StopReason` 只走 debugLog（需 `RIVET_DEBUG`）与遥测（需
   `RIVET_DEBUG_TELEMETRY`），事后无法区分护栏熔断 / 用户中断 / 流错误 /
   自然收尾。用户中断与流错误两条路径甚至从未构造过 StopReason。
2. **pointer 回吐首犯无解释**。模型把历史里的 `[file written to …]` 显示
   占位符当真实内容传给 write_file，会话内 4 犯。escalation hook 阈值为 2，
   首犯只吃 inline error，机制解释来得太晚；且回吐总发生在连续写入场景
   （历史里占位符样本堆积后），完全可预防。
3. **action-intent 闸门核销失真**。"宣布了写入但只调只读工具"的提醒走
   `appendSystemReminder` 直注，不进 advisory 效能账本。复盘显示模型
   下一轮就补了写入（提醒实际有效），账本却记 0 采纳——低采纳数据会误导
   后续降频/静音决策。
4. **通用纠偏措辞对天权域是纯噪音**。该会话 68 条 advisory 送达 0 采纳。
   天权域认知场自带反驳与质疑（见 `star-domain.ts` tianquan
   systemPromptSuffix），命令式信号（"换个角度看问题"）的第一反应是称量并
   驳回。且该会话模型路线本身正确——纠偏方向也是错的。

## 处置

**1. 停止原因落盘**（`context/types.ts` / `loop.ts` / `turn-orchestrator.ts` / `loop-factory.ts`）

- `SessionMetadata` 新增 `lastStopReason`（source/turn/voluntary/detail/
  score/level/t），每次 run 结束覆盖写入。
- `AgentLoop.recordStopReason()` 统一落盘口；orchestrator `emitStop` 全部
  路径（natural-finish / end-turn / max-turns / wedged-loop / checkpoint）
  与 loop 收敛熔断路径接线。
- 补齐两条从未记录的路径：catch 块的 AbortError（按 abortReason tag 区分
  `user-interrupt` 与 `watchdog-stall`）与非 Abort 异常（`stream-error`，
  detail 截错误消息前 200 字符）。走 `recordStop`（无 onPhaseChange）——
  onAbort/onError 已负责 UI 渲染，避免同一次停止出双条系统行。

**2. pointer 回吐预防**（`hooks/pointer-regurgitation-hook.ts`）

- `POINTER_REGURGITATION_ESCALATION_THRESHOLD` 2→1：首犯即发完整机制解释。
- 新增 prophylaxis：单会话累计 3 次成功写入（write_file/edit_file/
  hash_edit/apply_patch）后、首犯发生前，注入一次占位符机制说明
  （informational 0.45，每会话一次；已有犯错记录时不发——escalation 已含
  更完整的解释）。

**3. action-intent 闸门核销接入**（`turn-orchestrator.ts` / `loop-factory.ts`）

- 提醒改走 advisory bus 的 system-reminder 通道（注入面与时序等价：下个
  请求构建时 drain 进消息流），带 `expect: tool_appears(写类工具+run_tests,
  2 轮内)` 核销谓词。deps 新增可选 `submitAdvisory`，缺省回退直注（测试
  构造不受影响）。

**4. 星域个性化 advisory**（`domain-advisory-tone.ts` 新建 / `advisory-bus.ts` / `loop.ts` / `convergence-detector.ts`）

- **措辞适配**：AdvisoryBus 渲染出口（bus 附录块 + system-reminder 通道）
  新增 toneAdapter 钩子，loop 惰性接 `sessionDomain.id`。天权词条把纠偏
  信号翻译成称量协议——援引域自身宪法"没有沉默的秤"：*采纳→据此行动；
  驳回→给出更强证据（文件:行号）；不可无声跳过*。把质疑本能从对抗信号
  变成消化信号的通道。豁免：constitutional tier（安全底线保持命令式）、
  encouragement、已带【天权】标签的内容。其他域无词条=恒等。
- **确认式收敛**：`buildInjectedMessage` 新增 route-confirmation 变体——
  L2 且 editRatio ≥ 0.2 且 errorPenalty ≥ 0.8（编辑在落地、失败率低）时，
  不再说"换个角度看问题"（路线正确的模型会整条驳回），改为确认路线 +
  要求一个验证锚点（typecheck/related_tests 钉住进度再铺开）。

## 设计要点

- tone 在**渲染层**每次应用、不改写条目本体——TTL 跨轮条目不会双重包装，
  账本/expect/key 均不受影响；适配器抛错回退原文，永不阻断送达。
- `lastStopReason` 写 meta 走既有 `updateMetadata` 原子写，失败不致命；
  不触碰消息历史，前缀缓存无感。
- tone 后缀是增量包装而非全文重写：原文保留为"证据"主体，成本低且
  expect 谓词语义不变。其余九域暂不配词条——等各域有复盘证据再加，
  避免无数据的过度个性化。

## 验证

- 新增/更新测试：pointer hook（首犯即发/前置提醒/抑制/误报豁免）、
  domain-tone（10 例，含 bus 集成与防双包装）、收敛确认变体（可达性用
  真实 `evaluateConvergence` 探测：score 0.382 → L2 命中新变体）、
  session-persist `lastStopReason` 落盘。
- 相关套件（loop / turn-orchestrator-goal / advisory-bus / readback /
  self-verify / create-runtime-hooks / convergence / session-persist）
  共 250 例全绿；typecheck 本次改动文件零错误。

## 关联

- 复盘对象：会话 `519216c0`（`~/.rivet/sessions/opencode-tui-522c83/`）
- 前情：`59e52394`（hook 信号经 AdvisoryBus 统一收编）、
  P1a expect 核销闭环（2026-07-04 advisory 生命周期设计）
