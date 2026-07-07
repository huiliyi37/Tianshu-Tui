import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_DELEGATE_PROFILE } from '../../../agent/profile-registry.js'
import { delegationProfileFromInput, delegationObjectiveFromInput } from '../tool-domain.js'

describe('delegationProfileFromInput', () => {
  it('uses input.profile when present', () => {
    assert.equal(
      delegationProfileFromInput('delegate_task', { profile: 'reviewer', objective: 'x' }),
      'reviewer',
    )
  })

  it('defaults delegate_task to DEFAULT_DELEGATE_PROFILE', () => {
    assert.equal(delegationProfileFromInput('delegate_task', { objective: 'x' }), DEFAULT_DELEGATE_PROFILE)
  })

  it('falls back to tool name for team_orchestrate', () => {
    assert.equal(delegationProfileFromInput('team_orchestrate', { objective: 'plan' }), 'team_orchestrate')
  })
})

describe('delegationObjectiveFromInput', () => {
  it('truncates long objectives', () => {
    const long = 'a'.repeat(100)
    assert.equal(delegationObjectiveFromInput({ objective: long }, 10).length, 10)
  })
})
