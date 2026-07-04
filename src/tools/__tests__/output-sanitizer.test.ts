import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeToolOutput } from '../output-sanitizer.js'

function pad(line: string, times: number): string {
  return Array.from({ length: times }, (_, i) => `${line} ${i}`).join('\n')
}

describe('sanitizeToolOutput 缺口 B', () => {
  it('短输出不裁剪', () => {
    const r = sanitizeToolOutput('bash', { command: 'tsc --noEmit' }, 'error TS2345: oops')
    assert.equal(r.trimmedBytes, 0)
    assert.equal(r.content, 'error TS2345: oops')
  })

  it('非 bash/run_tests 工具不裁剪', () => {
    const big = pad('some file content line', 100)
    const r = sanitizeToolOutput('read_file', { file_path: 'x.ts' }, big)
    assert.equal(r.trimmedBytes, 0)
    assert.equal(r.content, big)
  })

  it('tsc: 只留 error TS 行与 Found N errors 统计', () => {
    const noise = pad('  at compileProgram (/node_modules/typescript/lib/tsc.js:12345)', 50)
    const content = [
      noise,
      "src/a.ts(3,5): error TS2345: Argument of type 'string' is not assignable.",
      'src/b.ts(9,1): error TS2304: Cannot find name Foo.',
      'Found 2 errors in 2 files.',
      noise,
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'npx tsc --noEmit' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.match(r.content, /error TS2345/)
    assert.match(r.content, /error TS2304/)
    assert.match(r.content, /Found 2 errors/)
    assert.ok(!r.content.includes('compileProgram'))
    assert.match(r.content, /\[output trimmed: \d+ bytes/)
  })

  it('tsc 无错误时裁空保底一行摘要', () => {
    const content = pad('Files: 312, Lines of Library: 42310, cached module resolution', 40)
    const r = sanitizeToolOutput('bash', { command: 'tsc --noEmit --diagnostics' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.match(r.content, /tsc: no errors reported/)
  })

  it('node --test: 裁逐条 ✔ 通过行,保留 ✖ 失败与 ℹ 统计', () => {
    const passes = pad('✔ some passing subtest case name that is long enough', 60)
    const content = [
      passes,
      '✖ failing test — expected 1 to equal 2',
      '  AssertionError: expected 1 to equal 2',
      '      at TestContext.<anonymous> (file:///x.test.ts:10:5)',
      'ℹ tests 61',
      'ℹ pass 60',
      'ℹ fail 1',
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'node --test dist/' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.match(r.content, /✖ failing test/)
    assert.match(r.content, /AssertionError/)
    assert.match(r.content, /ℹ fail 1/)
    assert.ok(!r.content.includes('✔ some passing subtest'))
  })

  it('npm install: 去 timing/http/spinner 噪声,保留摘要与警告', () => {
    const noise = pad('npm timing reify:loadTrees Completed in 123ms', 40)
    const content = [
      noise,
      'npm http fetch GET 200 https://registry.npmjs.org/foo 42ms',
      'npm warn deprecated foo@1.0.0: use bar instead',
      'added 42 packages, and audited 900 packages in 3s',
      'found 0 vulnerabilities',
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'npm install foo' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.match(r.content, /added 42 packages/)
    assert.match(r.content, /npm warn deprecated/)
    assert.ok(!r.content.includes('npm timing'))
    assert.ok(!r.content.includes('npm http fetch'))
  })

  it('裁剪收益低于阈值时返回原文', () => {
    const body = pad('src/a.ts(3,5): error TS2345: broken here in this file', 20)
    const content = `${body}\nnot an error line\nFound 20 errors in 1 file.`
    const r = sanitizeToolOutput('bash', { command: 'tsc --noEmit' }, content)
    // 只有一行非 error 噪声(< 200 bytes)——不值得替换
    assert.equal(r.trimmedBytes, 0)
    assert.equal(r.content, content)
  })

  it('run_tests: 只剥 ANSI', () => {
    const ansi = '\x1b[32m'
    const line = `${ansi}pass${ansi} some test detail line that stays`
    const content = Array.from({ length: 60 }, () => line).join('\n')
    const r = sanitizeToolOutput('run_tests', {}, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(!r.content.includes('\x1b['))
    assert.match(r.content, /some test detail line that stays/)
  })

  it('普通 bash 命令仅 ANSI 剥离达阈值时替换', () => {
    const plain = pad('regular command output line', 40)
    const r = sanitizeToolOutput('bash', { command: 'ls -la' }, plain)
    assert.equal(r.trimmedBytes, 0)
    assert.equal(r.content, plain)
  })
})
