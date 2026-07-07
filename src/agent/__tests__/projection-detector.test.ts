import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectionDetector } from '../projection-detector.js'

describe('ProjectionDetector', () => {
  it('returns null before anchor is sealed', () => {
    const detector = new ProjectionDetector()
    assert.equal(detector.check('anything'), null)
  })

  it('returns null for independent output', () => {
    const detector = new ProjectionDetector()
    detector.sealAnchor('重构 auth 模块支持 OAuth2')
    const warning = detector.check('文件系统使用 inode 管理元数据')
    assert.equal(warning, null)
  })

  it('returns warning for anchor-dominated output', () => {
    const detector = new ProjectionDetector()
    detector.sealAnchor('重构 auth 模块支持 OAuth2')
    const warning = detector.check('auth auth auth OAuth2 auth OAuth2 重构 auth 模块 auth')
    assert.ok(warning !== null)
    assert.ok(warning.score > 0.3)
    assert.ok(warning.message.includes('anti-anchor'))
  })

  it('respects custom threshold', () => {
    const detector = new ProjectionDetector({ threshold: 0.8 })
    detector.sealAnchor('auth OAuth2')
    // moderate usage — below 0.8 threshold
    const warning = detector.check('auth is used for OAuth2 authentication flow design')
    assert.equal(warning, null)
  })

  it('deletionTest detects plan collapse', () => {
    const detector = new ProjectionDetector()
    detector.sealAnchor('auth OAuth2 token')
    assert.ok(detector.deletionTest('auth OAuth2 token auth token OAuth2 auth'))
    assert.ok(!detector.deletionTest('定义接口契约，实现刷新机制，集成测试覆盖'))
  })
})
