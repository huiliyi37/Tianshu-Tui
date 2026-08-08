import type { AdvisoryBus } from '../advisory-bus.js'
import type { PostToolRuntimeHook, RuntimeToolEvent } from '../runtime-hooks.js'

/** 太一域洞察机制化（2026-08-07 会话复盘落地）：
 *  诊断轮连续 ≥3 个只读工具而零探针 → 提示「30 秒探针能否杀死当前假设」。
 *  探针是推理的校验器：推理生成假设，探针验证或杀死它——红灯比继续推演
 *  更快逼近根因（symlink 越界 / C→R 折叠均靠探针红灯定位）。
 *  冷却：同源 advisory 注入后 COOLDOWN_CALLS 次工具调用内不重复（防狂轰滥炸）。 */

export interface ProbeDisciplineDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** 只读取证工具——探针分级的「只读」判定集。写/跑测试/执行类不算。 */
const READONLY_TOOLS = new Set([
  'read_file', 'read_section', 'grep', 'glob', 'ast_grep', 'repo_map', 'repo_graph',
  'semantic_search', 'recall', 'memory', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'git',
])

/** 连续只读触发阈值：3 轮给足取证空间（正常定位常 1-2 轮读就够）。 */
const PROBE_THRESHOLD = 3
/** 注入冷却：同类型 advisory 至少间隔 8 次工具调用。 */
const COOLDOWN_CALLS = 8

export function createProbeDisciplineHook(deps: ProbeDisciplineDeps): PostToolRuntimeHook {
  let readStreak = 0
  let callsSinceLastInject = COOLDOWN_CALLS + 1

  return {
    phase: 'postTool',
    name: 'probe-discipline',
    async run(_ctx: unknown, tool: RuntimeToolEvent): Promise<void> {
      callsSinceLastInject++
      if (READONLY_TOOLS.has(tool.name)) {
        readStreak++
      } else {
        // 写/验证/执行类动作打破只读串——不是取证停滞。
        readStreak = 0
      }
      if (readStreak >= PROBE_THRESHOLD && callsSinceLastInject >= COOLDOWN_CALLS) {
        callsSinceLastInject = 0
        deps.advisoryBus.submit({
          key: `probe-discipline-${Date.now()}`,
          priority: 0.5,
          category: 'discipline',
          tier: 'operational',
          content: `【太一·探针】已连续 ${readStreak} 轮只读取证。30 秒探针（最小复现 / 一行 tsx -e）能杀死当前最可能的假设吗？红灯比继续推演更快逼近根因；假设不可测（缺 key/缺环境）才降级纯推理并标注未验证。`,
          ttl: 2,
          channel: 'system-reminder',
        })
      }
    },
  }
}
