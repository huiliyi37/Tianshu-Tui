/**
 * `decisions` 通道的 holdout 实验 —— 自述层第一个有收益侧度量的通道。
 *
 * 背景：`ctx.decisions` 由正则从模型散文里刮出（decision-anchor.ts），它的渲染分支
 * 在生产里长期不可达（`<progress>` 的判别式问 "字符串非空" 而非 "有内容"，而
 * `<session-state>` 空壳恒真）。判别式修好后这条分支活了——但"活了"不等于"值得
 * 留"，此前整层没有任何通道被证伪过。
 *
 * 度量对象是**结果侧**指标：todo 退回率（`TodoStore.detectRegressions`）。这是本仓
 * 唯一直接观测"模型是否守得住自己任务状态"的探测器，其余指标只能说明上下文被
 * 注入了，说明不了注入起没起作用。
 *
 * 不走 AdvisoryBus 的 readback：信息型 advisory 不得编造 `expect` 谓词是本仓成文并
 * 加了门禁的政策（`advisory-expect-coverage.test.ts`）。holdout 反事实不需要谓词。
 *
 * ## 退出阈值（数据到手前写死，不在看到数据后临场议）
 *
 * - **样本门槛**：treatment / holdout 两组各需 ≥30 个"有 todo 写入"的会话。不足时
 *   判定返回 null，照 `getMatureLift` 的既有纪律——样本不足就说不知道，不硬下结论。
 * - **保留判据**：treatment 组退回率（regressedWrites / writes）比 holdout 组**相对
 *   低 ≥20%** 才保留该通道。
 * - **删除判据**：样本达标而未过保留判据 → 删掉 `decisions` 通道，不以"万一有用"
 *   续命。这是本方案对自己的第一次证伪承诺。
 */

/** 扣留比例——与 `DEFAULT_HOLDOUT_RATE` 同口径（advisory holdout 已跑通的刻度）。 */
export const DECISIONS_HOLDOUT_RATE = 0.1

/** 每组最少样本会话数，低于此值判定返回 null。 */
export const DECISIONS_MIN_SAMPLE = 30

/** treatment 组需要达到的相对退回率降幅。 */
export const DECISIONS_KEEP_THRESHOLD = 0.2

export type DecisionsArm = 'off' | 'treatment' | 'holdout'

/** 会话级稳定哈希——同一 sessionId 恒定落同一组，会话中途不会换臂。 */
function hashUnitInterval(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

/**
 * 决定本会话的实验臂。
 *
 * - 缺省 / `0` → `off`：完全不注入（Phase 1 落地时的行为，仍是安全默认）
 * - `1` / `true` → `treatment`：强制开启，供测试与确定性复现使用
 * - `experiment` → 按 sessionId 稳定分组，`DECISIONS_HOLDOUT_RATE` 落 `holdout`
 *
 * 无 sessionId 时 `experiment` 退化为 `off`：宁可不采样，也不要把无法归因的会话
 * 混进任一组污染分母。
 */
export function resolveDecisionsArm(
  sessionId: string | undefined,
  raw: string | undefined = process.env.RIVET_DECISIONS_INJECT,
): DecisionsArm {
  if (raw === '1' || raw === 'true') return 'treatment'
  if (raw !== 'experiment') return 'off'
  if (!sessionId) return 'off'
  return hashUnitInterval(sessionId) < DECISIONS_HOLDOUT_RATE ? 'holdout' : 'treatment'
}

export interface ArmRegressionRate {
  sessions: number
  writes: number
  regressedWrites: number
  rate: number
}

/**
 * 两组退回率对比。样本不足返回 null——这是判定的一部分，不是失败。
 *
 * `verdict` 只在样本达标时给出，取值直接对应上面写死的两条判据。
 */
export function decideDecisionsChannel(
  treatment: ArmRegressionRate,
  holdout: ArmRegressionRate,
): { verdict: 'keep' | 'drop'; relativeLift: number } | null {
  if (treatment.sessions < DECISIONS_MIN_SAMPLE || holdout.sessions < DECISIONS_MIN_SAMPLE) return null
  if (holdout.rate === 0) {
    // 对照组从不退回 → 该通道没有可改善的空间可言。
    return { verdict: 'drop', relativeLift: 0 }
  }
  const relativeLift = (holdout.rate - treatment.rate) / holdout.rate
  return { verdict: relativeLift >= DECISIONS_KEEP_THRESHOLD ? 'keep' : 'drop', relativeLift }
}
