/**
 * provider-probe — probe-first onboarding (Wave 3).
 *
 * probeProvider() verifies a candidate endpoint before anything is written to
 * config:
 *   1. GET /models              → model id list (timeout/404 degrades, not fails)
 *   2. one minimal completion   → stream liveness + capability hints
 *      (max_tokens=8, "hi")       - non-SSE 200 → "missing /v1?" guidance
 *                                 - reasoning_content in the wire → reasoningSplit hint
 *                                 - 401/403/404 → classified, actionable text
 *
 * The probe is skippable (--no-probe / UI skip): it spends a handful of the
 * user's tokens, so nothing here is mandatory.
 */

export interface ProbeOptions {
  baseUrl: string
  apiKey?: string
  protocol?: 'openai' | 'anthropic'
  /** Per-request timeout. Default 15s — cold endpoints should not hang onboarding. */
  timeoutMs?: number
  /** Model for the completion probe. Defaults to the first fetched model id. */
  probeModel?: string
  /** Skip the completion probe entirely (models list only). */
  skipCompletion?: boolean
}

export interface CapabilityHints {
  /** Wire carried `reasoning_content` → provider separates reasoning output. */
  reasoningSplit?: boolean
}

export interface ProbeReport {
  models: string[]
  /** GET /models returned a usable list. */
  modelsOk: boolean
  /** The minimal completion succeeded. */
  completionOk: boolean
  hints: CapabilityHints
  /** First-byte latency of the completion probe. */
  latencyMs?: number
  /** Classified human-readable problems (empty when everything succeeded). */
  errors: string[]
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

async function fetchWithProbeTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Extract model ids from OpenAI/Anthropic /models response shapes. */
function parseModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') ids.push(item)
    else if (item && typeof (item as { id?: unknown }).id === 'string') {
      ids.push((item as { id: string }).id)
    }
  }
  return ids
}

function classifyHttpError(status: number, bodyText: string, baseUrl: string): string {
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ').trim()
  if (status === 401 || status === 403) {
    return `Authentication failed (HTTP ${status}). Check the API key${snippet ? ` — server said: ${snippet}` : ''}.`
  }
  if (status === 404) {
    return `HTTP 404 from ${baseUrl} — the endpoint path may be wrong (missing "/v1"?) or the model id does not exist. Run \`rivet provider models\` to list valid ids.`
  }
  return `HTTP ${status}${snippet ? ` — ${snippet}` : ''}`
}

async function fetchModelList(options: ProbeOptions, errors: string[]): Promise<string[]> {
  const base = options.baseUrl.replace(/\/+$/, '')
  const url = options.protocol === 'anthropic' ? `${base}/v1/models` : `${base}/models`
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'GET',
      headers: authHeaders(options.apiKey),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      errors.push(`GET /models failed: ${classifyHttpError(response.status, bodyText, options.baseUrl)}`)
      return []
    }
    const payload = await response.json() as unknown
    const ids = parseModelIds(payload)
    if (ids.length === 0) errors.push('GET /models returned no usable model ids.')
    return ids
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    errors.push(`GET /models failed: ${reason}`)
    return []
  }
}

interface CompletionProbeOutcome {
  ok: boolean
  hints: CapabilityHints
  latencyMs?: number
  error?: string
}

async function probeOpenAICompletion(options: ProbeOptions, model: string): Promise<CompletionProbeOutcome> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const startedAt = Date.now()
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(options.apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 8,
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { ok: false, hints: {}, latencyMs, error: classifyHttpError(response.status, bodyText, options.baseUrl) }
    }

    const contentType = response.headers.get('content-type') ?? ''
    const bodyText = await readCappedText(response)
    if (!contentType.includes('text/event-stream') && !bodyText.includes('data:')) {
      return {
        ok: false,
        hints: {},
        latencyMs,
        error: 'Endpoint answered but not with an SSE stream — it may not support streaming, or the base URL is wrong (missing "/v1"?).',
      }
    }
    const hints: CapabilityHints = {}
    if (bodyText.includes('reasoning_content')) hints.reasoningSplit = true
    return { ok: true, hints, latencyMs }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason }
  }
}

async function probeAnthropicCompletion(options: ProbeOptions, model: string): Promise<CompletionProbeOutcome> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/v1/messages`
  const startedAt = Date.now()
  try {
    const response = await fetchWithProbeTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(options.apiKey ? { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '')
      return { ok: false, hints: {}, latencyMs, error: classifyHttpError(response.status, bodyText, options.baseUrl) }
    }
    const bodyText = await readCappedText(response)
    const hints: CapabilityHints = {}
    if (bodyText.includes('thinking')) hints.reasoningSplit = true
    return { ok: true, hints, latencyMs }
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `completion probe timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (error instanceof Error ? error.message : String(error))
    return { ok: false, hints: {}, latencyMs: Date.now() - startedAt, error: reason }
  }
}

async function readCappedText(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      text += decoder.decode(value, { stream: true })
      if (text.length >= MAX_BODY_BYTES) break
    }
  }
  reader.cancel().catch(() => {})
  return text
}

export async function probeProvider(options: ProbeOptions): Promise<ProbeReport> {
  const errors: string[] = []
  const models = await fetchModelList(options, errors)

  const report: ProbeReport = {
    models,
    modelsOk: models.length > 0,
    completionOk: false,
    hints: {},
    errors,
  }

  if (options.skipCompletion) return report
  const model = options.probeModel ?? models[0]
  if (!model) {
    errors.push('Completion probe skipped: no model id available (fetch a list first or pass probeModel).')
    return report
  }

  const outcome = options.protocol === 'anthropic'
    ? await probeAnthropicCompletion(options, model)
    : await probeOpenAICompletion(options, model)
  report.completionOk = outcome.ok
  report.hints = outcome.hints
  report.latencyMs = outcome.latencyMs
  if (outcome.error) errors.push(outcome.error)
  return report
}
