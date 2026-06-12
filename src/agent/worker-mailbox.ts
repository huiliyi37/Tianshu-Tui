/**
 * Structured in-memory mailbox for inter-agent communication.
 *
 * Workers send typed messages (finding, request, artifact, progress, escalation)
 * that the coordinator routes after worker completion. The mailbox lives for the
 * duration of a single delegation wave and is cleared when the wave completes.
 *
 * Design: in-memory only — no persistence needed. Each wave gets a fresh mailbox.
 */

import { randomUUID } from 'node:crypto'

export type MailboxMessageType = 'finding' | 'request' | 'artifact' | 'progress' | 'escalation'
export type MailboxSeverity = 'info' | 'warning' | 'blocking'

export interface MailboxMessage {
  id: string
  from: string
  to: string
  type: MailboxMessageType
  payload: {
    summary: string
    files?: string[]
    severity?: MailboxSeverity
    artifact?: string
    /** Progress percentage (0–100) for 'progress' messages. */
    progress?: number
    /** Extra structured data the sender wants to pass through. */
    meta?: Record<string, unknown>
  }
  ts: number
}

export type MailboxSendInput = Omit<MailboxMessage, 'id' | 'ts'>
export type MailboxBroadcastInput = Omit<MailboxMessage, 'id' | 'ts' | 'to'>

export interface WorkerMailbox {
  /** Send a message to a specific recipient (workerId | 'coordinator' | 'main'). */
  send(msg: MailboxSendInput): void
  /** Get all messages addressed to a specific workerId (or 'coordinator'/'main'). */
  receive(recipientId: string): MailboxMessage[]
  /** Broadcast a message to all recipients (no specific 'to'). */
  broadcast(msg: MailboxBroadcastInput): void
  /** Get all messages in the mailbox (for observability). */
  all(): MailboxMessage[]
  /** Get messages by type (e.g., all escalations). */
  byType(type: MailboxMessageType): MailboxMessage[]
  /** Clear all messages (called when a delegation wave completes). */
  clear(): void
  /** Count of messages in the mailbox. */
  size(): number
}

export class InMemoryMailbox implements WorkerMailbox {
  private messages: MailboxMessage[] = []

  send(msg: MailboxSendInput): void {
    this.messages.push({
      ...msg,
      id: randomUUID(),
      ts: Date.now(),
    })
  }

  receive(recipientId: string): MailboxMessage[] {
    return this.messages.filter(m => m.to === recipientId || m.to === '*')
  }

  broadcast(msg: MailboxBroadcastInput): void {
    this.messages.push({
      ...msg,
      to: '*',
      id: randomUUID(),
      ts: Date.now(),
    })
  }

  all(): MailboxMessage[] {
    return [...this.messages]
  }

  byType(type: MailboxMessageType): MailboxMessage[] {
    return this.messages.filter(m => m.type === type)
  }

  clear(): void {
    this.messages = []
  }

  size(): number {
    return this.messages.length
  }
}

/**
 * Create a scoped send function for a specific worker.
 * Workers only get `send` and `broadcast` — they can't read other workers' mail.
 */
export function createWorkerMailboxSender(
  mailbox: WorkerMailbox,
  workerId: string,
): {
  send: (to: string, type: MailboxMessageType, payload: MailboxMessage['payload']) => void
  broadcast: (type: MailboxMessageType, payload: MailboxMessage['payload']) => void
  progress: (current: number, total: number, label: string) => void
  escalate: (summary: string, files?: string[]) => void
  reportFinding: (summary: string, severity?: MailboxSeverity, files?: string[]) => void
  reportArtifact: (summary: string, artifactPath: string, files?: string[]) => void
} {
  return {
    send(to, type, payload) {
      mailbox.send({ from: workerId, to, type, payload })
    },
    broadcast(type, payload) {
      mailbox.broadcast({ from: workerId, type, payload })
    },
    progress(current, total, label) {
      mailbox.send({
        from: workerId,
        to: 'coordinator',
        type: 'progress',
        payload: { summary: label, progress: total > 0 ? Math.round((current / total) * 100) : 0 },
      })
    },
    escalate(summary, files) {
      mailbox.send({
        from: workerId,
        to: 'main',
        type: 'escalation',
        payload: { summary, severity: 'blocking', files },
      })
    },
    reportFinding(summary, severity = 'info', files) {
      mailbox.send({
        from: workerId,
        to: 'coordinator',
        type: 'finding',
        payload: { summary, severity, files },
      })
    },
    reportArtifact(summary, artifactPath, files) {
      mailbox.send({
        from: workerId,
        to: 'coordinator',
        type: 'artifact',
        payload: { summary, artifact: artifactPath, files },
      })
    },
  }
}
