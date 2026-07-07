import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { profileRegistry } from '../profile-registry.js'
import { recommendModelTier } from '../model-tier-policy.js'

describe('Flash worker profiles', () => {
  const flashProfiles = ['lint_fixer', 'test_scaffolder', 'import_organizer', 'doc_syncer', 'type_fixer', 'format_checker']

  it('all 6 Flash profiles are registered', () => {
    for (const name of flashProfiles) {
      const profile = profileRegistry.get(name)
      assert.ok(profile, `Profile ${name} should be registered`)
      assert.equal(profile.builtIn, true, `${name} should be built-in`)
    }
  })

  it('all Flash profiles have tierLock=cheap', () => {
    for (const name of flashProfiles) {
      const profile = profileRegistry.get(name)!
      assert.equal(profile.tierLock, 'cheap', `${name} should have tierLock=cheap`)
    }
  })

  it('write profiles have hands role', () => {
    const handProfiles = ['lint_fixer', 'test_scaffolder', 'import_organizer', 'doc_syncer', 'type_fixer']
    for (const name of handProfiles) {
      const profile = profileRegistry.get(name)!
      assert.equal(profile.role, 'hands', `${name} should have hands role`)
    }
  })

  it('format_checker has readonly role', () => {
    const profile = profileRegistry.get('format_checker')!
    assert.equal(profile.role, 'readonly')
  })

  it('all Flash profiles have expertise prompts', () => {
    for (const name of flashProfiles) {
      const profile = profileRegistry.get(name)!
      assert.ok(profile.expertisePrompt.length > 50, `${name} should have a substantial expertise prompt`)
    }
  })
})

describe('tierLock in recommendModelTier', () => {
  it('tierLock=cheap prevents escalation on consecutive failures', () => {
    const rec = recommendModelTier({
      profile: 'lint_fixer',
      kind: 'patch_proposal',
      objective: 'Fix lint errors',
      consecutiveFailures: 5,
    })
    assert.equal(rec.tier, 'cheap', 'tierLock should prevent escalation to strong')
    assert.ok(rec.reason.includes('tierLock'))
  })

  it('non-locked profiles still escalate on failures', () => {
    const rec = recommendModelTier({
      profile: 'patcher',
      kind: 'patch_proposal',
      objective: 'Apply code change',
      consecutiveFailures: 3,
    })
    assert.equal(rec.tier, 'strong')
    assert.ok(rec.reason.includes('failure'))
  })

  it('tierLock overrides all other heuristics', () => {
    const rec = recommendModelTier({
      authority: 'tianquan',
      profile: 'lint_fixer',
      kind: 'verify',
      riskTier: 'high',
      objective: 'critical lint fix',
    })
    assert.equal(rec.tier, 'cheap', 'Even tianquan + high risk + verify cannot override tierLock')
  })
})
