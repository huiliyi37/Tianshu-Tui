import type { WorkerActivityEvent } from '../agent/coordinator.js'

/** Shorten a work order id to a human label: "wo_team:T1" → "T1". */
export function shortOrderLabel(workOrderId: string): string {
  const seg = workOrderId.split(':').pop() ?? workOrderId
  return seg.replace(/^wo_/, '').slice(0, 12)
}

/** 思考态词池 — 每次 thinking 事件轮换，单次推理中闪现不同表达 */
const THINK_WORDS = ['思索中', '推演中', '琢磨中', '梳理中', '求索中', '沉淀中'] as const
/** 写作态词池 */
const WRITE_WORDS = ['写作中', '编织中', '打磨中', '雕琢中', '运笔中', '落墨中'] as const
/** 工具完成态词池 */
const DONE_WORDS = ['完成', '就绪', '返回', '收束'] as const

let _thinkIdx = 0
let _writeIdx = 0
let _doneIdx = 0

/**
 * One concise progress line for a worker activity event, for the structured
 * subagent fleet panel. Uses semantic Chinese labels — cycling through a word
 * pool so a single inference shows varied phrasing instead of repeating the same word.
 */
export function activityProgressLine(event: WorkerActivityEvent): string {
  if (event.kind === 'tool_use') return `⚙ ${event.detail ? event.detail.slice(0, 60) : '调用工具'}`
  if (event.kind === 'tool_result') {
    _doneIdx = (_doneIdx + 1) % DONE_WORDS.length
    return `✓ ${event.detail ? event.detail.slice(0, 50) : DONE_WORDS[_doneIdx]!}`
  }
  if (event.kind === 'thinking') {
    _thinkIdx = (_thinkIdx + 1) % THINK_WORDS.length
    return THINK_WORDS[_thinkIdx]!
  }
  _writeIdx = (_writeIdx + 1) % WRITE_WORDS.length
  return WRITE_WORDS[_writeIdx]!
}

/**
 * T9 P3 实时上行: convert raw worker activity events into a bounded stream of
 * progress lines for the live tool card.
 *
 * V2 改进：
 * - text 心跳不再输出 deltas 计数行（用户不需要 token 吞吐量）
 * - 首次 text 只输出一次「写作中」，之后静默
 * - tool_use / tool_result 始终输出（一行一条）
 */
export function createActivityStreamer(
  emit: (line: string) => void,
  _opts?: { textEvery?: number },
): (event: WorkerActivityEvent) => void {
  const textSeen = new Set<string>()

  return (event: WorkerActivityEvent) => {
    const label = `${shortOrderLabel(event.workOrderId)}·${event.profile}`
    if (event.kind === 'tool_use') {
      const toolDetail = event.detail ? ` ${event.detail.slice(0, 60)}` : ''
      emit(`  ↳ [${label}] ⚙${toolDetail}\n`)
      return
    }
    if (event.kind === 'tool_result') {
      const resultHint = event.detail ? ` (${event.detail.slice(0, 40)})` : ''
      emit(`  ↳ [${label}] ✓ 完成${resultHint}\n`)
      return
    }
    // text / thinking: 首次输出状态行，之后静默——避免 deltas 计数刷屏
    if (!textSeen.has(event.workOrderId)) {
      textSeen.add(event.workOrderId)
      const glyph = event.kind === 'thinking' ? '思考中' : '写作中'
      emit(`  ↳ [${label}] ✎ ${glyph}\n`)
    }
  }
}
