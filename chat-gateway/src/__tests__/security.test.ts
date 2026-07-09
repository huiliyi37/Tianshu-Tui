import { describe, it } from 'node:test'
import assert from 'node:assert'
import { Allowlist, constantTimeCompare } from '../security.js'

describe('security', () => {
  it('allowlist permits exact and wildcard matches', () => {
    const list = Allowlist.parse(['feishu:ou_123', 'wechat:openid_456'])
    assert.strictEqual(
      list.allows({ platform: 'feishu', conversationId: 'chat_1', senderId: 'ou_123' }),
      true
    )
    assert.strictEqual(
      list.allows({ platform: 'wechat', conversationId: 'gh_1', senderId: 'openid_456' }),
      true
    )
    assert.strictEqual(
      list.allows({ platform: 'feishu', conversationId: 'chat_1', senderId: 'ou_999' }),
      false
    )
  })

  it('constantTimeCompare resists timing attacks', () => {
    assert.strictEqual(constantTimeCompare('abc', 'abc'), true)
    assert.strictEqual(constantTimeCompare('abc', 'abz'), false)
    assert.strictEqual(constantTimeCompare('abc', 'ab'), false)
  })
})
