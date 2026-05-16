export interface BlockStreamConfig {
  minChars: number
  maxChars: number
  idleMs: number
}

const DEFAULT_CONFIG: BlockStreamConfig = {
  minChars: 100,
  maxChars: 600,
  idleMs: 500,
}

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

  private enqueue(text: string): void {
    this.onBlock(text)
  }
}
