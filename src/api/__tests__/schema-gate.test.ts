import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateRequiredFields } from '../client.js'

describe('validateRequiredFields', () => {
  it('returns missing fields when absent', () => {
    assert.deepEqual(validateRequiredFields({}, ['command']), ['command'])
  })

  it('returns missing fields when null', () => {
    assert.deepEqual(validateRequiredFields({ command: null }, ['command']), ['command'])
  })

  it('returns empty when all present', () => {
    assert.deepEqual(validateRequiredFields({ command: 'pwd' }, ['command']), [])
  })

  it('returns empty when no required fields', () => {
    assert.deepEqual(validateRequiredFields({ x: 1 }, []), [])
  })
})
