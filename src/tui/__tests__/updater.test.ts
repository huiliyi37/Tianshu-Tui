import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver, emitLines } from '../updater.js'
import { WinStreamDecoder } from '../../platform.js'

describe('updater semver', () => {
  it('parses plain versions', () => {
    assert.deepEqual(parseSemver('2.9.0'), [2, 9, 0, undefined])
    assert.deepEqual(parseSemver('v3.0.0'), [3, 0, 0, undefined])
    assert.deepEqual(parseSemver('1.2'), [1, 2, 0, undefined])
  })

  it('parses prereleases and strips build metadata', () => {
    assert.deepEqual(parseSemver('3.0.0-beta.2'), [3, 0, 0, 'beta.2'])
    assert.deepEqual(parseSemver('2.9.0+build.123'), [2, 9, 0, undefined])
    assert.deepEqual(parseSemver('3.0.0-rc.1+sha.abc'), [3, 0, 0, 'rc.1'])
  })

  it('compares release versions', () => {
    assert.equal(compareSemver('2.9.0', '3.0.0'), -1)
    assert.equal(compareSemver('3.0.0', '2.9.0'), 1)
    assert.equal(compareSemver('2.9.0', '2.9.0'), 0)
    assert.equal(compareSemver('2.9.1', '2.9.0'), 1)
  })

  it('treats release as newer than prerelease with same core', () => {
    assert.equal(compareSemver('3.0.0', '3.0.0-beta'), 1)
    assert.equal(compareSemver('3.0.0-beta', '3.0.0'), -1)
  })

  it('compares prereleases', () => {
    assert.equal(compareSemver('3.0.0-beta', '3.0.0-rc'), -1)
    assert.equal(compareSemver('3.0.0-beta.1', '3.0.0-beta.2'), -1)
  })
})

describe('updater emitLines', () => {
  const collect = (text: string): string[] => {
    const out: string[] = []
    emitLines(text, (l) => out.push(l))
    return out
  }

  it('splits on LF and CRLF', () => {
    assert.deepEqual(collect('a\nb\r\nc'), ['a', 'b', 'c'])
  })

  it('drops the trailing empty line when text ends with a newline', () => {
    assert.deepEqual(collect('done\n'), ['done'])
    assert.deepEqual(collect('a\nb\n'), ['a', 'b'])
  })

  it('keeps interior blank lines', () => {
    assert.deepEqual(collect('a\n\nb'), ['a', '', 'b'])
  })

  it('is a no-op on empty input (decoder flush with nothing buffered)', () => {
    assert.deepEqual(collect(''), [])
  })
})

describe('updater WinStreamDecoder integration', () => {
  // The /update stream now routes child stdout/stderr bytes through
  // WinStreamDecoder before line-splitting. Guard the write→end contract:
  // clean UTF-8 fed as one chunk must round-trip losslessly with no duplicate
  // or dropped content on flush (the property updater relies on).
  it('round-trips clean UTF-8 across write + end', () => {
    const dec = new WinStreamDecoder()
    const msg = 'npm 安装完成 ✓\n更新成功'
    const out = dec.write(Buffer.from(msg, 'utf-8')) + dec.end()
    assert.equal(out, msg)
  })

  it('end() returns empty when nothing was written', () => {
    const dec = new WinStreamDecoder()
    assert.equal(dec.end(), '')
  })
})
