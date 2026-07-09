import type { BotAdapter } from './bot-adapter.js'
import type { ChatAdapterContext } from './types.js'
import { chunkText, stripMarkdownForChat } from '../formatter.js'
import { WechatyBuilder, type Wechaty, type Message } from 'wechaty'

/**
 * Experimental personal WeChat adapter via Wechaty.
 *
 * ⚠️ WARNING: Automating a personal WeChat account violates WeChat's Terms of
 * Service and carries a real risk of account suspension or ban. This adapter is
 * provided as an experimental, self-hosted option only. Use an official
 * WeChat Work / Official Account webhook in production.
 *
 * Default puppet is `wechaty-puppet-wechat4u` (web protocol), which is free but
 * unstable and increasingly restricted by WeChat. Many accounts cannot log in
 * or are disconnected after a few days. Alternative puppets (padlocal, xp,
 * donut, etc.) can be configured but most are paid, Windows-only, or
 * third-party reverse-engineered protocols.
 */
export class WechatPersonalAdapter implements BotAdapter {
  readonly platform = 'wechat-personal'
  private bot: Wechaty | null = null
  private ctx: ChatAdapterContext | null = null

  async start(ctx: ChatAdapterContext): Promise<void> {
    const cfg = ctx.config.wechat
    if (!cfg.enabled || cfg.kind !== 'personal') {
      console.log('[wechat-personal] disabled or kind != personal')
      return
    }

    this.ctx = ctx
    const puppet = process.env.WECHATY_PUPPET ?? cfg.puppet

    this.bot = WechatyBuilder.build({
      name: 'tianshu-gateway',
      puppet: puppet as any,
    })

    this.bot.on('scan', (qrcode, status) => {
      console.log(`[wechat-personal] scan status=${status}`)
      console.log(`[wechat-personal] qrcode: https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`)
    })

    this.bot.on('login', (user) => {
      console.log(`[wechat-personal] logged in as ${user.name()}`)
    })

    this.bot.on('logout', (user) => {
      console.log(`[wechat-personal] logged out ${user.name()}`)
    })

    this.bot.on('message', (msg) => {
      // intentionally not awaited so the bot event loop is not blocked
      this.onMessage(msg).catch((err) => {
        console.error('[wechat-personal] message handler error:', err)
      })
    })

    await this.bot.start()
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop()
      this.bot = null
    }
  }

  private async onMessage(msg: Message): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return

    // Skip messages sent by the bot itself.
    if (msg.self()) return

    const contact = msg.talker()
    const room = msg.room()
    const rawText = msg.text()
    const senderId = contact.id
    const senderName = contact.name()
    const conversationId = room?.id ?? senderId

    const groupTriggerPrefix = ctx.config.wechat.groupTriggerPrefix

    // In group chats, only respond when explicitly triggered.
    if (room) {
      const mentioned = await msg.mentionSelf()
      if (!mentioned && !rawText.startsWith(groupTriggerPrefix)) {
        return
      }
    }

    const text = room
      ? rawText.replace(groupTriggerPrefix, '').trim()
      : rawText.trim()

    if (!text) return

    const identity = {
      platform: 'wechat-personal' as const,
      conversationId,
      senderId,
      senderName,
    }

    if (!ctx.allowlist.allows(identity)) {
      await this.reply(msg, room, contact, '你还没有被授权使用此助手。')
      return
    }

    const { sessionId } = await ctx.sessions.resolve({
      platform: 'wechat-personal',
      conversationId,
      senderId,
      createSessionId: async () => {
        const rec = await ctx.rivet.createSession(ctx.config.rivet.cwd)
        return rec.id
      },
      title: text.slice(0, 80),
    })

    await this.runSession(sessionId, text, msg, room, contact, ctx)
  }

  private async runSession(
    sessionId: string,
    text: string,
    msg: Message,
    room: Awaited<ReturnType<Message['room']>>,
    contact: Awaited<ReturnType<Message['talker']>>,
    ctx: ChatAdapterContext
  ): Promise<void> {
    const { rivet, config } = ctx

    try {
      await rivet.prompt(sessionId, {
        text,
        approvalMode: config.security.approvalMode,
      })
    } catch (err) {
      await this.reply(
        msg,
        room,
        contact,
        `发送给天枢失败：${err instanceof Error ? err.message : String(err)}`
      )
      return
    }

    const { abort } = rivet.streamEvents(
      sessionId,
      0,
      async (event) => {
        if (event.type === 'assistant_text') {
          const reply = stripMarkdownForChat(String(event.text ?? ''))
          for (const chunk of chunkText(reply)) {
            await this.reply(msg, room, contact, chunk.text)
          }
        } else if (event.type === 'approval_required') {
          const requestId = String(event.requestId ?? '')
          const toolName = String(event.toolName ?? '')
          const url = config.publicUrl
            ? `${config.publicUrl}/approve?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}&approved=true`
            : undefined
          await this.reply(
            msg,
            room,
            contact,
            url
              ? `⚠️ 天枢请求执行「${toolName}」，点击确认：${url}\n或在 TUI/Desktop 中审批。`
              : `⚠️ 天枢请求执行「${toolName}」，请在 TUI/Desktop 中确认。`
          )
        } else if (event.type === 'error') {
          await this.reply(
            msg,
            room,
            contact,
            `执行出错：${String(event.message ?? event.error ?? '')}`
          )
        }
      },
      async (err) => {
        await this.reply(msg, room, contact, `流式响应中断：${err.message}`)
      }
    )

    setTimeout(() => abort(), 10 * 60 * 1000)
  }

  private async reply(
    msg: Message,
    room: Awaited<ReturnType<Message['room']>>,
    contact: Awaited<ReturnType<Message['talker']>>,
    text: string
  ): Promise<void> {
    try {
      if (room) {
        await room.say(text)
      } else {
        await contact.say(text)
      }
    } catch (err) {
      console.error('[wechat-personal] reply failed:', err)
    }
  }
}
