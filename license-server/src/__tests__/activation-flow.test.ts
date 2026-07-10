// activate / verify 端到端流程测试。
// 用 node:sqlite 模拟 D1（同为 SQLite 方言），走真实 Worker fetch handler，
// 覆盖：试用码回填、一台设备一次试用、幂等重激活、以及"试用过期后购买
// 正式码，心跳 verify 不回退"这条主转化路径。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker, { type Env } from '../index'

const DAY = 86_400_000
const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema.sql'),
  'utf8',
)

type SqlValue = string | number | null

/** node:sqlite 适配为 handler 用到的 D1 窄接口（prepare/bind/first/all/run/batch）。 */
function fakeD1(db: DatabaseSync): Env['DB'] {
  const prepare = (sql: string) => {
    let bound: SqlValue[] = []
    const stmt = {
      bind(...args: SqlValue[]) {
        bound = args
        return stmt
      },
      async first<T>() {
        return (db.prepare(sql).get(...bound) ?? null) as T | null
      },
      async all<T>() {
        return { results: db.prepare(sql).all(...bound) as T[] }
      },
      async run() {
        const r = db.prepare(sql).run(...bound)
        return { meta: { changes: Number(r.changes) } }
      },
    }
    return stmt
  }
  const batch = async (stmts: Array<{ run: () => Promise<unknown> }>) => {
    const out = []
    for (const s of stmts) out.push(await s.run())
    return out
  }
  return { prepare, batch } as unknown as Env['DB']
}

let env: Env
let db: DatabaseSync

before(async () => {
  db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString(
    'base64',
  )
  env = {
    DB: fakeD1(db),
    SIGNING_KEY_PKCS8: pkcs8,
    PRODUCT: 'tianshu-desktop',
    TOKEN_TTL_DAYS: '30',
    ADMIN_TOKEN: 'test-admin',
  }
})

type WorkerRequest = Parameters<typeof worker.fetch>[0]

async function call(
  path: string,
  body: Record<string, unknown>,
  opts: { admin?: boolean; method?: string } = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.admin) headers['authorization'] = 'Bearer test-admin'
  const req = new Request(`https://license.test${path}`, {
    method: opts.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const res = await worker.fetch(req as unknown as WorkerRequest, env)
  return { status: res.status, data: (await res.json()) as Record<string, unknown> }
}

async function genCodes(body: Record<string, unknown>): Promise<string[]> {
  const { status, data } = await call('/admin/api/codes', body, { admin: true })
  assert.equal(status, 200, `code generation failed: ${JSON.stringify(data)}`)
  return data.codes as string[]
}

test('trialDays 与 licenseDays 互斥', async () => {
  const { status, data } = await call(
    '/admin/api/codes',
    { count: 1, trialDays: 10, licenseDays: 365 },
    { admin: true },
  )
  assert.equal(status, 400)
  assert.equal(data.error, 'trial_days_conflicts_license_days')
})

test('试用码强制单设备，生成时不写死到期日', async () => {
  const [code] = await genCodes({ count: 1, trialDays: 10, maxActivations: 5 })
  const row = db
    .prepare('SELECT max_activations, license_expires, trial_days FROM codes WHERE code = ?')
    .get(code!) as { max_activations: number; license_expires: number | null; trial_days: number }
  assert.equal(row.max_activations, 1)
  assert.equal(row.license_expires, null)
  assert.equal(row.trial_days, 10)
})

test('试用码首次激活：从激活时刻起算回填到期日', async () => {
  const [code] = await genCodes({ count: 1, trialDays: 10 })
  const before = Date.now()
  const { status, data } = await call('/activate', { code, deviceId: 'device-trial-01' })
  assert.equal(status, 200)
  const lic = data.licenseExpires as number
  assert.ok(
    lic >= before + 10 * DAY && lic <= Date.now() + 10 * DAY + 1000,
    `licenseExpires ${lic} 应约等于激活时刻 + 10 天`,
  )
  // 回填落库
  const row = db.prepare('SELECT license_expires FROM codes WHERE code = ?').get(code!) as {
    license_expires: number
  }
  assert.equal(row.license_expires, lic)
})

test('同一设备重复激活同一试用码幂等，到期日不变', async () => {
  const [code] = await genCodes({ count: 1, trialDays: 7 })
  const first = await call('/activate', { code, deviceId: 'device-trial-02' })
  assert.equal(first.status, 200)
  const again = await call('/activate', { code, deviceId: 'device-trial-02' })
  assert.equal(again.status, 200)
  assert.equal(again.data.licenseExpires, first.data.licenseExpires)
})

test('一台设备一生一次试用：换码兑换被拒', async () => {
  const [first, second] = await genCodes({ count: 2, trialDays: 10 })
  const ok = await call('/activate', { code: first, deviceId: 'device-trial-03' })
  assert.equal(ok.status, 200)
  const rejected = await call('/activate', { code: second, deviceId: 'device-trial-03' })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.data.error, 'trial_already_used')
})

test('试用记录已过期后换码仍被拒（历史记录也算）', async () => {
  const [first, second] = await genCodes({ count: 2, trialDays: 10 })
  const ok = await call('/activate', { code: first, deviceId: 'device-trial-04' })
  assert.equal(ok.status, 200)
  db.prepare('UPDATE codes SET license_expires = ? WHERE code = ?').run(Date.now() - DAY, first!)
  const rejected = await call('/activate', { code: second, deviceId: 'device-trial-04' })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.data.error, 'trial_already_used')
})

test('试用不挡正式码：试用过期后激活正式码成功', async () => {
  const device = 'device-convert-01'
  const [trial] = await genCodes({ count: 1, trialDays: 10 })
  const trialAct = await call('/activate', { code: trial, deviceId: device })
  assert.equal(trialAct.status, 200)
  db.prepare('UPDATE codes SET license_expires = ? WHERE code = ?').run(Date.now() - DAY, trial!)

  const [paid] = await genCodes({ count: 1 })
  const paidAct = await call('/activate', { code: paid, deviceId: device })
  assert.equal(paidAct.status, 200)
  assert.equal(paidAct.data.licenseExpires, null)
})

test('核心回归：试用过期 + 正式码有效，verify 心跳选正式码不回退', async () => {
  const device = 'device-convert-02'
  const [trial] = await genCodes({ count: 1, trialDays: 10 })
  await call('/activate', { code: trial, deviceId: device })
  db.prepare('UPDATE codes SET license_expires = ? WHERE code = ?').run(Date.now() - DAY, trial!)

  const [paid] = await genCodes({ count: 1, licenseDays: 365 })
  const paidAct = await call('/activate', { code: paid, deviceId: device })
  assert.equal(paidAct.status, 200)

  const { status, data } = await call('/verify', { token: paidAct.data.token, deviceId: device })
  assert.equal(status, 200)
  assert.equal(data.valid, true, `verify 应有效: ${JSON.stringify(data)}`)
  assert.equal(data.licenseExpires, paidAct.data.licenseExpires)
})

test('verify：设备只有过期试用时报 license_expired', async () => {
  const device = 'device-expired-only'
  const [trial] = await genCodes({ count: 1, trialDays: 10 })
  const act = await call('/activate', { code: trial, deviceId: device })
  assert.equal(act.status, 200)
  db.prepare('UPDATE codes SET license_expires = ? WHERE code = ?').run(Date.now() - DAY, trial!)

  const { data } = await call('/verify', { token: act.data.token, deviceId: device })
  assert.equal(data.valid, false)
  assert.equal(data.reason, 'license_expired')
})

test('正式码不受试用防重限制', async () => {
  const device = 'device-normal-01'
  const [a, b] = await genCodes({ count: 2, licenseDays: 365 })
  const first = await call('/activate', { code: a, deviceId: device })
  assert.equal(first.status, 200)
  const second = await call('/activate', { code: b, deviceId: device })
  assert.equal(second.status, 200)
})
