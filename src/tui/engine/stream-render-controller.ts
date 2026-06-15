/**
 * Stream render state manager — holds the 4 streaming/ticker/header state
 * fields extracted from TuiApp (W-B3). Ticker lifecycle management, render
 * orchestration, and commit logic stay in TuiApp; this class only manages
 * the scalar state values.
 *
 * Note: blockWriter (BlockStreamWriter) and streamRenderer (StreamRenderer)
 * are constructor-initialized complex objects with closure bindings — they
 * stay in TuiApp per the established extraction pattern.
 */
export class StreamRenderController {
  /** 渲染 ticker（streaming/thinking 时 120ms 驱动 spinner，idle 停止） */
  ticker: ReturnType<typeof setInterval> | null = null
  /** 单调递增的渲染 tick（spinner 帧） */
  tick = 0
  /** 最近收到 token/输出的时间戳（stall 检测） */
  lastActivityMs = 0
  /** 本段流式输出是否已 commit 过 `▍ Rivet` header */
  assistantHeaderDone = false
}
