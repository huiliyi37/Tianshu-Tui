import type { ChatAdapterContext } from './types.js'

/**
 * Adapters that maintain a persistent connection to an IM platform
 * (e.g. personal WeChat via Wechaty) instead of receiving webhooks.
 */
export interface BotAdapter {
  readonly platform: string
  start(ctx: ChatAdapterContext): Promise<void>
  stop(): Promise<void>
}
