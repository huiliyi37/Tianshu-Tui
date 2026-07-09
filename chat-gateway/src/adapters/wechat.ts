import { createHash } from 'node:crypto'
import type { ChatAdapter, ChatAdapterContext } from './types.js'
import { chunkText, stripMarkdownForChat } from '../formatter.js'

interface WechatXmlMessage {
  ToUserName?: string
  FromUserName?: string
  CreateTime?: string
  MsgType?: string
  Content?: string
  MsgId?: string
  Event?: string
}

interface WechatToken {
  access_token: string
  expires_in: number
  fetchedAt: number
}

export class WechatAdapter implements ChatAdapter {
  readonly platform = 'wechat'
  private tokenCache: WechatToken | null = null

  async handleWebhook(
    req: Request,
    ctx: ChatAdapterContext
  ): Promise<{ status: number; body: unknown }> {
    const cfg = ctx.config.wechat
    if (!cfg.enabled) {
      return { status: 503, body: { error: 'WeChat adapter disabled' } }
    }
    if (!cfg.token) {
      return { status: 500, body: { error: 'WeChat token not configured' } }
    }

    const url = new URL(req.url)
    const signature = url.searchParams.get('signature') ?? ''
    const timestamp = url.searchParams.get('timestamp') ?? ''
    const nonce = url.searchParams.get('nonce') ?? ''
    const echostr = url.searchParams.get('echostr') ?? ''

    if (!this.verifySignature(cfg.token, timestamp, nonce, signature)) {
      return { status: 403, body: { error: 'Invalid signature' } }
    }

    if (req.method === 'GET') {
      return { status: 200, body: echostr }
    }

    const bodyText = await req.text()
    const msg = this.parseXml(bodyText)
    const openid = msg.FromUserName
    const ghId = msg.ToUserName

    if (!openid || !ghId) {
      return { status: 200, body: 'success' }
    }

    const conversationId = ghId
    const identity = {
      platform: 'wechat' as const,
      conversationId,
      senderId: openid,
    }

    if (!ctx.allowlist.allows(identity)) {
      await this.sendCustomerText(openid, '你还没有被授权使用此助手。', ctx)
      return { status: 200, body: 'success' }
    }

    if (msg.MsgType === 'text' && msg.Content) {
      const { sessionId } = await ctx.sessions.resolve({
        platform: 'wechat',
        conversationId,
        senderId: openid,
        createSessionId: async () => {
          const rec = await ctx.rivet.createSession(ctx.config.rivet.cwd)
          return rec.id
        },
        title: msg.Content.slice(0, 80),
      })

      // WeChat official account requires reply within ~5s for passive response.
      // Send an immediate acknowledgement, then push the real answer via customer service message.
      await this.sendCustomerText(openid, '收到，正在处理…', ctx)
      this.runSessionAsync(sessionId, msg.Content, openid, ctx)
    }

    return { status: 200, body: 'success' }
  }

  private verifySignature(token: string, timestamp: string, nonce: string, signature: string): boolean {
    const raw = [token, timestamp, nonce].sort().join('')
    const computed = createHash('sha1').update(raw).digest('hex')
    return computed === signature
  }

  private parseXml(xml: string): WechatXmlMessage {
    const result: WechatXmlMessage = {}
    const regex = /<(\w+)><!\[CDATA\[(.*?)\]\]><\/\w+>|<(\w+)>(.*?)<\/\w+>/g
    let m: RegExpExecArray | null
    while ((m = regex.exec(xml)) !== null) {
      const key = (m[1] ?? m[3])!
      const value = (m[2] ?? m[4]) ?? ''
      result[key as keyof WechatXmlMessage] = value
    }
    return result
  }

  private async runSessionAsync(
    sessionId: string,
    text: string,
    openid: string,
    ctx: ChatAdapterContext
  ): Promise<void> {
    const { rivet, config } = ctx

    try {
      await rivet.prompt(sessionId, {
        text,
        approvalMode: config.security.approvalMode,
      })
    } catch (err) {
      await this.sendCustomerText(
        openid,
        `发送给天枢失败：${err instanceof Error ? err.message : String(err)}`,
        ctx
      )
      return
    }

    const { abort } = rivet.streamEvents(
      sessionId,
      0,
      async (event) => {
        if (event.type === 'assistant_text') {
          const text = stripMarkdownForChat(String(event.text ?? ''))
          for (const chunk of chunkText(text)) {
            await this.sendCustomerText(openid, chunk.text, ctx)
          }
        } else if (event.type === 'approval_required') {
          const requestId = String(event.requestId ?? '')
          const toolName = String(event.toolName ?? '')
          const url = ctx.config.publicUrl
            ? `${ctx.config.publicUrl}/approve?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}&approved=true`
            : undefined
          await this.sendCustomerText(
            openid,
            url
              ? `⚠️ 天枢请求执行「${toolName}」，点击确认：${url}\n或在 TUI/Desktop 中审批。`
              : `⚠️ 天枢请求执行「${toolName}」，请在 TUI/Desktop 中确认。`,
            ctx
          )
        } else if (event.type === 'error') {
          await this.sendCustomerText(
            openid,
            `执行出错：${String(event.message ?? event.error ?? '')}`,
            ctx
          )
        }
      },
      async (err) => {
        await this.sendCustomerText(openid, `流式响应中断：${err.message}`, ctx)
      }
    )

    setTimeout(() => abort(), 10 * 60 * 1000)
  }

  async sendText(conversationId: string, text: string, ctx: ChatAdapterContext): Promise<void> {
    // For WeChat, the conversationId is the ghId; actual recipient is the sender openid.
    // This method is a no-op here because we need openid. The public interface is kept for uniformity.
    console.warn('[wechat] sendText by conversationId is not supported; use sendCustomerText by openid')
  }

  private async sendCustomerText(openid: string, text: string, ctx: ChatAdapterContext): Promise<void> {
    const token = await this.getAccessToken(ctx)
    if (!token) return

    const url = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: openid,
        msgtype: 'text',
        text: { content: text },
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('[wechat] send failed:', res.status, body)
    }
  }

  private async getAccessToken(ctx: ChatAdapterContext): Promise<string | null> {
    const cfg = ctx.config.wechat
    if (!cfg.appId || !cfg.appSecret) return null

    if (this.tokenCache && this.tokenCache.fetchedAt + this.tokenCache.expires_in * 1000 > Date.now() + 60_000) {
      return this.tokenCache.access_token
    }

    const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${cfg.appId}&secret=${cfg.appSecret}`
    const res = await fetch(url)
    if (!res.ok) {
      console.error('[wechat] token failed:', await res.text())
      return null
    }
    const data = (await res.json()) as { access_token: string; expires_in: number }
    this.tokenCache = { ...data, fetchedAt: Date.now() }
    return data.access_token
  }
}
