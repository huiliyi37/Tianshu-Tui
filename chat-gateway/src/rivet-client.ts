import { randomUUID } from 'node:crypto'

export interface RivetSessionRecord {
  id: string
  title?: string
  status?: string
}

export interface RivetEvent {
  seq: number
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface PromptBody {
  text?: string
  images?: string[]
  approvalMode?: string
}

export interface CreateSessionBody {
  cwd: string
  prompt?: PromptBody
}

export interface InterventionAnswerBody {
    approved: boolean
    reason?: string
  }

export class RivetClient {
  constructor(
    private baseUrl: string,
    private token: string | undefined
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  async createSession(cwd: string, prompt?: PromptBody): Promise<RivetSessionRecord> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ cwd, prompt } satisfies CreateSessionBody),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Rivet create session failed: ${res.status} ${text}`)
    }
    return (await res.json()) as RivetSessionRecord
  }

  async prompt(sessionId: string, body: PromptBody): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/prompt`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Rivet prompt failed: ${res.status} ${text}`)
    }
  }

  async listEvents(sessionId: string, since = 0): Promise<RivetEvent[]> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/events?since=${since}`, {
      headers: this.headers(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Rivet list events failed: ${res.status} ${text}`)
    }
    return (await res.json()) as RivetEvent[]
  }

  streamEvents(
    sessionId: string,
    since = 0,
    onEvent: (event: RivetEvent) => void,
    onError: (err: Error) => void
  ): { abort: () => void } {
    const abortController = new AbortController()
    const url = `${this.baseUrl}/sessions/${sessionId}/stream?since=${since}`

    const pump = async () => {
      try {
        const res = await fetch(url, {
          headers: this.headers(),
          signal: abortController.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`Rivet stream failed: ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const event = JSON.parse(payload) as RivetEvent
              onEvent(event)
            } catch {
              // ignore malformed sse payload
            }
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          onError(err instanceof Error ? err : new Error(String(err)))
        }
      }
    }

    pump()
    return { abort: () => abortController.abort() }
  }

  async answerIntervention(sessionId: string, requestId: string, approved: boolean, reason?: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${sessionId}/interventions/${requestId}/answer`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ approved, reason } satisfies InterventionAnswerBody),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Rivet intervention answer failed: ${res.status} ${text}`)
    }
  }
}

export function makeSessionId(): string {
  return `chat-${randomUUID()}`
}
