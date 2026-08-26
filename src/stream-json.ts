import type { Usage } from './api/types.js'
import { truncateUtf16Safe } from './server/redact.js'

/**
 * NDJSON event protocol for `rivet -p --stream-json`. One JSON object per line.
 * Aligned with Claude Code stream-json conventions: a `system/init` envelope
 * opens the run, a `result` envelope closes it, and per-event objects carry a
 * `type` discriminator.
 *
 * BACKWARD COMPAT: text_delta / tool_use / tool_result / turn_complete keep
 * their exact original field shape — existing downstream parsers must not break.
 * New event types (system, result, worker, phase, thinking) are additive.
 */
export type StreamJsonEvent =
  | { type: 'system'; subtype: 'init'; session_id: string; model: string; cwd: string; tools?: string[] }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: string; isError: boolean; truncated?: boolean }
  | { type: 'phase'; phase: string; tool?: string; reason?: string }
  | {
      type: 'worker'
      work_order_id: string
      parent_tool_id: string
      /** 'passed' 是 2026-08-26 词汇统一前的历史值（新 CLI 只发 'completed'，
       *  headless 直传 DelegationActivity.status）——为解析旧录制流保留，
       *  勿当死代码清理。 */
      status: 'running' | 'passed' | 'completed' | 'failed' | 'blocked' | 'escalated'
      profile?: string
      authority?: string
      objective?: string
      progress_line?: string
      tool_use_count?: number
      token_count?: number
      model?: string
      failure_reason?: string
    }
  | { type: 'turn_complete'; usage: Partial<Usage>; turn?: number; is_final?: boolean }
  | { type: 'error'; error: string }
  | {
      type: 'result'
      subtype: 'success' | 'error'
      session_id: string
      is_error: boolean
      result: string
      usage?: Partial<Usage>
    }

/** Result-field truncation cap. RIVET_STREAM_RESULT_MAX overrides; 0 = unlimited.
 *  Default 8000 (up from the old hard 500) — enough for real tool output while
 *  bounding a runaway dump. */
export function resultMaxLen(): number {
  const raw = process.env.RIVET_STREAM_RESULT_MAX
  if (raw === undefined || raw === '') return 8000
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : 8000
}

/** Serialize one event to a single NDJSON line (trailing \n included). */
export function serializeEvent(ev: StreamJsonEvent): string {
  let payload: Record<string, unknown> = ev
  if (ev.type === 'tool_result') {
    const cap = resultMaxLen()
    if (cap > 0 && ev.result.length > cap) {
      // truncateUtf16Safe：slice 可劈开代理对，下游渲染成替换符。
      payload = { ...ev, result: truncateUtf16Safe(ev.result, cap), truncated: true }
    }
  }
  return JSON.stringify(payload) + '\n'
}
