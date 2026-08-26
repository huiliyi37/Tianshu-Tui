import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPermissionChrome,
  formatPermissionLabel,
  modeToTier,
  parsePermissionAlias,
  tierToMode,
} from '../approval-vocabulary.js'

describe('modeToTier', () => {
  it('maps the three public wires', () => {
    assert.equal(modeToTier('manual'), 'supervise')
    assert.equal(modeToTier('auto-safe'), 'auto')
    assert.equal(modeToTier('dangerously-skip-permissions'), 'unattended')
  })

  it('treats auto-accept and unknown as 自动, not 全自动', () => {
    assert.equal(modeToTier('auto-accept'), 'auto')
    assert.equal(modeToTier(undefined), 'auto')
    assert.equal(modeToTier('suggest'), 'auto')
  })
})

describe('tierToMode', () => {
  it('never emits auto-accept', () => {
    assert.equal(tierToMode('supervise'), 'manual')
    assert.equal(tierToMode('auto'), 'auto-safe')
    assert.equal(tierToMode('unattended'), 'dangerously-skip-permissions')
  })
})

describe('parsePermissionAlias', () => {
  it('accepts old and new tokens', () => {
    assert.equal(parsePermissionAlias('manual'), 'supervise')
    assert.equal(parsePermissionAlias('supervise'), 'supervise')
    assert.equal(parsePermissionAlias('auto'), 'auto')
    assert.equal(parsePermissionAlias('default'), 'auto')
    assert.equal(parsePermissionAlias('yolo'), 'unattended')
    assert.equal(parsePermissionAlias('yes'), 'unattended')
    assert.equal(parsePermissionAlias('autonomous'), 'unattended')
    assert.equal(parsePermissionAlias('unattended'), 'unattended')
    assert.equal(parsePermissionAlias('YOLO'), 'unattended')
  })

  it('rejects auto-accept and junk', () => {
    assert.equal(parsePermissionAlias('auto-accept'), undefined)
    assert.equal(parsePermissionAlias('full'), undefined)
  })
})

describe('labels', () => {
  it('uses 监督 / 自动 / 全自动 as Chinese chrome', () => {
    assert.equal(formatPermissionLabel('manual'), '监督')
    assert.equal(formatPermissionLabel('auto-safe'), '自动')
    assert.equal(formatPermissionLabel('dangerously-skip-permissions'), '全自动')
    assert.equal(formatPermissionLabel('auto-accept'), '自动')
    assert.equal(formatPermissionChrome('dangerously-skip-permissions'), '全自动')
  })

  it('uses Supervise / Auto / Unattended in English', () => {
    assert.equal(formatPermissionLabel('manual', 'en'), 'Supervise')
    assert.equal(formatPermissionLabel('auto-safe', 'en'), 'Auto')
    assert.equal(formatPermissionLabel('dangerously-skip-permissions', 'en'), 'Unattended')
  })
})
