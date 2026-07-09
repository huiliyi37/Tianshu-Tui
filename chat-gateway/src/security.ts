import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SenderIdentity {
  platform: 'feishu' | 'wechat' | 'wechat-personal'
  conversationId: string
  senderId: string
  senderName?: string
}

export class Allowlist {
  constructor(private entries: Set<string>) {}

  static parse(raw: string[]): Allowlist {
    return new Allowlist(new Set(raw.map(s => s.trim()).filter(Boolean)))
  }

  allows(id: SenderIdentity): boolean {
    if (this.entries.size === 0) return true
    const keys = [
      `${id.platform}:${id.senderId}`,
      `${id.platform}:${id.conversationId}`,
      id.senderId,
    ]
    return keys.some(k => this.entries.has(k))
  }
}

export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

export function hmacSha256(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('hex')
}

export function sha1(payload: string): string {
  return createHmac('sha1', '').update(payload).digest('hex')
}
