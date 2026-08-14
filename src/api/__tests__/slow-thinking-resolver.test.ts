/**
 * isSlowThinkingProvider 三级判定契约（2026-08-09，会话 mskl1neqgwksu66h 事故
 * 衍生修复）：自定义 provider 名（如 deepseek-spark）精确名匹配必漏判 →
 * thinking 流拿 90s/180s 紧窗口。判定链：显式配置 > 名称精确 > baseUrl host。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSlowThinkingProvider } from '../openai-client.js'

describe('isSlowThinkingProvider', () => {
  it('名称精确命中既有集合（行为不变）', () => {
    for (const name of ['glm', 'mimo', 'deepseek', 'codex', 'minimax']) {
      assert.equal(isSlowThinkingProvider({ providerName: name }), true, name)
    }
    assert.equal(isSlowThinkingProvider({ providerName: 'longcat' }), false)
    assert.equal(isSlowThinkingProvider({ providerName: 'openai' }), false)
    assert.equal(isSlowThinkingProvider({}), false)
  })

  it('baseUrl host 命中：自定义名称也能认出门户与中转', () => {
    // 事故事实：deepseek-spark 指向 DeepSeek 兼容端点
    assert.equal(isSlowThinkingProvider({ providerName: 'deepseek-spark', baseUrl: 'https://api.deepseek.com/v1' }), true)
    assert.equal(isSlowThinkingProvider({ providerName: 'custom-glm', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), true)
    assert.equal(isSlowThinkingProvider({ providerName: 'mine', baseUrl: 'https://api.xiaomimimo.com/v1' }), true)
    assert.equal(isSlowThinkingProvider({ providerName: 'mine', baseUrl: 'https://api.minimaxi.com/v1' }), true)
    assert.equal(isSlowThinkingProvider({ providerName: 'mine', baseUrl: 'https://chatgpt.com/backend-api/codex' }), true)
    // 自建中转：host 含特征字串即可
    assert.equal(isSlowThinkingProvider({ providerName: 'relay', baseUrl: 'https://deepseek-relay.internal.example.com/v1' }), true)
  })

  it('URL 不误判：无关 host / 路径含特征但 host 不含', () => {
    assert.equal(isSlowThinkingProvider({ providerName: 'foo', baseUrl: 'https://api.example.com/v1' }), false)
    // 特征字串只出现在 path 里不算（host 才是端点身份）
    assert.equal(isSlowThinkingProvider({ providerName: 'foo', baseUrl: 'https://api.example.com/deepseek/v1' }), false)
    assert.equal(isSlowThinkingProvider({ providerName: 'foo', baseUrl: 'http://127.0.0.1:8891/v1' }), false)
  })

  it('显式配置压过启发式（双向）', () => {
    // true 压过"名称/URL 都不慢"
    assert.equal(isSlowThinkingProvider({ providerName: 'openai', baseUrl: 'https://api.openai.com/v1', slowThinking: true }), true)
    // false 压过"名称命中"
    assert.equal(isSlowThinkingProvider({ providerName: 'deepseek', slowThinking: false }), false)
    // false 压过"URL 命中"
    assert.equal(isSlowThinkingProvider({ baseUrl: 'https://api.deepseek.com/v1', slowThinking: false }), false)
  })

  it('非法 baseUrl 不炸，退回名称判定', () => {
    assert.equal(isSlowThinkingProvider({ providerName: 'deepseek', baseUrl: 'not-a-url' }), true)
    assert.equal(isSlowThinkingProvider({ providerName: 'foo', baseUrl: 'not-a-url' }), false)
  })
})
