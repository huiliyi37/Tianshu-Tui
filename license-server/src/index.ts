import { importPrivateKey, derivePublicKey, verifyTokenSignature, signToken, decodePayload, type TokenPayload } from './token'
import { adminPage } from './admin-html'

export interface Env {
  DB: D1Database
  SIGNING_KEY_PKCS8: string
  PRODUCT: string
  TOKEN_TTL_DAYS: string
  /** Admin dashboard bearer token (set via `wrangler secret put ADMIN_TOKEN`). */
  ADMIN_TOKEN: string
}

interface CodeRow {
  code: string
  tier: string
  max_activations: number
  used_count: number
  license_expires: number | null
  revoked: number
  note: string | null
  created_at: number
}

interface ActivationRow {
  device_id: string
  code: string
  revoked: number
  activated_at: number
  last_seen_at: number | null
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })

const DEVICE_RE = /^[A-Za-z0-9._:-]{8,128}$/
const CODE_RE = /^[A-Za-z0-9-]{8,64}$/

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // ── Public endpoints ──────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') return json({ ok: true })

    // ── Admin dashboard ───────────────────────────────────────────────
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(adminPage, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (url.pathname.startsWith('/admin/api/')) {
      return handleAdmin(req, url, env)
    }

    // ── Activation endpoints ──────────────────────────────────────────
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return json({ error: 'bad_json' }, 400)
    }

    if (url.pathname === '/activate') return activate(body, env)
    if (url.pathname === '/verify') return verify(body, env)
    return json({ error: 'not_found' }, 404)
  },
}

// ── Admin API ────────────────────────────────────────────────────────

function checkAdmin(req: Request, env: Env): boolean {
  const auth = req.headers.get('authorization') ?? ''
  return auth === `Bearer ${env.ADMIN_TOKEN}`
}

/** Convert D1 snake_case code row to camelCase JSON for the admin API. */
function toCamelCode(r: CodeRow): Record<string, unknown> {
  return {
    code: r.code,
    tier: r.tier,
    maxActivations: r.max_activations,
    usedCount: r.used_count,
    licenseExpires: r.license_expires,
    revoked: r.revoked,
    note: r.note,
    createdAt: r.created_at,
  }
}

/** Convert D1 snake_case activation row to camelCase JSON. */
function toCamelDevice(r: ActivationRow): Record<string, unknown> {
  return {
    deviceId: r.device_id,
    code: r.code,
    revoked: r.revoked,
    activatedAt: r.activated_at,
    lastSeenAt: r.last_seen_at,
  }
}

async function handleAdmin(req: Request, url: URL, env: Env): Promise<Response> {
  if (!env.ADMIN_TOKEN) return json({ error: 'admin_not_configured' }, 503)
  if (!checkAdmin(req, env)) return json({ error: 'unauthorized' }, 401)

  const path = url.pathname.replace('/admin/api/', '')

  // GET /admin/api/codes — list all codes with activation stats
  if (path === 'codes' && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT code, tier, max_activations, used_count, license_expires, revoked, note, created_at
       FROM codes ORDER BY created_at DESC`,
    ).all<CodeRow>()
    return json({ codes: (results ?? []).map(toCamelCode) })
  }

  // POST /admin/api/codes — generate N codes
  if (path === 'codes' && req.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return json({ error: 'bad_json' }, 400)
    }
    const count = Math.min(Number(body.count ?? 1), 500)
    const tier = String(body.tier ?? 'pro')
    const devices = Number(body.maxActivations ?? body.devices ?? 2)
    const days = body.licenseDays != null ? Number(body.licenseDays) : (body.days != null ? Number(body.days) : null)
    const note = body.note != null ? String(body.note) : null

    if (count < 1) return json({ error: 'invalid_count' }, 400)
    if (devices < 1) return json({ error: 'invalid_devices' }, 400)

    const licenseExpires = days != null ? Date.now() + days * 86_400_000 : null
    const now = Date.now()
    const codes: string[] = []
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

    for (let i = 0; i < count; i++) {
      const code = `TS-${randGroup(ALPHABET)}-${randGroup(ALPHABET)}-${randGroup(ALPHABET)}`
      codes.push(code)
      const lic = licenseExpires == null ? 'NULL' : String(licenseExpires)
      const noteSql = note ? `'${note.replace(/'/g, "''")}'` : 'NULL'
      await env.DB.prepare(
        `INSERT INTO codes (code, tier, max_activations, used_count, license_expires, revoked, note, created_at)
         VALUES (?, ?, ?, 0, ${lic}, 0, ${noteSql}, ?)`,
      )
        .bind(code, tier, devices, now)
        .run()
    }
    return json({ created: codes.length, codes })
  }

  // PATCH /admin/api/codes/:code — revoke / restore / update max_activations
  const codeMatch = path.match(/^codes\/(.+)$/)
  if (codeMatch && req.method === 'PATCH') {
    const code = codeMatch[1]!
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return json({ error: 'bad_json' }, 400)
    }

    const updates: string[] = []
    const binds: unknown[] = []

    if (body.revoked === true) {
      updates.push('revoked = 1')
    } else if (body.revoked === false) {
      updates.push('revoked = 0')
    }
    if (body.maxActivations != null) {
      updates.push('max_activations = ?')
      binds.push(Number(body.maxActivations))
    }
    if (body.note != null) {
      updates.push('note = ?')
      binds.push(String(body.note))
    }
    if (updates.length === 0) return json({ error: 'no_fields' }, 400)

    binds.push(code)
    const result = await env.DB.prepare(
      `UPDATE codes SET ${updates.join(', ')} WHERE code = ?`,
    )
      .bind(...binds)
      .run()

    if (result.meta.changes === 0) return json({ error: 'code_not_found' }, 404)
    return json({ ok: true })
  }

  // GET /admin/api/codes/:code/devices — list devices bound to a code
  const devMatch = path.match(/^codes\/(.+)\/devices$/)
  if (devMatch && req.method === 'GET') {
    const code = devMatch[1]!
    const { results } = await env.DB.prepare(
      `SELECT device_id, code, revoked, activated_at, last_seen_at
       FROM activations WHERE code = ? ORDER BY activated_at DESC`,
    )
      .bind(code)
      .all<ActivationRow>()
    return json({ devices: (results ?? []).map(toCamelDevice) })
  }

  // DELETE /admin/api/codes/:code — delete a code (only if unused)
  if (codeMatch && req.method === 'DELETE') {
    const code = codeMatch[1]!
    const row = await env.DB.prepare('SELECT used_count FROM codes WHERE code = ?')
      .bind(code)
      .first<{ used_count: number }>()
    if (!row) return json({ error: 'code_not_found' }, 404)
    if (row.used_count > 0) return json({ error: 'code_in_use', usedCount: row.used_count }, 409)
    await env.DB.prepare('DELETE FROM codes WHERE code = ?').bind(code).run()
    return json({ ok: true })
  }

  return json({ error: 'not_found' }, 404)
}

function randGroup(alphabet: string): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  let s = ''
  for (let i = 0; i < 4; i++) s += alphabet[bytes[i]! % alphabet.length]
  return s
}

// ── Token issuance ───────────────────────────────────────────────────

async function issueToken(
  env: Env,
  deviceId: string,
  tier: string,
  licenseExpires: number | null,
): Promise<{ token: string; exp: number }> {
  const key = await importPrivateKey(env.SIGNING_KEY_PKCS8)
  return issueTokenWithKey(env, deviceId, tier, licenseExpires, key)
}

/** Issue a token using a pre-imported key (avoids a second import in /verify). */
async function issueTokenWithKey(
  env: Env,
  deviceId: string,
  tier: string,
  licenseExpires: number | null,
  key: CryptoKey,
): Promise<{ token: string; exp: number }> {
  const now = Date.now()
  const ttlMs = Number(env.TOKEN_TTL_DAYS || '30') * 86_400_000
  let exp = now + ttlMs
  if (licenseExpires != null && licenseExpires < exp) exp = licenseExpires
  const payload: TokenPayload = {
    product: env.PRODUCT,
    deviceId,
    tier,
    iat: now,
    exp,
    lic: licenseExpires,
  }
  return { token: await signToken(payload, key), exp }
}

// ── Activation endpoints ─────────────────────────────────────────────

async function activate(body: Record<string, unknown>, env: Env): Promise<Response> {
  const code = String(body.code ?? '').trim()
  const deviceId = String(body.deviceId ?? '').trim()
  if (!CODE_RE.test(code)) return json({ error: 'invalid_code_format' }, 400)
  if (!DEVICE_RE.test(deviceId)) return json({ error: 'invalid_device_id' }, 400)

  const row = await env.DB.prepare(
    'SELECT code, tier, max_activations, used_count, license_expires, revoked FROM codes WHERE code = ?',
  )
    .bind(code)
    .first<CodeRow>()

  if (!row) return json({ error: 'code_not_found' }, 404)
  if (row.revoked) return json({ error: 'code_revoked' }, 403)
  if (row.license_expires != null && row.license_expires < Date.now())
    return json({ error: 'license_expired' }, 403)

  const existing = await env.DB.prepare(
    'SELECT device_id, code, revoked FROM activations WHERE device_id = ? AND code = ?',
  )
    .bind(deviceId, code)
    .first<ActivationRow>()

  const now = Date.now()
  if (existing) {
    if (existing.revoked) return json({ error: 'activation_revoked' }, 403)
    await env.DB.prepare('UPDATE activations SET last_seen_at = ? WHERE device_id = ? AND code = ?')
      .bind(now, deviceId, code)
      .run()
  } else {
    if (row.used_count >= row.max_activations) return json({ error: 'activation_limit_reached' }, 409)
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO activations (device_id, code, activated_at, last_seen_at, revoked) VALUES (?, ?, ?, ?, 0)',
      ).bind(deviceId, code, now, now),
      env.DB.prepare('UPDATE codes SET used_count = used_count + 1 WHERE code = ?').bind(code),
    ])
  }

  const { token, exp } = await issueToken(env, deviceId, row.tier, row.license_expires)
  return json({ token, expiresAt: exp, tier: row.tier, licenseExpires: row.license_expires })
}

async function verify(body: Record<string, unknown>, env: Env): Promise<Response> {
  const token = String(body.token ?? '')
  const deviceId = String(body.deviceId ?? '').trim()

  const privateKey = await importPrivateKey(env.SIGNING_KEY_PKCS8)
  const publicKey = await derivePublicKey(privateKey)
  if (!(await verifyTokenSignature(token, publicKey)))
    return json({ valid: false, reason: 'bad_signature' }, 200)

  const payload = decodePayload(token)
  if (!payload || payload.product !== env.PRODUCT)
    return json({ valid: false, reason: 'malformed' }, 200)
  if (payload.deviceId !== deviceId) return json({ valid: false, reason: 'device_mismatch' }, 200)

  const act = await env.DB.prepare(
    'SELECT a.revoked AS a_revoked, c.revoked AS c_revoked, c.license_expires AS lic, c.tier AS tier, a.code AS code FROM activations a JOIN codes c ON a.code = c.code WHERE a.device_id = ?',
  )
    .bind(deviceId)
    .first<{ a_revoked: number; c_revoked: number; lic: number | null; tier: string; code: string }>()

  if (!act) return json({ valid: false, reason: 'not_activated' }, 200)
  if (act.a_revoked || act.c_revoked) return json({ valid: false, reason: 'revoked' }, 200)
  if (act.lic != null && act.lic < Date.now()) return json({ valid: false, reason: 'license_expired' }, 200)

  await env.DB.prepare('UPDATE activations SET last_seen_at = ? WHERE device_id = ? AND code = ?')
    .bind(Date.now(), deviceId, act.code)
    .run()

  const { token: refreshed, exp } = await issueTokenWithKey(env, deviceId, act.tier, act.lic, privateKey)
  return json({ valid: true, token: refreshed, expiresAt: exp, tier: act.tier, licenseExpires: act.lic })
}
