import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeLineChecksum,
  appendChecksum,
  verifyAndExtract,
  verifyLines,
} from '../checksum.js'

describe('computeLineChecksum', () => {
  it('returns 16 character hex string', () => {
    const checksum = computeLineChecksum('{"test": true}')
    assert.equal(checksum.length, 16)
    assert.match(checksum, /^[0-9a-f]{16}$/)
  })

  it('returns consistent checksum for same input', () => {
    const input = '{"type":"message","role":"user","content":"hello"}'
    const checksum1 = computeLineChecksum(input)
    const checksum2 = computeLineChecksum(input)
    assert.equal(checksum1, checksum2)
  })

  it('returns different checksum for different input', () => {
    const checksum1 = computeLineChecksum('{"a": 1}')
    const checksum2 = computeLineChecksum('{"a": 2}')
    assert.notEqual(checksum1, checksum2)
  })
})

describe('appendChecksum', () => {
  it('appends checksum separated by pipe', () => {
    const json = '{"test": true}'
    const result = appendChecksum(json)
    assert.match(result, /^{"test": true}\|[0-9a-f]{16}$/)
  })

  it('creates verifiable line', () => {
    const json = '{"type":"message","role":"user","content":"hello"}'
    const line = appendChecksum(json)
    const result = verifyAndExtract(line)
    assert.equal(result.valid, true)
    assert.equal(result.json, json)
    assert.equal(result.isLegacy, false)
  })
})

describe('verifyAndExtract', () => {
  it('validates correct checksum', () => {
    const json = '{"test": true}'
    const line = appendChecksum(json)
    const result = verifyAndExtract(line)
    assert.equal(result.valid, true)
    assert.equal(result.json, json)
    assert.equal(result.isLegacy, false)
  })

  it('rejects incorrect checksum', () => {
    const json = '{"test": true}'
    const line = `${json}|0000000000000000`
    const result = verifyAndExtract(line)
    assert.equal(result.valid, false)
    assert.ok(result.error?.includes('Checksum mismatch'))
  })

  it('handles legacy format (no checksum)', () => {
    const json = '{"test": true}'
    const result = verifyAndExtract(json)
    assert.equal(result.valid, true)
    assert.equal(result.json, json)
    assert.equal(result.isLegacy, true)
  })

  it('handles JSON containing pipe character', () => {
    const json = '{"text": "hello | world"}'
    const result = verifyAndExtract(json)
    assert.equal(result.valid, true)
    assert.equal(result.json, json)
    assert.equal(result.isLegacy, true)
  })

  it('handles empty line', () => {
    const result = verifyAndExtract('')
    assert.equal(result.valid, false)
    assert.equal(result.error, 'Empty line')
  })

  it('treats JSON with pipe and 16-hex suffix as legacy when jsonPart is not valid JSON', () => {
    // 这不是有效 JSON，所以应该是 legacy
    const line = 'not-json|abcdef0123456789'
    const result = verifyAndExtract(line)
    assert.equal(result.valid, true)
    assert.equal(result.isLegacy, true)
    assert.equal(result.json, line)
  })

  it('validates new format when jsonPart is valid JSON', () => {
    const json = '{"valid": true}'
    const line = appendChecksum(json)
    const result = verifyAndExtract(line)
    assert.equal(result.valid, true)
    assert.equal(result.isLegacy, false)
    assert.equal(result.json, json)
  })
})

describe('verifyLines', () => {
  it('validates mixed format lines', () => {
    const lines = [
      appendChecksum('{"new": true}'),
      '{"legacy": true}',
      appendChecksum('{"another": true}'),
    ]
    const result = verifyLines(lines)
    assert.equal(result.validLines.length, 3)
    assert.equal(result.legacyCount, 1)
    assert.equal(result.invalidCount, 0)
  })

  it('counts invalid lines', () => {
    const lines = [
      '{"valid": true}',
      '{"invalid": true}|0000000000000000',
    ]
    const result = verifyLines(lines)
    assert.equal(result.validLines.length, 1)
    assert.equal(result.invalidCount, 1)
  })
})
