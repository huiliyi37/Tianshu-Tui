import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDomainDriftNudge } from '../domain-drift-nudge.js'

test('domain drift nudge explains cache safety and the handoff path', () => {
  const message = formatDomainDriftNudge({
    currentId: 'tianliang',
    currentName: '天梁',
    recommendedId: 'tianquan',
    recommendedName: '天权',
    matchedKeywords: ['审查', '方案'],
  })

  assert.match(message, /从「天梁」转为「天权」/)
  assert.match(message, /当前会话保持不变/)
  assert.match(message, /重建前缀缓存/)
  assert.match(message, /\/handoff/)
  assert.match(message, /新开会话/)
})
