/**
 * Agent event tap — turns an `AgentCallbacks` set into a stream of
 * `SessionEvent`s without changing what the wrapped callbacks do.
 *
 * WHY THIS SHAPE: the sidecar already emits `SessionEvent` (protocol.ts) and
 * `rivet attach` already speaks it over `GET /sessions/:id/events?since=`. A
 * second "TUI event schema" would mean translating at the attach boundary
 * forever, so the TUI produces the same records instead of a dialect of them.
 * Field names here are copied from session-manager's own append sites — drift
 * in a key name silently breaks every consumer that handles both sources.
 *
 * WHY THE CALLBACK LAYER, not the renderer: these are semantic events, and
 * their source is the agent loop, not the screen. Emitting from the render path
 * would put JSON assembly inside the 16ms frame budget for no gain.
 *
 * The tap is a decorator, not a replacement: every wrapped callback is invoked
 * with the original arguments and its return value is passed through untouched.
 * A throwing sink must never take down a run, so emission is isolated.
 */

import type { SessionEvent, SessionEventType } from '../server/protocol.js'
import { redactValue, redactText, truncateUtf16Safe } from '../server/redact.js'
import type { AgentCallbacks } from './loop-types.js'

/** Matches the sidecar's per-event result cap. */
const RESULT_CAP = 2000

/**
 * Flush threshold for coalesced text. Deltas arrive per-token; one line per
 * delta would make the stream unreadable and unusable with `jq`.
 */
const DELTA_FLUSH_CHARS = 4000

export type EventSink = (event: SessionEvent) => void

export interface EventTapHandle {
  /** Emit any buffered text as its event. Idempotent; safe to call at shutdown. */
  flush: () => void
}

/**
 * Wrap `inner` so that every observable agent activity also reaches `sink`.
 *
 * Optional callbacks are only wrapped when `inner` actually defines them:
 * materializing e.g. `onSteerDrain` on a set that did not have it changes
 * behavior for callers that branch on its presence.
 */
export function tapAgentCallbacks(
  inner: AgentCallbacks,
  sink: EventSink,
): AgentCallbacks & EventTapHandle {
  let seq = 0
  let pending: { type: 'text_delta' | 'thinking_delta'; text: string } | null = null

  const write = (type: SessionEventType, data: Record<string, unknown>): void => {
    seq += 1
    try {
      sink({ seq, ts: Date.now(), type, data })
    } catch {
      // A broken sink (full disk, closed fd) is not a reason to kill the run.
    }
  }

  const flush = (): void => {
    if (!pending) return
    const buf = pending
    pending = null
    write(buf.type, { text: buf.text })
  }

  /** Every non-delta event flushes first, so the stream stays in causal order. */
  const emit = (type: SessionEventType, data: Record<string, unknown>): void => {
    flush()
    write(type, data)
  }

  const delta = (type: 'text_delta' | 'thinking_delta', text: string): void => {
    if (!text) return
    if (pending && pending.type !== type) flush()
    pending = { type, text: (pending?.text ?? '') + text }
    if (pending.text.length >= DELTA_FLUSH_CHARS) flush()
  }

  const tapped: AgentCallbacks & EventTapHandle = {
    ...inner,
    flush,

    onTextDelta: (text) => {
      delta('text_delta', redactText(text))
      inner.onTextDelta(text)
    },
    onThinkingDelta: (thinking) => {
      delta('thinking_delta', redactText(thinking))
      inner.onThinkingDelta(thinking)
    },
    onToolUse: (id, name, input) => {
      emit('tool_use', { id, name, input: redactValue(input) })
      inner.onToolUse(id, name, input)
    },
    onToolResult: (id, name, result, isError, rawPath, uiContent) => {
      // isError === undefined marks a streaming chunk rather than the tool's
      // verdict; only terminal results become events (same filter the sidecar
      // applies, otherwise one chatty tool floods the stream).
      if (isError !== undefined) {
        emit('tool_result', {
          id,
          name,
          isError: !!isError,
          result: truncateUtf16Safe(redactText(result), RESULT_CAP),
        })
      }
      inner.onToolResult(id, name, result, isError, rawPath, uiContent)
    },
    onTurnComplete: (usage, turnNumber, isFinal, evidenceSummary) => {
      emit('turn_complete', { usage, turnNumber, isFinal: !!isFinal })
      inner.onTurnComplete(usage, turnNumber, isFinal, evidenceSummary)
    },
    onError: (error) => {
      emit('error', { error: redactText(error.message) })
      inner.onError(error)
    },
    onAbort: (reason) => {
      emit('status', { status: 'aborted', ...(reason ? { reason } : {}) })
      inner.onAbort(reason)
    },
    onApprovalRequired: async (id, name, input) => {
      emit('approval_required', { requestId: id, toolName: name, input: redactValue(input) })
      const result = await inner.onApprovalRequired(id, name, input)
      const approved = typeof result === 'boolean' ? result : result.approved
      emit('approval_resolved', { requestId: id, decision: approved ? 'approve' : 'reject' })
      return result
    },
  }

  if (inner.onCheckpoint) {
    const fn = inner.onCheckpoint.bind(inner)
    tapped.onCheckpoint = (hash) => { emit('checkpoint', { hash }); fn(hash) }
  }
  if (inner.onPhaseChange) {
    const fn = inner.onPhaseChange.bind(inner)
    tapped.onPhaseChange = (phase, detail) => { emit('phase', { phase, ...(detail ?? {}) }); fn(phase, detail) }
  }
  if (inner.onIntentNote) {
    const fn = inner.onIntentNote.bind(inner)
    tapped.onIntentNote = (intent) => {
      emit('intent_note', redactValue(intent) as Record<string, unknown>)
      fn(intent)
    }
  }
  if (inner.onDecisionShift) {
    const fn = inner.onDecisionShift.bind(inner)
    tapped.onDecisionShift = (shift) => {
      emit('decision_shift', redactValue(shift) as Record<string, unknown>)
      fn(shift)
    }
  }
  if (inner.onDomainDrift) {
    const fn = inner.onDomainDrift.bind(inner)
    tapped.onDomainDrift = (drift) => {
      emit('domain_drift', redactValue(drift) as Record<string, unknown>)
      fn(drift)
    }
  }
  if (inner.onDelegationActivity) {
    const fn = inner.onDelegationActivity.bind(inner)
    // 投影与 session-manager.appendDelegation 逐字段对齐（含 workerId/parentId
    // 键名与 phase/elapsedMs 派生）——attach 流与 sidecar SSE 被同一批客户端
    // 消费，键名漂移会静默拆掉双源消费者。elapsedMs 的起算表与 sidecar 同形。
    const delegationStartedAt = new Map<string, number>()
    tapped.onDelegationActivity = (a) => {
      let started = delegationStartedAt.get(a.workOrderId)
      if (started === undefined) {
        started = Date.now()
        delegationStartedAt.set(a.workOrderId, started)
      }
      emit('delegation', {
        workerId: a.workOrderId,
        parentId: a.parentToolId,
        // 嵌套委派的父 worker order id（与 sidecar emitDelegationActivity 对齐）。
        parentWorkerId: a.parentWorkerId,
        profile: a.profile,
        authority: a.authority,
        authorityReason: a.authorityReason,
        objective: a.objective,
        status: a.status,
        phase: a.status === 'running' ? 'running' : a.status,
        progressLine: a.progressLine ? redactText(a.progressLine) : undefined,
        elapsedMs: Date.now() - started,
        toolUseCount: a.toolUseCount,
        tokenCount: a.tokenCount,
        eventKind: a.eventKind,
        eventDetail: a.eventDetail ? redactText(a.eventDetail) : undefined,
        failureReason: a.failureReason,
        model: a.model,
        provider: a.provider,
        usage: a.usage,
        artifactId: a.artifactId,
        changedFiles: a.changedFiles,
        summary: a.summary ? redactText(a.summary) : undefined,
        origin: a.origin,
        contract: a.contract,
        findingsCount: a.findingsCount,
        topFinding: a.topFinding ? redactText(a.topFinding) : undefined,
        verificationBrief: a.verificationBrief,
        evidenceStatus: a.evidenceStatus,
      })
      fn(a)
    }
  }

  return tapped
}
