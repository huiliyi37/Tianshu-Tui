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

/**
 * Options for {@link createFileContentArgProcessor} — the common "single large
 * text field → file pointer" pattern shared by tools whose `execute` persists
 * the field to a known on-disk path (e.g. write_file.content → file_path,
 * plan_submit.plan → .rivet/plans/{slug}.md).
 */
export interface FileContentArgProcessorOptions {
  toolName: string
  /** Name of the parsed-args field that holds the large text payload. */
  contentField: string
  /** Replacement always starts with this — used for the idempotency check. */
  pointerPrefix: string
  /** Min content length (chars) to trigger replacement. 0 = always replace. */
  threshold: number
  /** Resolve the on-disk path the content is/will-be persisted to. null = skip. */
  resolvePath: (parsed: Record<string, unknown>) => string | null
  /** Render the pointer string that replaces the content field. */
  render: (info: { path: string; lines: number; chars: number }) => string
}

/**
 * Build a {@link ToolArgProcessor} that replaces one large text field with a
 * file pointer. The original field is left untouched on `block.input` (the
 * processor only sees the stringified arguments), so the tool's `execute` still
 * receives the full content to write. The on-disk file is the single source of
 * truth; later turns read it back via read_file.
 */
export function createFileContentArgProcessor(opts: FileContentArgProcessorOptions): ToolArgProcessor {
  return {
    toolName: opts.toolName,
    process(args: string): string | null {
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(args) } catch { return null }

      const content = parsed[opts.contentField]
      if (typeof content !== 'string' || content.length === 0) return null
      // Idempotent: already replaced.
      if (content.startsWith(opts.pointerPrefix)) return null
      // Threshold gate: leave small payloads inline (avoid read-back reflux).
      if (opts.threshold > 0 && content.length < opts.threshold) return null

      const path = opts.resolvePath(parsed)
      if (typeof path !== 'string' || path.length === 0) return null

      const chars = content.length
      const lines = content.split('\n').length
      return JSON.stringify({
        ...parsed,
        [opts.contentField]: opts.render({ path, lines, chars }),
      })
    },
  }
}
