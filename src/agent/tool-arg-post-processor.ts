/**
 * Tool Argument Post-Processor — intercepts tool_call arguments before they
 * enter oaiMessages, replacing large fields (e.g. plan_submit.plan) with file
 * pointers to prevent context bloat.
 *
 * SAFETY INVARIANTS:
 * 1. Only transforms the `function.arguments` string — never touches `id`,
 *    `type`, `function.name`, or the original `block.input` object.
 * 2. Return value must be valid JSON or null (null = no replacement).
 * 3. Idempotent — re-processing an already-processed args returns null.
 * 4. Fail-open — processor exceptions are swallowed, original args retained.
 */

import type { OaiToolCall } from '../api/oai-types.js'

export interface ToolArgProcessor {
  toolName: string
  /**
   * Transform the arguments JSON string of a tool call.
   * Returns replacement JSON string, or null to keep original.
   * Must never throw — callers wrap in try/catch as a safety net.
   */
  process(args: string): string | null
}

/** Singleton registry — one instance per agent session. */
export class ToolArgPostProcessorRegistry {
  private processors = new Map<string, ToolArgProcessor>()

  register(processor: ToolArgProcessor): void {
    this.processors.set(processor.toolName, processor)
  }

  has(name: string): boolean {
    return this.processors.has(name)
  }

  /**
   * Process an array of OaiToolCalls in-place-safe manner.
   * Returns the same array if nothing changed, or a new array with
   * replaced arguments. Never mutates the original OaiToolCall objects —
   * creates shallow copies with replaced `function.arguments`.
   */
  processToolCalls(calls: OaiToolCall[]): OaiToolCall[] {
    if (calls.length === 0) return calls
    let changed = false
    const result = calls.map(tc => {
      const processor = this.processors.get(tc.function.name)
      if (!processor) return tc
      try {
        const newArgs = processor.process(tc.function.arguments)
        if (newArgs !== null && newArgs !== tc.function.arguments) {
          changed = true
          return {
            ...tc,
            function: { ...tc.function, arguments: newArgs },
          }
        }
      } catch {
        // processor failed — keep original (fail-open)
      }
      return tc
    })
    return changed ? result : calls
  }
}
