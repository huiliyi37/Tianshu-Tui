import type { RivetClient } from '../rivet-client.js'
import type { SessionMap } from '../session-map.js'
import type { GatewayConfig } from '../config.js'
import type { Allowlist } from '../security.js'

export interface ChatAdapterContext {
  config: GatewayConfig
  rivet: RivetClient
  sessions: SessionMap
  allowlist: Allowlist
}

export interface OutgoingMessage {
  text: string
  /** Platform-specific reply metadata (message_id, etc.). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  replyTo?: any
}

export interface ChatAdapter {
  /** Platform id, e.g. 'feishu' or 'wechat'. */
  readonly platform: string
  /** Handle incoming webhook request and return response body + status. */
  handleWebhook(req: Request, ctx: ChatAdapterContext): Promise<{ status: number; body: unknown }>
  /** Send a plain text message to a conversation. Optional when platform uses sender-scoped delivery. */
  sendText?(conversationId: string, text: string, ctx: ChatAdapterContext): Promise<void>
}
