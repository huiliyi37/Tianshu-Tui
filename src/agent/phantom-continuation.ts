import type { TaskContract } from '../context/task-contract.js'

/**
 * Phantom continuation: detects the "model described an action but never emitted
 * a tool call" failure mode on a no-tool turn, and decides whether the loop
 * should auto-continue one more iteration instead of ending the turn.
 *
 * This generalizes the `/goal` GoalTracker auto-continue to ordinary sessions,
 * but stays strictly bounded (per-run budget) and yields to convergence /
 * doom-loop so it never fights stagnation detection.
 */

export type PhantomContinuationReason = 'contract-open' | 'action-intent' | 'none'

export interface PhantomContinuationDecision {
  shouldContinue: boolean
  reason: PhantomContinuationReason
  message: string
}

export interface PhantomContinuationInput {
  /** Visible assistant text streamed this (no-tool) turn. */
  streamedText: string
  /** Active task contract, if perception classified one for the session. */
  activeContract?: TaskContract
  /** How many times this run has already auto-continued. */
  autoContinueCount: number
  /** Per-run budget cap. 0 disables the feature entirely. */
  maxAutoContinue: number
  /** True when convergence/doom-loop already escalated this turn. */
  convergenceEscalated: boolean
}

const NO_CONTINUE: PhantomContinuationDecision = { shouldContinue: false, reason: 'none', message: '' }

/**
 * Action-promise markers ("let me…", "接下来…") that suggest the model intended
 * to act but only produced prose. Paired with a tool/action verb to avoid
 * firing on narrative summaries like "I have finished".
 */
const ACTION_PROMISE_PATTERN =
  /(让我|接下来|现在(?:就)?|下一步|稍后|我来|我去|我先|i'?ll\b|i will\b|let me\b|let's\b|going to\b|next[,，]? i|now i)/i

const TOOL_VERB_PATTERN =
  /(grep|ripgrep|read|edit|write|run|test|search|bash|cat|ls|glob|fetch|查(?:看|找|阅)?|搜索|读取?|修改|编辑|运行|执行|跑(?:一?下|测试)?|改一?下|看(?:一?下)?(?:代码|文件)?)/i

const CONTINUE_HINT =
  '[CONTINUATION] 上一回合没有实际发起任何 tool call —— 只用文本描述了打算做的操作。' +
  '如果还要继续推进任务，请直接发起对应的 tool call，不要只用文字叙述；' +
  '如果任务确实已完成，请明确给出结论而不是描述未执行的步骤。'

/**
 * Action-intent gate: the turn text must contain BOTH an action promise
 * ("let me…", "接下来…") AND a tool verb (grep/read/edit/run…). This is the
 * single source of truth shared by Layer 1 and Layer 2 — a pure-answer or
 * social turn can never match both patterns simultaneously, so it serves as
 * a stronger filter than isSocialOrTrivial on its own.
 *
 * Only the tail is inspected — the action promise (if any) sits at the end of
 * the turn, and this keeps the match cheap on long outputs.
 */
function hasActionIntent(text: string): boolean {
  const tail = text.length > 600 ? text.slice(-600) : text
  return ACTION_PROMISE_PATTERN.test(tail) && TOOL_VERB_PATTERN.test(tail)
}

/**
 * Pure decision function. Order: hard gates → contract signal (gated by
 * action-intent) → standalone action-intent heuristic.
 */
export function evaluatePhantomContinuation(
  input: PhantomContinuationInput,
): PhantomContinuationDecision {
  const { streamedText, activeContract, autoContinueCount, maxAutoContinue, convergenceEscalated } = input

  // ── Hard gates ──
  // Budget exhausted / feature disabled, convergence already steering, or an
  // empty turn (nothing to act on) → never auto-continue.
  if (maxAutoContinue <= 0) return NO_CONTINUE
  if (autoContinueCount >= maxAutoContinue) return NO_CONTINUE
  if (convergenceEscalated) return NO_CONTINUE

  const text = streamedText.trim()
  if (text.length === 0) return NO_CONTINUE

  // Action-intent gate is evaluated once and shared by both layers.
  const intent = hasActionIntent(text)

  // ── Layer 1: task-contract signal (most reliable) ──
  // An open contract warrants continuation, but ONLY when the turn text also
  // shows action intent. Without this gate, pure-answer turns (user asks a
  // question mid-task, agent answers correctly without a tool call) get
  // force-continued because the contract is still open — producing phantom
  // "continuation" noise after every conversational reply.
  if (
    intent &&
    activeContract &&
    activeContract.isActionable &&
    activeContract.status !== 'ready_to_deliver' &&
    activeContract.status !== 'blocked'
  ) {
    return { shouldContinue: true, reason: 'contract-open', message: CONTINUE_HINT }
  }

  // ── Layer 2: action-intent heuristic (fallback when no contract signal) ──
  if (intent) {
    return { shouldContinue: true, reason: 'action-intent', message: CONTINUE_HINT }
  }

  return NO_CONTINUE
}
