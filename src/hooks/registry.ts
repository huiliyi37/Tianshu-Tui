import type {
  HookEvent, HookHandler, PreToolUseInput, PostToolUseInput,
  NotificationInput, SubagentStopInput, PreToolUseResult, PostToolUseResult,
} from './types.js'

type AnyHandler = HookHandler<HookEvent>

export class HookRegistry {
  private handlers = new Map<HookEvent, Set<AnyHandler>>()

  register<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set())
    }
    this.handlers.get(event)!.add(handler as unknown as AnyHandler)
  }

  unregister<E extends HookEvent>(event: E, handler: HookHandler<E>): void {
    this.handlers.get(event)?.delete(handler as unknown as AnyHandler)
  }

  firePreToolUse(input: PreToolUseInput): PreToolUseResult {
    const handlers = this.handlers.get('PreToolUse')
    if (!handlers || handlers.size === 0) return { input: input.input }

    let current = input
    for (const handler of handlers) {
      const result = (handler as HookHandler<'PreToolUse'>)(current)
      if (result.block) {
        return { block: true, reason: result.reason }
      }
      if (result.input) {
        current = { ...current, input: result.input }
      }
    }
    return { input: current.input }
  }

  firePostToolUse(input: PostToolUseInput): PostToolUseResult {
    const handlers = this.handlers.get('PostToolUse')
    if (!handlers || handlers.size === 0) return {}

    let current = input
    for (const handler of handlers) {
      const result = (handler as HookHandler<'PostToolUse'>)(current)
      if (result.result) {
        current = { ...current, result: result.result }
      }
    }
    return { result: current.result }
  }

  fireNotification(input: NotificationInput): void {
    const handlers = this.handlers.get('Notification')
    if (!handlers) return
    for (const handler of handlers) {
      (handler as HookHandler<'Notification'>)(input)
    }
  }

  fireSubagentStop(input: SubagentStopInput): void {
    const handlers = this.handlers.get('SubagentStop')
    if (!handlers) return
    for (const handler of handlers) {
      (handler as HookHandler<'SubagentStop'>)(input)
    }
  }

  clear(): void {
    this.handlers.clear()
  }
}
