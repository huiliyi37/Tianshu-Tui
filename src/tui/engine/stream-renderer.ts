/**
 * T9 StreamRenderer — 流式 Markdown 增量渲染（Claude Code StreamingMarkdown 模型）。
 *
 * 职责：
 * - 接收 BlockStreamWriter 吐出的节流文本块，累积到 pending 缓冲区。
 * - 在「最后一个稳定的顶层 block 边界」切分：空行结束的段落、闭合的 ``` 围栏。
 * - 稳定前缀立即经 formatMarkdown 渲染后 commit 到 scrollback（不可回退）。
 * - 尾部不完整 block 留在 pending，由 live 区以原始文本渲染（display-width
 *   aware tail-cap，避免 CJK 宽字符截断错位）。
 * - 围栏代码块流式期间不解析高亮（防闪烁）：未闭合的 ``` 内容停留在 pending，
 *   闭合后整块作为稳定前缀高亮 commit。
 *
 * 数据流：
 *   onTextDelta → BlockStreamWriter（节流）→ StreamRenderer.push
 *     ├── 稳定 block → formatMarkdown → commit(scrollback)
 *     └── 尾部不完整 block → getLiveTail → LiveEngine 底部重绘
 */

import { formatMarkdown } from '../format/markdown.js'
import { capLiveTailMarkdownSafe } from '../live-tail-cap.js'
import type { RivetTheme } from '../theme.js'

/**
 * 找到文本中最后一个稳定的顶层 block 边界（fence-aware）。
 *
 * 边界定义（均为「该行结尾、含换行符」的 offset）：
 * - 围栏外的空行（段落/列表/标题等 block 在空行处结束）
 * - 闭合的 ``` 围栏行（整个代码块完整，可安全高亮）
 *
 * 围栏内部的空行不算边界（代码块未闭合时不可切分）。
 * 最后一行（可能无尾随换行、仍在增长）永不参与判定。
 *
 * @returns 切割 offset；0 表示尚无稳定边界
 */
export function findStableBoundary(text: string): number {
  let inFence = false
  let lastBoundary = 0
  let offset = 0
  const lines = text.split('\n')

  // lines.length - 1: 最后一段（split 后的尾元素）要么是不完整的行，
  // 要么是空字符串（文本以 \n 结尾）——都不参与边界判定。
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!
    const lineEnd = offset + line.length + 1 // 含 '\n'
    if (line.startsWith('```')) {
      inFence = !inFence
      if (!inFence) lastBoundary = lineEnd // 围栏闭合 → 代码块完整
    } else if (!inFence && line.trim() === '') {
      lastBoundary = lineEnd // 围栏外空行 → 上方 block 完整
    }
    offset = lineEnd
  }
  return lastBoundary
}

export interface StreamRendererOptions {
  /** 将渲染好的 ANSI 多行文本 commit 到 scrollback */
  commit: (ansi: string) => void
  /** 终端列数（动态读取，resize 安全） */
  getColumns: () => number
  /** 主题读取函数（动态，切主题后新 block 立即生效） */
  getTheme: () => RivetTheme
}

export class StreamRenderer {
  private pending = ''
  private committedAny = false
  private readonly options: StreamRendererOptions

  constructor(options: StreamRendererOptions) {
    this.options = options
  }

  /** 是否已有任何内容 commit 到 scrollback（用于 header 等一次性输出判定） */
  get hasCommitted(): boolean {
    return this.committedAny
  }

  /** 是否持有任何内容（pending 或已 commit） */
  get hasContent(): boolean {
    return this.committedAny || this.pending.length > 0
  }

  /** 当前未 commit 的尾部文本 */
  get pendingText(): string {
    return this.pending
  }

  /** 累积流式文本块，commit 所有新出现的稳定前缀 */
  push(chunk: string): void {
    if (!chunk) return
    this.pending += chunk
    const cut = findStableBoundary(this.pending)
    if (cut > 0) {
      const stable = this.pending.slice(0, cut)
      this.pending = this.pending.slice(cut)
      this.commitText(stable)
    }
  }

  /**
   * 流结束：把剩余 pending 全部渲染 commit。
   * @returns 本轮是否输出过任何内容
   */
  finalize(): boolean {
    if (this.pending.trim().length > 0) {
      this.commitText(this.pending)
    }
    this.pending = ''
    const had = this.committedAny
    this.committedAny = false
    return had
  }

  /** 丢弃所有状态（abort 场景） */
  reset(): void {
    this.pending = ''
    this.committedAny = false
  }

  /**
   * live 区尾部行：原始文本（不做 markdown 解析，防未闭合围栏闪烁），
   * display-width aware 截断到 maxRows 显示行。
   *
   * `extraTail` 为尚未吐块的最新缓冲（BlockStreamWriter.peek()）——拼在
   * pending 之后一起截断，使最新 token 逐字可见（打字机节奏），无需等 blockWriter
   * 吐块。截断对合并文本整体生效，保证不超视口 / CJK 宽度正确。
   */
  getLiveTailLines(maxRows: number, extraTail = ''): string[] {
    const tail = this.pending + extraTail
    if (!tail) return []
    const capped = capLiveTailMarkdownSafe(tail, this.options.getColumns(), maxRows)
    return capped ? capped.split('\n') : []
  }

  private commitText(text: string): void {
    const trimmed = text.replace(/\n+$/, '')
    if (!trimmed.trim()) return
    const rendered = formatMarkdown(
      { text: trimmed, columns: this.options.getColumns() },
      this.options.getTheme(),
    )
    if (rendered.length === 0) return
    this.options.commit(rendered.join('\n'))
    this.committedAny = true
  }
}
