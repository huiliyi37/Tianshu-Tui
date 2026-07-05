/**
 * Regression-Bisect 断路器 — postTool 检测「回归排查循环」并强制策略升级
 * (重构事故链缺口 4, 2026-07-04)。
 *
 * 事故形态：重构后功能丢失（导航/路由/命令入口消失），模型陷入假设式排查
 * ——连续多轮 read/grep/测试 却零文件修改、零收敛，20+ 轮盲排查无果。
 * convergence-detector 只会建议「开新对话」，对回归类问题没有给出正确武器：
 * **基线对照**。回归的本质是「某个提交之前是好的」——git log 定位区间 →
 * git bisect / checkpoint diff 对照基线 → 对照 regressionInventory 逐项定位，
 * 三步走比继续猜快一个数量级。
 *
 * 触发条件（全部满足）：
 * - 会话存在回归语义（objective 或诊断工具输入中出现 丢失/消失/regression 等）
 * - 连续 ≥ RUN_THRESHOLD 轮只有诊断类工具（read/grep/glob/测试）且无成功写入
 * - 本会话未触发过（写入成功即重臂）
 *
 * 与 dead-end-detector（同文件盲改循环）、stigmergy（bash 同命令反复失败）
 * 正交：这边抓的是「只读排查空转」，前两者抓的是「改了但不对」。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

export interface RegressionBisectDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** 意图锚点（taskContract?.objective ?? initialUserMessage）——回归语义主信源。 */
  getObjective?: () => string | null
}

/** 连续诊断空转轮数阈值 */
export const REGRESSION_LOOP_TURN_THRESHOLD = 5

/** 回归语义签名（用户描述 or 模型排查关键词） */
const REGRESSION_RE = /丢失|消失|不见了|没了|丢了|坏掉|坏了|不显示|不出现|不工作|失效|回归|regression|missing|disappear|lost|broke(?:n)?|stopped working|no longer/i

/** 诊断类工具（只读排查） */
const DIAGNOSIS_TOOLS = new Set(['read_file', 'grep', 'glob', 'semantic_search', 'run_tests', 'repo_graph', 'related_tests', 'read_section', 'lsp_goto_definition', 'lsp_find_references'])

/** 写类工具（出现即打断空转计数——模型有了新假设并付诸行动） */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'hash_edit', 'apply_patch', 'ast_edit'])

function isDiagnosisEvent(tool: RuntimeToolEvent): boolean {
  if (DIAGNOSIS_TOOLS.has(tool.name)) return true
  if (tool.name === 'bash') {
    const cmd = (tool.input?.command as string) ?? tool.target ?? ''
    // 只读型 bash（cat/ls/git log/git diff/测试）算诊断；有副作用的不算
    return /^\s*(cat|ls|head|tail|rg|grep|find|git\s+(log|diff|show|status|blame)|npx?\s+(tsc|vitest|jest)|npm\s+(test|run\s+test))/.test(cmd)
  }
  return false
}

function textOf(tool: RuntimeToolEvent): string {
  const parts: string[] = []
  if (typeof tool.input?.pattern === 'string') parts.push(tool.input.pattern)
  if (typeof tool.input?.command === 'string') parts.push(tool.input.command)
  if (typeof tool.input?.query === 'string') parts.push(tool.input.query)
  return parts.join(' ')
}

export function createRegressionBisectHook(
  deps: RegressionBisectDeps,
): PostToolRuntimeHook & { getLoopTurns: () => number } {
  /** 已完成的「纯诊断轮」连续计数 */
  let loopTurns = 0
  /** 当前轮的观察状态 */
  let currentTurn = -1
  let turnSawDiagnosis = false
  let turnSawWrite = false
  /** 会话内是否观察到回归语义（工具输入侧，objective 侧每次现查） */
  let sawRegressionInInputs = false
  let fired = false

  function closeTurn(): void {
    if (turnSawWrite) {
      loopTurns = 0
      fired = false // 写入 = 新假设已付诸行动，断路器重臂
    } else if (turnSawDiagnosis) {
      loopTurns++
    } else {
      loopTurns = 0
    }
    turnSawDiagnosis = false
    turnSawWrite = false
  }

  const hook: PostToolRuntimeHook & { getLoopTurns: () => number } = {
    phase: 'postTool',
    name: 'regression-bisect',
    getLoopTurns() { return loopTurns },
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const turn = ctx.snapshot.turn
      if (turn !== currentTurn) {
        if (currentTurn >= 0) closeTurn()
        currentTurn = turn
      }

      if (WRITE_TOOLS.has(tool.name) && tool.success) turnSawWrite = true
      else if (isDiagnosisEvent(tool)) turnSawDiagnosis = true

      if (!sawRegressionInInputs && REGRESSION_RE.test(textOf(tool))) {
        sawRegressionInInputs = true
      }

      if (fired) return
      // 本轮进行中也计入（loopTurns 是已完成轮，+1 是当前轮）
      const effectiveLoop = loopTurns + (turnSawDiagnosis && !turnSawWrite ? 1 : 0)
      if (effectiveLoop < REGRESSION_LOOP_TURN_THRESHOLD) return

      const objective = deps.getObjective?.() ?? ''
      const regressionSemantics = sawRegressionInInputs || REGRESSION_RE.test(objective)
      if (!regressionSemantics) return

      fired = true
      deps.advisoryBus.submit({
        key: 'regression-bisect',
        priority: 0.85,
        category: 'dead_end',
        tier: 'constitutional',
        content:
          `回归排查已空转 ${effectiveLoop} 轮（只读诊断、零修改、零收敛）。停止假设式排查，切换到基线对照策略：` +
          `① \`git log --oneline -20\` 定位重构提交区间（功能在哪个提交之前还是好的）；` +
          `② 用 \`git bisect\`（或 checkpoint/rewind 的基线 diff 对照）二分定位引入回归的具体提交，` +
          `再 \`git show <commit>\` 直读该提交对相关文件的改动；` +
          `③ 若任务契约/已批准计划带「回归清单」，逐项 grep 清单锚点定位消失的功能挂在哪个文件。` +
          `回归问题的答案在提交历史里，不在猜测里。`,
        ttl: 3,
        // 采纳 = 转向 git 历史类命令（log/bisect/show/diff 基线对照）
        expect: { kind: 'tool_appears', tools: ['bash'], targetIncludes: 'git', withinTurns: 3 },
        channel: 'system-reminder',
      })
    },
  }

  return hook
}
