export interface BlockStreamConfig {
  minChars: number
  maxChars: number
  idleMs: number
  maxBufferSize: number
}

const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 100,
  maxChars: 200,
  idleMs: 180,
  maxBufferSize: 64 * 1024,
}

/** 句末标点（中英文）。拆成数组用 lastIndexOf 逐个定位，避免逐字符 includes 的 O(n²)。 */
const SENTENCE_ENDS = ['。', '！', '？', '.', '!', '?', '；', ';']

export class BlockStreamWriter {
  private buffer = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sending: Promise<void> = Promise.resolve()
  private readonly config: BlockStreamConfig
  private readonly onBlock: (text: string) => void
  private hasEmitted = false

  constructor(config: Partial<BlockStreamConfig>, onBlock: (text: string) => void) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.onBlock = onBlock
  }

  push(chunk: string): void {
    if (!chunk) return
    this.buffer += chunk
    this.enforceBufferLimit()
    this.resetIdleTimer()
    this.checkEmit()
  }

  async flush(): Promise<void> {
    this.clearIdleTimer()
    if (!this.buffer) return
    const text = this.buffer
    this.buffer = ''
    this.enqueue(text)
    await this.sending
  }

  /** Drop buffered text WITHOUT emitting. Used when a stale run never
   *  finalized (e.g. abort, maxTurns exhaustion) and a new run is starting —
   *  flushing here would paint the previous run's leftover text into the
   *  new run's output. */
  discard(): void {
    this.clearIdleTimer()
    this.buffer = ''
  }

  /** The text received but not yet emitted as a block — i.e. the live tail.
   *  Structurally bounded by maxChars/maxBufferSize, so it stays small enough
   *  to render in the live region without exceeding the viewport (真凶②). */
  peek(): string {
    return this.buffer
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => { this.flush() }, this.config.idleMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private checkEmit(): void {
    const minChars = this.hasEmitted ? this.config.minChars : 15
    if (this.buffer.length < minChars) return
    this.hasEmitted = true

    if (this.buffer.length >= this.config.maxChars) {
      const pos = this.findBreakPoint(this.buffer, this.config.maxChars)
      const block = this.buffer.slice(0, pos)
      this.buffer = this.buffer.slice(pos)
      this.enqueue(block)
      if (this.buffer.length >= this.config.maxChars) {
        this.checkEmit()
      }
      return
    }

    const paraIdx = this.buffer.lastIndexOf('\n\n')
    if (paraIdx !== -1 && paraIdx >= Math.floor(this.config.minChars * 0.5)) {
      const block = this.buffer.slice(0, paraIdx + 2)
      this.buffer = this.buffer.slice(paraIdx + 2)
      this.enqueue(block)
      return
    }

    const sentIdx = this.findSentenceEnd(this.buffer)
    if (sentIdx !== -1) {
      const block = this.buffer.slice(0, sentIdx + 1)
      this.buffer = this.buffer.slice(sentIdx + 1)
      this.enqueue(block)
    }
  }

  private enforceBufferLimit(): void {
    if (this.buffer.length <= this.config.maxBufferSize) return

    while (this.buffer.length > this.config.maxBufferSize) {
      const pos = this.findBreakPoint(this.buffer, Math.min(this.config.maxChars, this.buffer.length))
      // Structural guarantee that the buffer shrinks every iteration. If a
      // misconfig (e.g. maxChars <= 0) or a degenerate window ever made
      // findBreakPoint return 0, `slice(0)` would leave the buffer unchanged
      // and this while loop would spin forever at 100% CPU — the same
      // non-advancing-loop class that froze the TUI via parseBlocks. Force at
      // least one char of progress so termination never depends on config.
      const cut = pos > 0 ? pos : Math.min(this.config.maxChars > 0 ? this.config.maxChars : 1, this.buffer.length)
      const block = this.buffer.slice(0, cut)
      this.buffer = this.buffer.slice(cut)
      this.enqueue(block)
    }
  }

  private findBreakPoint(text: string, maxPos: number): number {
    const para = text.lastIndexOf('\n\n', maxPos)
    if (para !== -1 && para > Math.floor(maxPos * 0.3)) return para + 2
    const nl = text.lastIndexOf('\n', maxPos)
    if (nl !== -1 && nl > Math.floor(maxPos * 0.3)) return nl + 1
    const sp = text.lastIndexOf(' ', maxPos)
    if (sp !== -1 && sp > Math.floor(maxPos * 0.3)) return sp + 1
    return maxPos
  }

  private findSentenceEnd(text: string): number {
    // 句末标点（中英文）：。！？.!?；; 取最后一个出现位置作为切点。
    // 旧实现 for + includes 是 O(n²)（includes 每字符扫描标点表）；这里用 lastIndexOf
    // 逐标点取最大下标，常数次 O(n) 调用，消除高吞吐流式下的二次扫描。
    let last = -1
    for (const end of SENTENCE_ENDS) {
      const idx = text.lastIndexOf(end)
      if (idx > last) last = idx
    }
    return last
  }

  private enqueue(text: string): void {
    this.onBlock(text)
  }
}
