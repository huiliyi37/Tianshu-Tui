import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('isStarSoulEnabled', () => {
  const original = process.env['STAR_SOUL']

  function setEnv(val: string | undefined) {
    if (val === undefined) delete process.env['STAR_SOUL']
    else process.env['STAR_SOUL'] = val
  }

  it('defaults to enabled when STAR_SOUL is not set', async () => {
    setEnv(undefined)
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), true)
  })

  it('enabled when STAR_SOUL=1', async () => {
    setEnv('1')
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), true)
  })

  it('disabled when STAR_SOUL=0', async () => {
    setEnv('0')
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), false)
  })

  it('disabled when STAR_SOUL=false', async () => {
    setEnv('false')
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), false)
  })

  it('disabled when STAR_SOUL=False (case insensitive)', async () => {
    setEnv('False')
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), false)
  })

  it('enabled for any other value', async () => {
    setEnv('yes')
    const { isStarSoulEnabled } = await import('../star-soul-gate.js')
    assert.equal(isStarSoulEnabled(), true)
  })
})
