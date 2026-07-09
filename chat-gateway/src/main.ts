#!/usr/bin/env node
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envAwareConfig } from './config.js'
import { RivetClient } from './rivet-client.js'
import { SessionMap } from './session-map.js'
import { Allowlist } from './security.js'
import { FeishuAdapter, WechatAdapter } from './adapters/index.js'
import type { ChatAdapter, ChatAdapterContext } from './adapters/index.js'

function dataDir(): string {
  const fromEnv = process.env.TIANSHU_CHAT_GATEWAY_DATA
  if (fromEnv) return fromEnv
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return join(home, '.rivet', 'chat-gateway')
}

async function main() {
  const config = envAwareConfig()
  const data = dataDir()
  mkdirSync(data, { recursive: true })

  const rivet = new RivetClient(config.rivet.baseUrl, config.rivet.token)
  const sessions = new SessionMap(join(data, 'sessions.sqlite'))
  const allowlist = Allowlist.parse(config.security.allowlist)

  const adapters: ChatAdapter[] = []
  if (config.feishu.enabled) adapters.push(new FeishuAdapter())
  if (config.wechat.enabled) adapters.push(new WechatAdapter())

  const ctx: ChatAdapterContext = {
    config,
    rivet,
    sessions,
    allowlist,
  }

  const app = new Hono()

  app.get('/health', (c) => c.json({ ok: true, adapters: adapters.map(a => a.platform) }))

  for (const adapter of adapters) {
    app.all(`/webhook/${adapter.platform}`, async (c) => {
      const req = c.req.raw
      const { status, body } = await adapter.handleWebhook(req, ctx)
      // WeChat verification expects raw string echostr, not JSON.
      if (typeof body === 'string') {
        return c.text(body, status as any)
      }
      return c.json(body, status as any)
    })
  }

  // Generic approval endpoint that any platform can link to.
  const handleApprove = async (c: any) => {
    const query = c.req.query()
    const body = c.req.method === 'POST' ? await c.req.json() : {}
    const sessionId = query.sessionId ?? body.sessionId
    const requestId = query.requestId ?? body.requestId
    const approved = (query.approved ?? body.approved) === 'true' || body.approved === true
    const reason = query.reason ?? body.reason
    if (!sessionId || !requestId) {
      return c.json({ error: 'Missing sessionId or requestId' }, 400)
    }
    try {
      await rivet.answerIntervention(sessionId, requestId, approved, reason)
      return c.json({ ok: true, approved })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
    }
  }
  app.get('/approve', handleApprove)
  app.post('/approve', handleApprove)

  // Fallback 404
  app.notFound((c) => c.json({ error: 'Not found' }, 404))

  serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  }, (info) => {
    console.log(`[gateway] listening on http://${config.host}:${config.port}`)
    console.log(`[gateway] rivet: ${config.rivet.baseUrl}`)
    console.log(`[gateway] adapters: ${adapters.map(a => a.platform).join(', ') || 'none'}`)
  })

  process.on('SIGINT', () => {
    sessions.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
