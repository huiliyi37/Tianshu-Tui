import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import { classifyFailure, isTransient } from './failure-classifier.js'
import {
  buildBlockedWorkerResult,
  clampWorkerMaxTurns,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt } from './worker-prompts.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import type { WorkerMailbox } from './worker-mailbox.js'
import { createWorkerMailboxSender } from './worker-mailbox.js'

/** Max transient-retry attempts for network/API errors during worker execution.
 *  Independent of order.budget.maxRetries (which covers output parse failures). */
const MAX_TRANSIENT_RETRIES = 2
const TRANSIENT_BACKOFF_BASE_MS = 2_000

/** Checkpoint saved from a previous worker run — allows Flash workers to resume
 *  from their last successful turn instead of redoing all work on retry. */
export interface WorkerCheckpoint {
  /** 0-based index of the last successfully completed turn. */
  turnIndex: number
  /** Accumulated partial output from completed turns. */
  partialResult: string
  /** Tool calls completed (for audit/dedup). */
  completedTools: string[]
}

export interface WorkerSessionConfig {
  order: WorkOrder
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  /** Provider key used for this worker run (e.g. 'deepseek', 'openai'). */
  providerName?: string
  /** Whether to use response_format: json_object on the repair turn (when the
   *  provider supports it) to force valid JSON output. The repair turn is a
   *  tool-free single-shot request, so json_object does not conflict with
   *  function calling (unlike normal turns where tools + json_object cause
   *  duplicate/spurious output). */
  forceJsonRepair?: boolean
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /** Review-router re-entrancy depth propagated to worker tool calls. */
  reviewDepth?: number
  /** Parent abort signal — propagated to worker AgentLoop for immediate abort. */
  abortSignal?: AbortSignal
  /** V3 Component B: optional per-domain lessons recalled into worker prompt. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Liveness signal — fired on every worker activity (text/thinking/tool)
   *  so the coordinator can feed a stall clock and the UI can show progress.
   *  Without this the worker's internal heartbeat fires into the void.
   *  `detail` carries the tool name for tool events and the delta for text. */
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void
  /** Resume from a previous checkpoint — inject partial results as context so
   *  the worker doesn't redo completed work. Especially valuable for multi-turn
   *  Flash workers (test_scaffolder generating multiple files). */
  checkpoint?: WorkerCheckpoint
  /** Structured mailbox for inter-agent communication. Worker tools can send
   *  progress, findings, and escalations through this channel. The coordinator
   *  drains the mailbox after the wave completes. */
  mailbox?: WorkerMailbox
  /** Prior conversation history to resume from. When provided, the session is
   *  pre-seeded with these messages before the first agent.run(), so the worker
   *  sees its previous context. The current objective is appended as a new user
   *  message on top of the history. */
  priorMessages?: readonly import('../api/oai-types.js').OaiMessage[]
}

export type WorkerActivityKind = 'text' | 'thinking' | 'tool_use' | 'tool_result'

export interface WorkerTranscript {
  text: string
  thinking: string
  toolUses: string[]
  toolResults: string[]
  errors: string[]
  repairAttempts: number
}

export interface WorkerSessionRun {
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
  /** Extracted checkpoint when the worker was aborted mid-work — can be passed
   *  back as config.checkpoint to resume on retry. */
  checkpoint?: WorkerCheckpoint
}

function emptyTranscript(): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: [],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
  }
}

/**
 * Detect streaming-layer tool-call argument pollution from the worker transcript.
 *
 * Signature of the cross-tool pollution bug (openai-client.ts resolveToolCallIndex):
 * a read tool (grep/glob) repeatedly fails with a "required argument missing"
 * error that also names a FOREIGN field — e.g. grep reporting
 * `Received input keys: file_path, path` (file_path belongs to read_section),
 * or the explicit "streaming tool_call argument pollution" marker grep emits.
 * When the model did the real work but got stuck retrying these poisoned calls,
 * it never reaches the final JSON → the worker is reported as "Parse failed" /
 * "aborted", masking the upstream streaming root cause.
 *
 * Returns a diagnostic hint to surface in the blocked result so the operator
 * does not chase "model can't output JSON" when the real cause is streaming.
 */
function detectPollutionFailure(transcript: WorkerTranscript): string | null {
  const errs = transcript.errors
  if (errs.length === 0) return null
  // Either the explicit pollution marker (grep.ts), or a "required" error that
  // also names a foreign key (file_path on a non-file tool, etc.).
  const hits = errs.filter(e =>
    e.includes('argument pollution')
    || (/\brequired\b/i.test(e) && /file_path|section|command\b/.test(e) && /pattern|path|glob\b/.test(e)),
  )
  if (hits.length < 2) return null  // a single transient blip is not a pattern
  return `Worker stalled on ${hits.length} streaming-polluted tool calls (foreign arguments grafted onto read tools). The review work above is likely real; the missing JSON is a symptom of the upstream OpenAIClient parallel-tool_call parsing bug, not a model failure. See .rivet/tool-stream-*.jsonl.`
}

/** Minimal agent surface needed by the retry layer — injectable so tests can
 *  exercise the real retry→blocked path without constructing a full AgentLoop. */
export interface RunnableAgent {
  run: AgentLoop['run']
}

async function runOnce(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
): Promise<string> {
  let text = ''
  // AgentLoop.run never rethrows stream errors — it reports them via onError
  // and resolves. Capture and rethrow here so the transient-retry layer above
  // actually sees ECONNRESET/429/timeout instead of an empty transcript.
  let streamError: Error | null = null
  let aborted = false
  await agent.run(prompt, {
    onTextDelta: (delta) => {
      text += delta
      transcript.text += delta
      onActivity?.('text', delta)
    },
    onThinkingDelta: (delta) => {
      transcript.thinking += delta
      onActivity?.('thinking', delta)
    },
    onToolUse: (_id, name) => {
      transcript.toolUses.push(name)
      onActivity?.('tool_use', name)
    },
    onToolResult: (_id, name, result, isError) => {
      transcript.toolResults.push(name)
      if (isError) transcript.errors.push(result)
      onActivity?.('tool_result', name)
    },
    onTurnComplete: () => {},
    onError: (error) => {
      transcript.errors.push(error.message)
      streamError = error
    },
    onAbort: () => {
      transcript.errors.push('Worker aborted')
      aborted = true
    },
    onApprovalRequired: async () => false,
  })
  // Aborts are a deliberate stop (budget timer / parent signal), not a fault —
  // return the partial text and let the parse/blocked path handle it.
  if (streamError && !aborted) throw streamError
  return text
}

/**
 * Single-shot repair request with response_format: json_object and NO tools.
 *
 * Normal worker turns carry tool definitions, and combining response_format:
 * json_object with tools is a known-broken combination (duplicate JSON, spurious
 * tool_calls, empty content — see OpenAI community reports). The repair turn,
 * however, only needs the model to re-emit its result as valid JSON from the
 * repair prompt (which embeds the previous broken output). It carries no tools,
 * so json_object is safe here and forces the model to emit parseable JSON,
 * eliminating the most common parse-failure cause (free-text prose / truncation).
 *
 * Bypasses AgentLoop entirely (no tool-calling loop) — just one client.stream
 * call. Returns the accumulated text or '' on stream error (caller falls back
 * to the blocked-result path).
 */
async function repairWithJsonMode(
  client: StreamClient,
  model: string,
  repairPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let text = ''
  let failed = false
  await client.stream(
    {
      model,
      messages: [{ role: 'user' as const, content: repairPrompt }],
      max_tokens: maxTokens,
      stream: true,
      // Force JSON output. The repair prompt already mentions "json" (required
      // by DeepSeek/GLM when response_format is set).
      response_format: { type: 'json_object' as const },
    },
    {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: () => { failed = true },
    },
    signal,
  ).catch(() => { failed = true })
  return failed ? '' : text
}

/** Run a single agent turn, retrying transient network/API errors with backoff.
 *  Exported for direct testing with an injected mock agent. */
export async function runOnceWithTransientRetry(
  agent: RunnableAgent,
  prompt: string,
  transcript: WorkerTranscript,
  onActivity?: (kind: WorkerActivityKind, detail?: string) => void,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      return await runOnce(agent, prompt, transcript, onActivity)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const classified = classifyFailure(message)
      if (classified.retryable && isTransient(classified.class) && attempt < MAX_TRANSIENT_RETRIES) {
        const backoff = TRANSIENT_BACKOFF_BASE_MS * Math.pow(2, attempt)
        transcript.errors.push(`Transient error (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1}): ${message} — retrying in ${backoff}ms`)
        await new Promise<void>(resolve => setTimeout(resolve, backoff))
        continue
      }
      throw err
    }
  }
  // Unreachable, but satisfy TypeScript
  throw new Error('runOnceWithTransientRetry: exhausted retries')
}

export async function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  if (config.activeClaims && config.activeClaims.length > 0) {
    config.promptEngine.updateActiveClaims(config.activeClaims)
  }
  // Build knowledge blocks for prompt injection. Domain lessons are scoped to
  // the worker authority and stay in the worker prompt only; they never mutate
  // the primary session prompt/prefix.
  const knowledgeBlocks = [
    config.activeClaims ? buildWorkerKnowledgeBlock(config.activeClaims) : '',
    config.domainKnowledgeStore && config.order.authority
      ? buildDomainKnowledgeBlock(config.domainKnowledgeStore, config.order.authority)
      : '',
  ].filter(Boolean)
  const baseParts = [...knowledgeBlocks, buildWorkerPrompt(config.order)]
  // Checkpoint resume: inject partial results so the worker doesn't redo completed work
  if (config.checkpoint && config.checkpoint.partialResult) {
    baseParts.push(
      `<checkpoint turn="${config.checkpoint.turnIndex}" tools="${config.checkpoint.completedTools.length}">`,
      'The following work was already completed in a previous run. Do NOT redo it — continue from where it stopped:',
      config.checkpoint.partialResult,
      '</checkpoint>',
    )
  }
  const prompt = baseParts.join('\n\n')

  const session = new SessionContext()
  // Session resume: pre-seed the conversation history so the worker continues
  // from its previous context. The new objective is then appended as a fresh
  // user message by agent.run() below.
  if (config.priorMessages && config.priorMessages.length > 0) {
    session.replaceMessages([...config.priorMessages])
  }
  const agent = new AgentLoop({
    client: config.client,
    promptEngine: config.promptEngine,
    toolRegistry: config.toolRegistry,
    // R3.1: honor the per-profile turn budget even for direct callers — the
    // coordinator already clamps, this guards runWorkerSession used standalone.
    maxTurns: clampWorkerMaxTurns(config.maxTurns, config.order.budget.maxTurns),
    contextWindow: config.contextWindow,
    compact: config.compact,
    sessionId: `worker-${config.order.id.replace(/:/g, '-')}`,
    reviewDepth: config.reviewDepth,
    // B3: the worker knows its own nesting depth, so any delegate_task it
    // issues carries it and the coordinator can cap recursion.
    delegationDepth: config.order.delegationDepth,
    thetaCheckDisabled: true,
  }, session, config.cwd)

  // Record the selected model into the worker session JSONL so the actual
  // model used is auditable without opening the .meta.json sidecar.
  const workerModel = config.promptEngine.getModel()
  agent.persist?.appendModelSwitch({ to: workerModel })

  // Create mailbox sender for structured inter-agent communication.
  // Workers report progress, findings, and escalations through this channel;
  // the coordinator drains the mailbox after the wave completes.
  const mbox = config.mailbox
    ? createWorkerMailboxSender(config.mailbox, config.order.id)
    : null

  // Abort latch — once the budget timer or the parent signal fires, the
  // session must STOP. Each agent.run() creates a fresh AbortController, so
  // without this latch the parse-repair loop below would happily re-run an
  // "aborted" worker with a live signal and keep issuing API calls.
  let abortLatched = false
  const timeoutMs = config.order.budget.timeoutMs
  const timer = setTimeout(() => { abortLatched = true; agent.abort() }, timeoutMs)

  // Propagate parent abort signal — when parent aborts, worker must stop
  // immediately instead of waiting for the internal budget timeout.
  const onParentAbort = config.abortSignal
    ? () => { abortLatched = true; agent.abort(); clearTimeout(timer) }
    : null
  if (onParentAbort && !config.abortSignal!.aborted) {
    config.abortSignal!.addEventListener('abort', onParentAbort, { once: true })
  }
  const wasAborted = (): boolean => abortLatched || (config.abortSignal?.aborted ?? false)

  try {
    const transcript = emptyTranscript()
    let latestText = await runOnceWithTransientRetry(agent, prompt, transcript, config.onActivity)
    mbox?.progress(1, config.order.budget.maxRetries + 1, 'initial run')

    for (let attempt = 0; attempt <= config.order.budget.maxRetries; attempt++) {
      // Abort wins over repair: never re-run an aborted worker.
      if (wasAborted()) {
        const partialSummary = latestText.slice(0, 500)
        mbox?.escalate(`Worker aborted: ${partialSummary.slice(0, 100)}`)
        // Extract checkpoint for potential resume
        const abortCheckpoint: WorkerCheckpoint = {
          turnIndex: attempt,
          partialResult: latestText.slice(0, 8000),
          completedTools: [...transcript.toolUses],
        }
        const pollutionHint = detectPollutionFailure(transcript)
        return {
          result: {
            ...buildBlockedWorkerResult(config.order, `Worker aborted (budget timeout or parent signal). Partial output: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}`),
            artifacts: [
              { kind: 'note' as const, title: 'Aborted worker partial output', content: latestText.slice(0, 2000) },
            ],
          },
          transcript,
          session,
          usage: session.getTotalUsage(),
          checkpoint: abortCheckpoint,
        }
      }
      try {
        const result = parseWorkerResult(latestText, config.order.id)
        // Report structured findings back to coordinator
        if (result.findings?.length) {
          for (const f of result.findings.slice(0, 3)) {
            mbox?.reportFinding(f.claim ?? 'finding', 'info', result.changedFiles)
          }
        }
        if (mbox) {
          mbox.progress(config.order.budget.maxRetries + 1, config.order.budget.maxRetries + 1, 'completed')
        }
        return {
          result,
          transcript,
          session,
          usage: session.getTotalUsage(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        transcript.errors.push(message)
        mbox?.escalate(`Parse failed (attempt ${attempt + 1}): ${message.slice(0, 100)}`)
        if (attempt === config.order.budget.maxRetries) {
          const partialSummary = latestText.slice(0, 300)
          const pollutionHint = detectPollutionFailure(transcript)
          return {
            result: {
              ...buildBlockedWorkerResult(config.order, `Parse failed after ${attempt + 1} attempts: ${message}. Partial: ${partialSummary}${pollutionHint ? ` ${pollutionHint}` : ''}`),
              artifacts: [
                { kind: 'note' as const, title: 'Unparseable worker output', content: latestText.slice(0, 2000) },
              ],
            },
            transcript,
            session,
            usage: session.getTotalUsage(),
          }
        }
        transcript.repairAttempts++
        // JSON-mode repair: provider supports response_format: json_object and
        // the combination is safe here (no tools on this turn). Prefer it over
        // the AgentLoop repair loop — it directly forces valid JSON output,
        // short-circuiting the most common parse-failure cause.
        if (config.forceJsonRepair && !abortLatched) {
          const jsonText = await repairWithJsonMode(
            config.client,
            config.promptEngine.getModel(),
            buildWorkerRepairPrompt(config.order, latestText, message),
            Math.min(8192, config.order.budget.maxTokens ?? config.contextWindow),
            config.abortSignal,
          )
          if (jsonText) {
            latestText = jsonText
            // Skip the AgentLoop repair — go straight to re-parse at loop top.
            continue
          }
          // json-mode repair produced nothing (stream error) → fall through to AgentLoop repair
        }
        latestText = await runOnceWithTransientRetry(agent, buildWorkerRepairPrompt(config.order, latestText, message), transcript, config.onActivity)
      }
    }

    return {
      result: buildBlockedWorkerResult(config.order, 'Worker result parser exited unexpectedly'),
      transcript,
      session,
      usage: session.getTotalUsage(),
    }
  } finally {
    clearTimeout(timer)
    if (onParentAbort && config.abortSignal) {
      config.abortSignal.removeEventListener('abort', onParentAbort)
    }
  }
}
