import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { repairInvalidJsonEscapes, parseJsonObjectWithEscapeRepair } from '../json-escape-repair.js'

describe('repairInvalidJsonEscapes', () => {
  test('doubles invalid escapes from raw Windows paths (CJK + latin segments)', () => {
    const raw = '{"file_path": "F:\\智慧项目\\hardware-saas\\src\\app"}'
    assert.throws(() => JSON.parse(raw), 'precondition: raw must be invalid JSON')
    const repaired = repairInvalidJsonEscapes(raw)
    assert.ok(repaired !== null)
    const parsed = JSON.parse(repaired) as { file_path: string }
    assert.equal(parsed.file_path, 'F:\\智慧项目\\hardware-saas\\src\\app')
  })

  test('returns null when nothing needs repair', () => {
    assert.equal(repairInvalidJsonEscapes('{"a": "b\\nc", "p": "F:\\\\ok"}'), null)
    assert.equal(repairInvalidJsonEscapes('{"a": 1}'), null)
    assert.equal(repairInvalidJsonEscapes(''), null)
  })

  test('preserves valid escapes adjacent to invalid ones', () => {
    const raw = '{"cmd": "cd \\"F:\\proj\\" && ls", "note": "line1\\nline2"}'
    const repaired = repairInvalidJsonEscapes(raw)
    assert.ok(repaired !== null)
    const parsed = JSON.parse(repaired) as { cmd: string; note: string }
    assert.equal(parsed.cmd, 'cd "F:\\proj" && ls')
    assert.equal(parsed.note, 'line1\nline2')
  })

  test('\\u with non-hex tail is treated as invalid escape (F:\\utils)', () => {
    const raw = '{"p": "F:\\utils\\index.ts"}'
    const repaired = repairInvalidJsonEscapes(raw)
    assert.ok(repaired !== null)
    assert.equal((JSON.parse(repaired) as { p: string }).p, 'F:\\utils\\index.ts')
  })

  test('\\u with valid hex quad is left untouched', () => {
    const raw = '{"p": "snow \\u2603 man"}'
    assert.equal(repairInvalidJsonEscapes(raw), null)
    assert.equal((JSON.parse(raw) as { p: string }).p, 'snow ☃ man')
  })

  test('does not touch backslashes outside string literals', () => {
    // Malformed structurally — repair must not "fix" structure, only strings.
    const raw = '{\\ "a": "b"}'
    assert.equal(repairInvalidJsonEscapes(raw), null)
  })
})

describe('parseJsonObjectWithEscapeRepair', () => {
  test('parses valid JSON directly', () => {
    assert.deepEqual(parseJsonObjectWithEscapeRepair('{"a": 1}'), { a: 1 })
  })

  test('recovers Windows-path args that raw JSON.parse rejects', () => {
    const raw = '{"file_path": "F:\\智慧项目\\hardware-saas\\package.json", "content": "{}"}'
    const parsed = parseJsonObjectWithEscapeRepair(raw)
    assert.ok(parsed !== null)
    assert.equal(parsed.file_path, 'F:\\智慧项目\\hardware-saas\\package.json')
  })

  test('returns null for arrays and non-objects', () => {
    assert.equal(parseJsonObjectWithEscapeRepair('[1,2]'), null)
    assert.equal(parseJsonObjectWithEscapeRepair('"str"'), null)
  })

  test('returns null for truly truncated buffers', () => {
    assert.equal(parseJsonObjectWithEscapeRepair('{"file_path": "F:\\智慧'), null)
  })
})
