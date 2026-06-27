/**
 * Worker 活动事件的语义化标签。
 *
 * 取代 worker-activity-stream.ts 中的 activityProgressLine，
 * 生成更简洁的中文活动短语。去掉 deltas 计数——
 * 用户不需要知道「已输出 3300 个 token」，只需要知道「还在写」。
 */

import type { WorkerActivityEvent } from '../../agent/coordinator.js'

/** 思考态词池——每次 thinking 事件轮换，单次推理中闪现不同表达 */
const THINKING_WORDS = [
  '思索中', '推演中', '琢磨中', '梳理中', '求索中', '沉淀中',
] as const

/** 写作态词池——每次 text 事件轮换 */
const WRITING_WORDS = [
  '写作中', '编织中', '打磨中', '雕琢中', '运笔中', '落墨中',
] as const

/** 工具完成态词池 */
const TOOL_DONE_WORDS = [
  '工具完成', '执行完毕', '调用返回', '操作就绪',
] as const

let _thinkIdx = 0
let _writeIdx = 0
let _toolIdx = 0

/** 活动状态短语：供 fleet 面板在 activity 字段显示。同一轮推理中每次事件轮换不同中文词。 */
export function activityPhrase(event: WorkerActivityEvent): string {
  switch (event.kind) {
    case 'tool_use': {
      const tool = event.detail?.slice(0, 40)
      return tool ? `调用 ${tool}` : '调用工具'
    }
    case 'tool_result':
      _toolIdx = (_toolIdx + 1) % TOOL_DONE_WORDS.length
      return TOOL_DONE_WORDS[_toolIdx]!
    case 'thinking':
      _thinkIdx = (_thinkIdx + 1) % THINKING_WORDS.length
      return THINKING_WORDS[_thinkIdx]!
    default:
      _writeIdx = (_writeIdx + 1) % WRITING_WORDS.length
      return WRITING_WORDS[_writeIdx]!
  }
}
