import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectActivation,
  type ActivationCandidate,
  type InvalidReason,
  type SelectionResult,
} from '../select-activation'

const NOW = 1_752_000_000_000
const DAY = 86_400_000

function expectValid(result: SelectionResult | null): ActivationCandidate {
  if (!result || !result.valid) assert.fail(`expected valid selection, got ${JSON.stringify(result)}`)
  return result.row
}

function expectInvalid(result: SelectionResult | null): { row: ActivationCandidate; reason: InvalidReason } {
  if (!result || result.valid) assert.fail(`expected invalid selection, got ${JSON.stringify(result)}`)
  return result
}

function row(overrides: Partial<ActivationCandidate>): ActivationCandidate {
  return {
    code: 'TS-XXXX-XXXX-XXXX',
    tier: 'pro',
    activationRevoked: false,
    codeRevoked: false,
    licenseExpires: null,
    activatedAt: NOW - 10 * DAY,
    ...overrides,
  }
}

test('无激活记录返回 null', () => {
  assert.equal(selectActivation([], NOW), null)
})

test('单条有效记录直接选中', () => {
  const r = row({ code: 'TS-ONLY' })
  const result = selectActivation([r], NOW)
  assert.deepEqual(result, { valid: true, row: r })
})

test('核心回归：试用已过期 + 正式码有效 → 选正式码，不误降级', () => {
  const trial = row({
    code: 'TS-TRIAL',
    licenseExpires: NOW - 2 * DAY,
    activatedAt: NOW - 12 * DAY,
  })
  const paid = row({
    code: 'TS-PAID',
    licenseExpires: null,
    activatedAt: NOW - 1 * DAY,
  })
  // 行序不应影响结果（D1 无 ORDER BY 时顺序不保证）
  for (const rows of [[trial, paid], [paid, trial]]) {
    const selected = expectValid(selectActivation(rows, NOW))
    assert.equal(selected.code, 'TS-PAID')
  }
})

test('试用未过期 + 正式永久码并存 → 选永久码', () => {
  const trial = row({ code: 'TS-TRIAL', licenseExpires: NOW + 5 * DAY })
  const paid = row({ code: 'TS-PAID', licenseExpires: null })
  const selected = expectValid(selectActivation([trial, paid], NOW))
  assert.equal(selected.code, 'TS-PAID')
})

test('tier 权重：max 优先于 pro，即使 pro 是永久授权', () => {
  const pro = row({ code: 'TS-PRO', tier: 'pro', licenseExpires: null })
  const max = row({ code: 'TS-MAX', tier: 'max', licenseExpires: NOW + 30 * DAY })
  const selected = expectValid(selectActivation([pro, max], NOW))
  assert.equal(selected.code, 'TS-MAX')
})

test('同 tier 限期授权取到期最晚的', () => {
  const short = row({ code: 'TS-SHORT', licenseExpires: NOW + 5 * DAY })
  const long = row({ code: 'TS-LONG', licenseExpires: NOW + 300 * DAY })
  const selected = expectValid(selectActivation([short, long], NOW))
  assert.equal(selected.code, 'TS-LONG')
})

test('已吊销的码不入选，即使 tier 更高', () => {
  const revokedMax = row({ code: 'TS-MAX', tier: 'max', codeRevoked: true })
  const pro = row({ code: 'TS-PRO', licenseExpires: NOW + 10 * DAY })
  const selected = expectValid(selectActivation([revokedMax, pro], NOW))
  assert.equal(selected.code, 'TS-PRO')
})

test('激活记录级吊销同样排除', () => {
  const revoked = row({ code: 'TS-A', activationRevoked: true })
  const ok = row({ code: 'TS-B', licenseExpires: NOW + DAY })
  const selected = expectValid(selectActivation([revoked, ok], NOW))
  assert.equal(selected.code, 'TS-B')
})

test('全部过期（未吊销）→ reason=license_expired', () => {
  const a = row({ code: 'TS-A', licenseExpires: NOW - 5 * DAY, activatedAt: NOW - 20 * DAY })
  const b = row({ code: 'TS-B', licenseExpires: NOW - 1 * DAY, activatedAt: NOW - 3 * DAY })
  const result = expectInvalid(selectActivation([a, b], NOW))
  assert.equal(result.reason, 'license_expired')
  assert.equal(result.row.code, 'TS-B')
})

test('过期与吊销并存 → 报 license_expired（可行动的 reason 优先）', () => {
  const revoked = row({ code: 'TS-REVOKED', codeRevoked: true })
  const expired = row({ code: 'TS-EXPIRED', licenseExpires: NOW - DAY })
  const result = expectInvalid(selectActivation([revoked, expired], NOW))
  assert.equal(result.reason, 'license_expired')
})

test('全部吊销 → reason=revoked', () => {
  const a = row({ code: 'TS-A', activationRevoked: true })
  const b = row({ code: 'TS-B', codeRevoked: true })
  const result = expectInvalid(selectActivation([a, b], NOW))
  assert.equal(result.reason, 'revoked')
})

test('完全并列时取激活时间最新的', () => {
  const old = row({ code: 'TS-OLD', licenseExpires: NOW + DAY, activatedAt: NOW - 9 * DAY })
  const recent = row({ code: 'TS-NEW', licenseExpires: NOW + DAY, activatedAt: NOW - DAY })
  const selected = expectValid(selectActivation([old, recent], NOW))
  assert.equal(selected.code, 'TS-NEW')
})

test('到期时刻恰好等于 now 视为有效（>= 语义）', () => {
  const edge = row({ code: 'TS-EDGE', licenseExpires: NOW })
  expectValid(selectActivation([edge], NOW))
})
