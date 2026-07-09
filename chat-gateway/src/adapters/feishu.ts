import { createHmac } from 'node:crypto'
import type { ChatAdapter, ChatAdapterContext } from './types.js'
import { chunkText, stripMarkdownForChat } from '../formatter.js'

interface FeishuEventEnvelope {
  uuid?: string
  token?: string
  ts?: string
  type?: 'url_verification' | 'event_callback'
  challenge?: string
  event?: FeishuMessageEvent
}

interface FeishuMessageEvent {
  message?: {
    chat_id?: string
    message_id?: string
    sender?: {
      sender_id?: { open_id?: string; union_id?: string }
      sender_type?: string
    }
    content?: string
    create_time?: string
  }
  sender?: {
    sender_id?: { open_id?: string; union_id?: string }
  }
}

interface FeishuToken {
  tenant_access_token: string
  expire: number
}

export class FeishuAdapter implements ChatAdapter {
  readonly platform = 'feishu'
  private tokenCache: FeishuToken | null = null

  async handleWebhook(
    req: Request,
    ctx: ChatAdapterContext
  ): Promise<{ status: number; body: unknown }> {
    const cfg = ctx.config.feishu
    if (!cfg.enabled) {
      return { status: 503, body: { error: 'Feishu adapter disabled' } }
    }

    const bodyText = await req.text()
    const signature = req.headers.get('X-Lark-Signature') ?? ''
    const timestamp = req.headers.get('X-Lark-Request-Timestamp') ?? ''

    if (cfg.encryptKey && !this.verifySignature(cfg.encryptKey, timestamp, bodyText, signature)) {
      return { status: 401, body: { error: 'Invalid signature' } }
    }

    if (cfg.verificationToken) {
      // For url_verification, token is in payload; for event_callback it is also present.
      try {
        const parsed = JSON.parse(bodyText) as FeishuEventEnvelope
        if (parsed.token && parsed.token !== cfg.verificationToken) {
          return { status: 401, body: { error: 'Invalid token' } }
        }
      } catch {
        return { status: 400, body: { error: 'Invalid JSON' } }
      }
    }

    let payload: FeishuEventEnvelope
    try {
      payload = JSON.parse(bodyText) as FeishuEventEnvelope
    } catch {
      return { status: 400, body: { error: 'Invalid JSON' } }
    }

    if (payload.type === 'url_verification') {
      return { status: 200, body: { challenge: payload.challenge } }
    }

    if (payload.type === 'event_callback') {
      await this.handleEvent(payload, ctx)
      return { status: 200, body: {} }
    }

    return { status: 200, body: {} }
  }

  private verifySignature(key: string, timestamp: string, body: string, signature: string): boolean {
    const raw = `${timestamp}\n${key}\n${body}\n`
    const computed = createHmac('sha256', key).update(raw).digest('base64')
    return computed === signature
  }

  private async handleEvent(payload: FeishuEventEnvelope, ctx: ChatAdapterContext): Promise<void> {
    const msg = payload.event?.message
    if (!msg?.chat_id || !msg.content) return

    const senderId = msg.sender?.sender_id?.open_id ?? 'unknown'
    const conversationId = msg.chat_id
    const content = this.parseContent(msg.content)
    if (!content || content.text.trim().length === 0) return

    const identity = {
      platform: 'feishu' as const,
      conversationId,
      senderId,
    }
    if (!ctx.allowlist.allows(identity)) {
      await this.sendText(conversationId, '你还没有被授权使用此助手。', ctx)
      return
    }

    const { sessionId } = await ctx.sessions.resolve({
      platform: 'feishu',
      conversationId,
      senderId,
      createSessionId: async () => {
        const rec = await ctx.rivet.createSession(ctx.config.rivet.cwd)
        return rec.id
      },
      title: content.text.slice(0, 80),
    })

    await this.runSession(sessionId, content.text, conversationId, ctx)
  }

  private parseContent(raw: string): { text: string } | null {
    try {
      const parsed = JSON.parse(raw) as { text?: string }
      return { text: parsed.text ?? '' }
    } catch {
      return { text: raw }
    }
  }

  private async runSession(
    sessionId: string,
    text: string,
    conversationId: string,
    ctx: ChatAdapterContext
  ): Promise<void> {
    const { rivet, config } = ctx

    try {
      await rivet.prompt(sessionId, {
        text,
        approvalMode: config.security.approvalMode,
      })
    } catch (err) {
      await this.sendText(
        conversationId,
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
            await this.sendText(conversationId, chunk.text, ctx)
          }
        } else if (event.type === 'approval_required') {
          const requestId = String(event.requestId ?? '')
          const toolName = String(event.toolName ?? '')
          const url = ctx.config.publicUrl
            ? `${ctx.config.publicUrl}/approve?sessionId=${encodeURIComponent(sessionId)}&requestId=${encodeURIComponent(requestId)}&approved=true`
            : undefined
          await this.sendText(
            conversationId,
            url
              ? `⚠️ 天枢请求执行「${toolName}」，[点击确认](${url}) 或在 TUI/Desktop 中审批。`
              : `⚠️ 天枢请求执行「${toolName}」，请在 TUI/Desktop 中确认。`,
            ctx
          )
        } else if (event.type === 'error') {
          await this.sendText(conversationId, `执行出错：${String(event.message ?? event.error ?? '')}`, ctx)
        }
      },
      async (err) => {
        await this.sendText(conversationId, `流式响应中断：${err.message}`, ctx)
      }
    )

    // Abort after a generous timeout; real deployments may keep stream open longer.
    setTimeout(() => abort(), 10 * 60 * 1000)
  }

  async sendText(conversationId: string, text: string, ctx: ChatAdapterContext): Promise<void> {
    const token = await this.getTenantToken(ctx)
    if (!token) return

    const url = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        receive_id: conversationId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      console.error('[feishu] send failed:', res.status, body)
    }
  }

  private async getTenantToken(ctx: ChatAdapterContext): Promise<string | null> {
    const cfg = ctx.config.feishu
    if (!cfg.appId || !cfg.appSecret) return null

    if (this.tokenCache && this.tokenCache.expire > Date.now() / 1000 + 60) {
      return this.tokenCache.tenant_access_token
    }

    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    })
    if (!res.ok) {
      console.error('[feishu] token failed:', await res.text())
      return null
    }
    const data = (await res.json()) as { tenant_access_token: string; expire: number }
    this.tokenCache = data
    return data.tenant_access_token
  }
}
