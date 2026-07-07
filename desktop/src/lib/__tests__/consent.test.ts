import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isApprovalConsent } from '../consent.ts'

test('recognizes whole-message zh consent tokens', () => {
  for (const t of ['继续', '继续执行', '继续执行!', '同意', '批准', '去做吧', '执行', '可以', '好的', '确认']) {
    assert.equal(isApprovalConsent(t), true, `should accept: ${t}`)
  }
})

test('recognizes whole-message en consent tokens (case/punct insensitive)', () => {
  for (const t of ['ok', 'OK', 'yes', 'Y', 'go', 'go ahead', 'approve', 'proceed', 'continue', 'do it', 'Approved.']) {
    assert.equal(isApprovalConsent(t), true, `should accept: ${t}`)
  }
})

test('rejects qualified or longer messages (not blanket approval)', () => {
  for (const t of [
    '继续，但先读一下文件',
    'approve only the rename',
    '继续执行然后跑测试',
    '不要',
    'no',
    '先别',
    'edit the config file',
    '',
    '   ',
  ]) {
    assert.equal(isApprovalConsent(t), false, `should reject: ${JSON.stringify(t)}`)
  }
})
