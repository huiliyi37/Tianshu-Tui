import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizeToolOutput } from '../output-sanitizer.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8')
}

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

  // ── LineFilter: git status ──
  it('git status: strips branch/hint lines, keeps file list', () => {
    const noisePad = pad('noise padding to exceed MIN_CONTENT_LENGTH threshold', 20)
    const content = [
      'On branch feat/output-filter',
      "Your branch is ahead of 'origin' by 3 commits.",
      '  (use "git push" to publish your local commits)',
      '',
      'Changes not staged for commit:',
      '\tmodified:   src/tools/output-sanitizer.ts',
      '\tmodified:   src/tools/__tests__/output-sanitizer.test.ts',
      '',
      'no changes added to commit (use "git add" and/or "git commit -a")',
      noisePad,
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'git status' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(r.content.includes('src/tools/output-sanitizer.ts'))
    assert.ok(r.content.includes('src/tools/__tests__/output-sanitizer.test.ts'))
    assert.ok(!r.content.includes('On branch'))
    assert.ok(!r.content.includes('use "git'))
    assert.ok(!r.content.includes('Changes not staged'))
  })

  // ── LineFilter: git diff ──
  it('git diff: strips header lines, keeps +/- content', () => {
    // 构造两个文件的 diff（header 更多 → 节省量超过 MIN_SAVINGS + marker overhead）
    const file1Headers = [
      'diff --git a/src/tools/output-sanitizer.ts b/src/tools/output-sanitizer.ts',
      'index 1234567..abcdefg 100644',
      '--- a/src/tools/output-sanitizer.ts',
      '+++ b/src/tools/output-sanitizer.ts',
      '@@ -10,6 +10,8 @@',
    ]
    const file1Content = [
      ' unchanged line',
      '+added line with new feature',
      '-removed old code',
      ' another unchanged line',
    ]
    const file2Headers = [
      'diff --git a/src/tools/run-tests.ts b/src/tools/run-tests.ts',
      'index abcdef1..1234567 100644',
      '--- a/src/tools/run-tests.ts',
      '+++ b/src/tools/run-tests.ts',
      '@@ -50,4 +50,6 @@',
    ]
    const file2Content = [
      ' old test code',
      '+new test assertion',
      '+another assertion',
    ]
    const noisePad = pad('noise padding to exceed MIN_CONTENT_LENGTH threshold', 10)
    const content = [...file1Headers, ...file1Content, ...file2Headers, ...file2Content, noisePad].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'git diff' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(r.content.includes('+added line'))
    assert.ok(r.content.includes('-removed old'))
    assert.ok(!r.content.includes('diff --git'))
    assert.ok(!r.content.includes('index '))
    assert.ok(!r.content.includes('--- a/'))
    assert.ok(!r.content.includes('+++ b/'))
  })

  // ── LineFilter: git log maxLines ──
  it('git log: caps at maxLines=60', () => {
    const commits = Array.from({ length: 100 }, (_, i) =>
      `abc${String(i).padStart(5, '0')} commit message number ${i}`,
    )
    const content = commits.join('\n')
    const r = sanitizeToolOutput('bash', { command: 'git log --oneline' }, content)
    assert.ok(r.trimmedBytes > 0)
    const lines = r.content.split('\n')
    // 60 lines + trim marker
    assert.ok(lines.length <= 63)
    assert.match(r.content, /non-diagnostic lines trimmed/)
    // 尾部 commit 保留（取最后 60 条）
    assert.ok(r.content.includes('commit message number 99'))
  })

  // ── LineFilter: ls ──
  it('ls -la: strips total line, caps at 40', () => {
    const entries = Array.from({ length: 80 }, (_, i) =>
      `drwxr-xr-x  2 user  staff   64 Jan 1 12:0${i % 10}  dir_${String(i).padStart(3, '0')}`,
    )
    const content = ['total 9999', ...entries].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'ls -la src/' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(!r.content.includes('total 9999'))
    const lines = r.content.split('\n')
    assert.ok(lines.length <= 44) // 40 + trim marker + possible trim note
    assert.match(r.content, /non-diagnostic lines trimmed/)
    // 尾部条目保留
    assert.ok(r.content.includes('dir_079'))
  })

  it('ls 无 flags 不匹配 LineFilter,走 ANSI-only 路径', () => {
    // 裸 ls 输出通常很短，不应被 maxLines 影响
    const content = ['file1.ts', 'file2.ts', 'file3.ts'].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'ls' }, content)
    assert.equal(r.trimmedBytes, 0)
    assert.equal(r.content, content)
  })

  // ── LineFilter: grep ──
  it('grep: caps at maxLines=80', () => {
    const matches = Array.from({ length: 120 }, (_, i) =>
      `src/file${i}.ts:42:const x = ${i}`,
    )
    const content = matches.join('\n')
    const r = sanitizeToolOutput('bash', { command: 'grep -rn "const x" src/' }, content)
    assert.ok(r.trimmedBytes > 0)
    const lines = r.content.split('\n')
    assert.ok(lines.length <= 83)
    assert.match(r.content, /non-diagnostic lines trimmed/)
  })

  // ── LineFilter: find ──
  it('find: caps at maxLines=60', () => {
    const paths = Array.from({ length: 100 }, (_, i) =>
      `src/deeply/nested/path/component_${String(i).padStart(4, '0')}.ts`,
    )
    const content = paths.join('\n')
    const r = sanitizeToolOutput('bash', { command: 'find src/ -name "*.ts"' }, content)
    assert.ok(r.trimmedBytes > 0)
    const lines = r.content.split('\n')
    assert.ok(lines.length <= 63)
    assert.match(r.content, /non-diagnostic lines trimmed/)
  })

  // ── LineFilter: eslint shortCircuit ──
  it('eslint: short-circuits on clean output', () => {
    const noisePad = pad('noise padding line to exceed MIN_CONTENT_LENGTH', 20)
    const content = `${noisePad}\n✔ No issues found (42 files checked)\n`
    const r = sanitizeToolOutput('bash', { command: 'npx eslint .' }, content)
    assert.match(r.content, /short-circuit/)
  })

  it('eslint: short-circuits on zero errors with warnings', () => {
    // "5 problems (0 errors, 5 warnings)" → shortCircuit matches
    const noisePad = pad('noise padding line to exceed MIN_CONTENT_LENGTH threshold', 15)
    const content = [
      noisePad,
      '/src/a.ts',
      '  1:1  warning  unused import  no-unused-vars',
      '  5:3  warning  missing semicolon  semi',
      '',
      '✖ 5 problems (0 errors, 5 warnings)',
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'npx eslint .' }, content)
    assert.match(r.content, /short-circuit/)
  })

  // ── LineFilter: diagnostic line protection ──
  it('诊断行不会被 stripLines 删除', () => {
    // cargo build: Compiling/Finished 行应被 strip，但 error 行保留。
    // 足够多的 Compiling 行确保节省 > MIN_SAVINGS + marker overhead
    const compilings = Array.from({ length: 10 }, (_, i) =>
      `   Compiling crate_${i} v0.${i}.0`,
    )
    const noisePad = pad('noise padding to exceed MIN_CONTENT_LENGTH', 5)
    const content = [
      ...compilings,
      'error[E0308]: mismatched types',
      ' --> src/main.rs:10:5',
      '   Compiling last_crate v1.0.0',
      '   Finished dev [unoptimized] target(s) in 2.34s',
      noisePad,
    ].join('\n')
    const r = sanitizeToolOutput('bash', { command: 'cargo build' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(r.content.includes('error[E0308]'))
    assert.ok(!r.content.includes('Compiling'))
  })

  it('诊断行不计入 maxLines 配额', () => {
    // 构造 100 行，前 5 行是 error，其余是普通行
    const errors = Array.from({ length: 5 }, (_, i) =>
      `error TS${1000 + i}: type error in file${i}.ts`,
    )
    const noise = Array.from({ length: 95 }, (_, i) =>
      `regular output line number ${i}`,
    )
    const content = [...errors, ...noise].join('\n')
    // cargo filter: maxLines=30, stripLines 不匹配这些行
    const r = sanitizeToolOutput('bash', { command: 'cargo build' }, content)
    assert.ok(r.trimmedBytes > 0)
    // 5 个 error 全保留
    for (const e of errors) {
      assert.ok(r.content.includes(e), `missing error: ${e}`)
    }
    // 尾部保留补齐到 maxLines
    assert.match(r.content, /non-diagnostic lines trimmed/)
  })

  // ── LineFilter: shortCircuit 大面积输入正确工作 ──
  it('shortCircuit 匹配时返回简短摘要', () => {
    // pip install 大面积下载日志 + "already satisfied" → shortCircuit 触发
    const noise = pad('  Downloading package-0.1.0.tar.gz (123 kB)', 20) // ~20*45=900 bytes
    const content = `${noise}\nRequirement already satisfied: requests in /usr/local/lib\n`
    const r = sanitizeToolOutput('bash', { command: 'pip install requests' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.match(r.content, /short-circuit/)
    // short-circuit 消息应远短于原文
    assert.ok(r.content.length < content.length / 2)
  })

  // ── LineFilter: 无匹配命令走 ANSI-only 路径 ──
  it('无匹配命令仅做 ANSI 剥离', () => {
    const ansi = '\x1b[32m'
    const line = `${ansi}echo output line`
    const content = Array.from({ length: 50 }, () => line).join('\n')
    const r = sanitizeToolOutput('bash', { command: 'echo hello' }, content)
    assert.ok(r.trimmedBytes > 0)
    assert.ok(!r.content.includes('\x1b['))
    assert.ok(r.content.includes('echo output line'))
  })
})

// ── Fixture-based regression tests ──

describe('fixture regression', () => {
  it('git status fixture: strips branch/hint, keeps file paths', () => {
    const input = readFixture('git-status.txt')
    const r = sanitizeToolOutput('bash', { command: 'git status' }, input)
    assert.ok(r.trimmedBytes > 0, 'expected trimming to occur')
    assert.ok(!r.content.includes('On branch'), 'branch line should be stripped')
    assert.ok(!r.content.includes('use "git'), 'hint lines should be stripped')
    // 文件路径必须保留
    assert.ok(r.content.includes('output-sanitizer.ts'), 'file paths should be preserved')
    assert.ok(r.content.includes('tool-execution.ts'), 'file paths should be preserved')
  })

  it('git diff fixture: strips headers, keeps code changes', () => {
    const input = readFixture('git-diff.txt')
    const r = sanitizeToolOutput('bash', { command: 'git diff' }, input)
    assert.ok(r.trimmedBytes > 0, 'expected trimming to occur')
    // diff header 应剥离
    assert.ok(!r.content.includes('diff --git'), 'diff header should be stripped')
    assert.ok(!r.content.includes('index '), 'index line should be stripped')
    // 代码变更应保留（+/- 行）
    assert.ok(r.content.includes('+') || r.content.includes('-'), 'code changes should be preserved')
    // 压缩比 > 15%（diff header 占比大）
    const ratio = r.trimmedBytes / input.length
    assert.ok(ratio > 0.15, `compression ratio ${(ratio*100).toFixed(0)}% should exceed 15%`)
  })

  it('git log fixture: caps at maxLines', () => {
    const input = readFixture('git-log.txt')
    // 30 行 log 不应超过 maxLines=60，无截断
    const r = sanitizeToolOutput('bash', { command: 'git log --oneline' }, input)
    // 30 行以内不走 maxLines 截断，但可能因其他原因无 trimming
    // 核心：所有 commit 应保留
    const commitCount = (input.match(/^[0-9a-f]+ /gm) ?? []).length
    const keptCount = (r.content.match(/^[0-9a-f]+ /gm) ?? []).length
    assert.equal(keptCount, commitCount, 'all commits should be preserved')
  })

  it('ls fixture: strips total line', () => {
    const input = readFixture('ls-src.txt')
    const r = sanitizeToolOutput('bash', { command: 'ls -la src/' }, input)
    assert.ok(r.trimmedBytes > 0, 'expected trimming to occur')
    assert.ok(!r.content.includes('total '), 'total line should be stripped')
    // 至少保留一些目录条目（ls 输出的是 src/ 的子目录）
    assert.ok(r.content.includes('__tests__') || r.content.includes('agent') || r.content.includes('tools'),
      'directory entries should be preserved')
  })
})
