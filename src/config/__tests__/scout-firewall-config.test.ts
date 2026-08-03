import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { isScoutFirewallEnabled } from '../scout-firewall-config.js'

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.RIVET_SCOUT_FIREWALL
  if (value === undefined) delete process.env.RIVET_SCOUT_FIREWALL
  else process.env.RIVET_SCOUT_FIREWALL = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env.RIVET_SCOUT_FIREWALL
    else process.env.RIVET_SCOUT_FIREWALL = prev
  }
}

describe('isScoutFirewallEnabled', () => {
  it('env unset + config undefined → false（默认关）', () => {
    withEnv(undefined, () => {
      assert.equal(isScoutFirewallEnabled(undefined), false)
    })
  })

  it('env unset + config true → true', () => {
    withEnv(undefined, () => {
      assert.equal(isScoutFirewallEnabled(true), true)
    })
  })

  it('env=1 overrides config false → true', () => {
    withEnv('1', () => {
      assert.equal(isScoutFirewallEnabled(false), true)
    })
  })

  it('env=0 overrides config true → false（强制关）', () => {
    withEnv('0', () => {
      assert.equal(isScoutFirewallEnabled(true), false)
    })
  })

  it('accepts true/on/yes as enable', () => {
    for (const v of ['true', 'on', 'yes']) {
      withEnv(v, () => {
        assert.equal(isScoutFirewallEnabled(false), true, `env=${v}`)
      })
    }
  })

  it('accepts false/off/no as disable', () => {
    for (const v of ['false', 'off', 'no']) {
      withEnv(v, () => {
        assert.equal(isScoutFirewallEnabled(true), false, `env=${v}`)
      })
    }
  })
})
