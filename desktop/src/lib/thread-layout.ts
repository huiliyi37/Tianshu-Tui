import type { ConvoBlock } from '../state/event-reducer'

/**
 * Virtualizer 初始行高估计。
 *
 * 给不同 block kind 更贴近真实尺寸的初始值，减少首次渲染/滚动时的
 * 高度跳变；工具行用较小的稳定值，避免长工具结果展开时从过大估计
 * 突然收缩造成视觉跳动。
 */
export function estimateBlockSize(block: ConvoBlock): number {
  switch (block.kind) {
    case 'user':
    case 'steer':
      return 80
    case 'assistant':
      return 90
    case 'tool':
    case 'result':
      return 44
    case 'thinking':
      return 40
    case 'phase':
    case 'turn':
      return 28
    case 'error':
      return 60
    case 'decision_shift':
      return 70
    case 'checkpoint':
      return 32
    default:
      return 60
  }
}

/**
 * Timeline 是把多个紧凑 block 合并成的一行/一组。
 *  estimateSize 对它需要单独估计，避免访问不存在的 `block` 字段。
 */
export function estimateTimelineSize(items: ConvoBlock[]): number {
  if (items.length === 0) return 44
  // 时间线头部 + 每个紧凑项约 28px
  return 28 + items.length * 28
}
