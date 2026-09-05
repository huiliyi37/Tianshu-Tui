/**
 * Host 策略与远程可达性测试（P1 Mobile Remote）。
 *
 * 覆盖：startServer host 绑定、Host header 三分支判定（回环 / allowlist / LAN 放行）、
 * Bearer 强制、CORS 头回归、GET /remote/info 端点。
 *
 * 基建说明：node fetch 禁止设置 Host 头（forbidden header），而 Host 判定正是被测对象，
 * 因此用原始 socket HTTP 请求（rawRequest）精确控制 Host 行（含「无 Host 行」形态，
 * HTTP/1.0 客户端）。
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { startServer } from '../index.js'
import { buildRemoteInfoRoutes } from '../remote-info-routes.js'

const TOKEN = 'test-token-abc'

/** 原始 HTTP 请求：精确控制 Host 行。hostHeader === null 时不发 Host 行。 */
function rawRequest(
  port: number,
  opts: { path?: string; method?: string; httpVersion?: string; hostHeader?: string | null; extraHeaders?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      const lines = [`${opts.method ?? 'GET'} ${opts.path ?? '/'} ${opts.httpVersion ?? 'HTTP/1.1'}`]
      if (opts.hostHeader !== null) {
        lines.push(`Host: ${opts.hostHeader ?? `127.0.0.1:${port}`}`)
      }
      for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) lines.push(`${k}: ${v}`)
      lines.push('Connection: close', '', '')
      sock.write(lines.join('\r\n'))
    })
    let data = ''
    sock.on('data', (c) => { data += c.toString() })
    sock.on('end', () => {
      const idx = data.indexOf('\r\n\r\n')
      if (idx < 0) { reject(new Error(`malformed response: ${data.slice(0, 200)}`)); return }
      const head = data.slice(0, idx)
      const headLines = head.split('\r\n')
      const status = Number(headLines[0]?.split(' ')[1])
      const headers: Record<string, string> = {}
      for (const l of headLines.slice(1)) {
        const i = l.indexOf(':')
        if (i > 0) headers[l.slice(0, i).toLowerCase().trim()] = l.slice(i + 1).trim()
      }
      // Node 对无 Content-Length 的响应自动 chunked——按帧解码，否则 body 带帧前缀。
      let body = data.slice(idx + 4)
      if (headers['transfer-encoding'] === 'chunked') {
        let out = ''
        let rest = body
        while (rest.length > 0) {
          const lineEnd = rest.indexOf('\r\n')
          if (lineEnd < 0) break
          const size = parseInt(rest.slice(0, lineEnd), 16)
          if (!Number.isFinite(size) || size <= 0) break
          out += rest.slice(lineEnd + 2, lineEnd + 2 + size)
          rest = rest.slice(lineEnd + 2 + size + 2)
        }
        body = out
      }
      resolve({ status, headers, body })
    })
    sock.on('error', reject)
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('rawRequest timeout')) })
  })
}

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` })

async function startTestServer(opts: { host?: string; allowedHosts?: string[]; withRemoteInfo?: boolean } = {}) {
  const routes: Record<string, never> = {}
  const srv = await startServer(
    0,
    {
      'GET /ping': () => ({ status: 200, body: { ok: true } }),
      'GET /health': () => ({ status: 200, body: { ok: true } }),
      ...(opts.withRemoteInfo
        ? buildRemoteInfoRoutes(TOKEN, { host: opts.host ?? '127.0.0.1', allowedHosts: opts.allowedHosts })
        : {}),
    },
    TOKEN,
    { host: opts.host ?? '127.0.0.1', allowedHosts: opts.allowedHosts },
  )
  return {
    port: srv.port,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
    routes,
  }
}

const servers: Array<() => Promise<void>> = []
after(async () => {
  for (const close of servers.splice(0)) await close()
})

async function withServer(opts: Parameters<typeof startTestServer>[0], fn: (s: { port: number }) => Promise<void>) {
  const s = await startTestServer(opts)
  servers.push(s.close)
  try {
    await fn(s)
  } finally {
    const idx = servers.indexOf(s.close)
    if (idx >= 0) servers.splice(idx, 1)
    await s.close()
  }
}

describe('loopback default bind (127.0.0.1)', () => {
  test('accepts loopback host with actual port', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('accepts localhost host', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `localhost:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('accepts loopback host without port (HTTP/1.0 style)', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '127.0.0.1', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('omits Host line entirely -> allowed (HTTP/1.0 no-Host client)', async () => {
    await withServer({}, async ({ port }) => {
      // Node 解析层强制 HTTP/1.1 必须带 Host（400 早于应用层）；真实无 Host
      // 客户端形态是 HTTP/1.0——原注释「无 Host（HTTP/1.0 工具）放行」所指。
      const r = await rawRequest(port, { path: '/ping', httpVersion: 'HTTP/1.0', hostHeader: null, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('rejects foreign host before auth (403 not 401)', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 403)
      const r2 = await rawRequest(port, { hostHeader: 'evil.com' })
      assert.equal(r2.status, 403)
    })
  })
  test('rejects loopback with wrong port', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: `127.0.0.1:${port + 1}`, extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
  test('rejects non-loopback IPv6 literal', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: '[::ffff:192.168.1.5]', extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
})

describe('LAN bind (0.0.0.0) — bearer-gated host passthrough', () => {
  test('foreign host with bearer is accepted', async () => {
    await withServer({ host: '0.0.0.0' }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('foreign host without bearer -> 401', async () => {
    await withServer({ host: '0.0.0.0' }, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com' })
      assert.equal(r.status, 401)
    })
  })
  test('/health stays token-exempt on foreign host (cold-start probe)', async () => {
    await withServer({ host: '0.0.0.0' }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/health', hostHeader: 'evil.com' })
      assert.equal(r.status, 200)
    })
  })
})

describe('allowlist (RIVET_SERVE_HOSTS_ALLOW)', () => {
  test('allowlisted host accepted on loopback bind', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '192.168.1.5', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('allowlisted host accepted with arbitrary port', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: '192.168.1.5:9999', extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('non-allowlisted host rejected even with bearer', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
  test('loopback still accepted when allowlist configured', async () => {
    await withServer({ allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/ping', hostHeader: `localhost:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
    })
  })
  test('allowlist tightens LAN mode too (no implicit passthrough)', async () => {
    await withServer({ host: '0.0.0.0', allowedHosts: ['192.168.1.5'] }, async ({ port }) => {
      const r = await rawRequest(port, { hostHeader: 'evil.com', extraHeaders: auth() })
      assert.equal(r.status, 403)
    })
  })
})

describe('CORS regression', () => {
  test('known webview origin gets ACAO reflection', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { method: 'OPTIONS', hostHeader: `127.0.0.1:${port}`, extraHeaders: { origin: 'tauri://localhost', 'access-control-request-method': 'GET' } })
      assert.equal(r.status, 204)
      assert.equal(r.headers['access-control-allow-origin'], 'tauri://localhost')
    })
  })
  test('unknown origin gets no CORS headers', async () => {
    await withServer({}, async ({ port }) => {
      const r = await rawRequest(port, { method: 'OPTIONS', hostHeader: `127.0.0.1:${port}`, extraHeaders: { origin: 'https://evil.example' } })
      assert.equal(r.status, 204)
      assert.equal(r.headers['access-control-allow-origin'], undefined)
    })
  })
})

describe('GET /remote/info', () => {
  test('loopback bind reports mode loopback', async () => {
    await withServer({ withRemoteInfo: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/remote/info', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
      const body = JSON.parse(r.body)
      assert.equal(body.mode, 'loopback')
      assert.equal(body.listenHost, '127.0.0.1')
      assert.ok(Array.isArray(body.lanUrls))
    })
  })
  test('LAN bind reports mode lan', async () => {
    await withServer({ host: '0.0.0.0', withRemoteInfo: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/remote/info', hostHeader: `127.0.0.1:${port}`, extraHeaders: auth() })
      assert.equal(r.status, 200)
      const body = JSON.parse(r.body)
      assert.equal(body.mode, 'lan')
      assert.equal(body.listenHost, '0.0.0.0')
    })
  })
  test('requires bearer token', async () => {
    await withServer({ withRemoteInfo: true }, async ({ port }) => {
      const r = await rawRequest(port, { path: '/remote/info', hostHeader: `127.0.0.1:${port}` })
      assert.equal(r.status, 401)
    })
  })
})
