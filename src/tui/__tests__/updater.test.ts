import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, parseSemver, emitLines, buildWindowsSelfUpdateScript, withResumeArgs } from '../updater.js'
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

describe('buildWindowsSelfUpdateScript', () => {
  const base = {
    pid: 4242,
    packageName: 'tianshu-tui',
    channel: 'latest',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tianshu-tui\\dist\\main.js'],
    cwd: 'C:\\work\\proj',
    relaunch: true,
  }

  it('waits for the current pid before installing (release file lock)', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /Wait-Process -Id 4242/)
    // install must come after the wait so the process has exited
    assert.ok(script.indexOf('Wait-Process') < script.indexOf('npm install -g'))
    assert.match(script, /npm install -g tianshu-tui@latest/)
  })

  it('relaunches only on successful install and preserves argv', () => {
    const script = buildWindowsSelfUpdateScript(base)
    assert.match(script, /if \(\$LASTEXITCODE -eq 0\)/)
    assert.match(script, /Start-Process -FilePath 'C:\\Program Files\\nodejs\\node\.exe'/)
    assert.match(script, /dist\\main\.js/)
  })

  it('omits relaunch when relaunch=false', () => {
    const script = buildWindowsSelfUpdateScript({ ...base, relaunch: false })
    assert.ok(!script.includes('Start-Process'))
    assert.match(script, /npm install -g/)
  })

  it('escapes embedded single quotes in paths (PowerShell doubling)', () => {
    const script = buildWindowsSelfUpdateScript({
      ...base,
      execPath: "C:\\o'brien\\node.exe",
    })
    assert.match(script, /'C:\\o''brien\\node\.exe'/)
  })

  it('carries --resume <id> into the relaunch ArgumentList (escaped)', () => {
    const sid = 'abc123-def-456'
    const script = buildWindowsSelfUpdateScript({
      ...base,
      argv: withResumeArgs(base.argv, sid),
    })
    assert.match(script, /-ArgumentList @\(/)
    assert.match(script, /'--resume'/)
    assert.ok(script.includes(`'${sid}'`), 'session id present as a quoted arg')
  })
})

describe('withResumeArgs', () => {
  it('returns argv unchanged (minus session flags) when no sessionId', () => {
    assert.deepEqual(withResumeArgs(['dist/main.js']), ['dist/main.js'])
    assert.deepEqual(withResumeArgs(['dist/main.js', '--verbose']), ['dist/main.js', '--verbose'])
  })

  it('appends --resume <id> when sessionId given', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
  })

  it('strips pre-existing --new / --continue before appending current resume', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--new'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--continue'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
  })

  it('strips a stale --resume <oldid> (with its value) then appends current id', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume', 'old-id', '--verbose'], 'new-id'),
      ['dist/main.js', '--verbose', '--resume', 'new-id'],
    )
  })

  it('handles bare --resume with no following value', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume'], 'new-id'),
      ['dist/main.js', '--resume', 'new-id'],
    )
    // trailing --resume followed by another flag (not a value) — flag preserved
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '--resume', '--verbose']),
      ['dist/main.js', '--verbose'],
    )
  })

  it('strips short flags -c and -r (with value) too', () => {
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-c'], 'sid-1'),
      ['dist/main.js', '--resume', 'sid-1'],
    )
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-r', 'old-id', '--verbose'], 'new-id'),
      ['dist/main.js', '--verbose', '--resume', 'new-id'],
    )
    // 裸 -r（无值）也剔除
    assert.deepEqual(
      withResumeArgs(['dist/main.js', '-r'], 'sid-2'),
      ['dist/main.js', '--resume', 'sid-2'],
    )
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
