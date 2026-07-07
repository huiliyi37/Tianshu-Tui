import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectProbes,
  extractWriteContent,
  scanFilesForProbes,
  formatProbeHits,
  isWhitelistedPath,
  type ProbeHit,
} from '../probe-detector.js'

describe('probe-detector', () => {
  describe('detectProbes', () => {
    it('detects console.log as probe', () => {
      const hits = detectProbes('console.log("debug")\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'console.log/debug/dir/trace')
      assert.match(hits[0]!.line, /console\.log/)
    })

    it('detects console.debug as probe', () => {
      const hits = detectProbes('console.debug(obj)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
    })

    it('detects console.dir as probe', () => {
      const hits = detectProbes('console.dir(deepObj)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
    })

    it('does NOT detect console.error (error channel is not a probe)', () => {
      const hits = detectProbes('console.error("oops")\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect console.warn (warn channel is not a probe)', () => {
      const hits = detectProbes('console.warn("hmm")\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect structured logger calls', () => {
      const content = 'logger.info("structured")\nthis.logger.debug("x")\nlog.trace("y")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('detects debugger statement', () => {
      const hits = detectProbes('function foo() {\n  debugger\n  return 1\n}\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'debugger')
    })

    it('detects .only() test isolation', () => {
      const hits = detectProbes('it.only("test", () => {})\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, '.only() test isolation')
    })

    it('does NOT detect .only() on non-test functions', () => {
      const hits = detectProbes('obj.only = true\n', 'src/foo.ts')
      // obj.only = true should not match .only(
      assert.equal(hits.length, 0)
    })

    it('skips commented lines', () => {
      const content = '// console.log("commented")\n// debugger\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('skips block-comment continuation lines', () => {
      const content = ' * console.log("in block comment")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('detects multiple probes in one content', () => {
      const content = 'console.log("a")\ndebugger\nconsole.dir(x)\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits.length, 3)
    })

    it('reports correct line numbers', () => {
      const content = 'const a = 1\nconst b = 2\nconsole.log("probe")\n'
      const hits = detectProbes(content, 'src/foo.ts')
      assert.equal(hits[0]!.lineNumber, 3)
    })

    it('detects bare assert() in production code', () => {
      const hits = detectProbes('assert(x > 0)\n', 'src/foo.ts')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.pattern, 'bare assert()')
    })

    it('does NOT detect assert in import assertion syntax', () => {
      const hits = detectProbes('import json from "./data.json" assert { type: "json" }\n', 'src/foo.ts')
      assert.equal(hits.length, 0)
    })

    it('does NOT detect console.assert (covered by console pattern)', () => {
      const hits = detectProbes('console.assert(x > 0)\n', 'src/foo.ts')
      // console.assert is NOT in CONSOLE_PROBE_RE (only log/debug/dir/trace),
      // and "console.assert" has a dot before assert so ASSERT_PROBE_RE won't match
      assert.equal(hits.length, 0)
    })
  })

  describe('isWhitelistedPath', () => {
    it('whitelists test files', () => {
      assert.equal(isWhitelistedPath('src/agent/foo.test.ts'), true)
      assert.equal(isWhitelistedPath('src/agent/foo.spec.ts'), true)
    })

    it('whitelists scripts/ directory', () => {
      assert.equal(isWhitelistedPath('scripts/build.ts'), true)
    })

    it('whitelists bin/ directory', () => {
      assert.equal(isWhitelistedPath('bin/cli.ts'), true)
    })

    it('does NOT whitelist source files', () => {
      assert.equal(isWhitelistedPath('src/agent/loop.ts'), false)
    })
  })

  describe('detectProbes whitelist integration', () => {
    it('returns empty for whitelisted test files', () => {
      const hits = detectProbes('console.log("ok in test")\n', 'src/foo.test.ts')
      assert.equal(hits.length, 0)
    })

    it('returns empty for scripts/ directory', () => {
      const hits = detectProbes('console.log("cli output")\n', 'scripts/build.ts')
      assert.equal(hits.length, 0)
    })
  })

  describe('extractWriteContent', () => {
    it('extracts content from write_file', () => {
      const result = extractWriteContent('write_file', {
        file_path: 'src/foo.ts',
        content: 'console.log("x")\n',
      })
      assert.equal(result?.filePath, 'src/foo.ts')
      assert.match(result!.content, /console\.log/)
    })

    it('extracts new_string from edit_file', () => {
      const result = extractWriteContent('edit_file', {
        file_path: 'src/bar.ts',
        old_string: 'a',
        new_string: 'console.log("x")\n',
      })
      assert.equal(result?.filePath, 'src/bar.ts')
      assert.match(result!.content, /console\.log/)
    })

    it('extracts new_string from hash_edit', () => {
      const result = extractWriteContent('hash_edit', {
        file_path: 'src/baz.ts',
        anchors: ['L1:abc'],
        new_string: 'debugger\n',
      })
      assert.equal(result?.filePath, 'src/baz.ts')
      assert.match(result!.content, /debugger/)
    })

    it('returns null for read-only tools', () => {
      assert.equal(extractWriteContent('read_file', { file_path: 'src/foo.ts' }), null)
      assert.equal(extractWriteContent('grep', { pattern: 'foo' }), null)
    })

    it('returns null when file_path is missing', () => {
      assert.equal(extractWriteContent('write_file', { content: 'x' }), null)
    })

    it('returns null when content/new_string is not a string', () => {
      assert.equal(
        extractWriteContent('write_file', { file_path: 'x.ts', content: 123 }),
        null,
      )
    })
  })

  describe('scanFilesForProbes', () => {
    it('reads files from disk and detects probes', () => {
      const fakeFs = new Map<string, string>([
        ['/cwd/src/a.ts', 'console.log("probe")\n'],
        ['/cwd/src/b.ts', 'const x = 1\n'],
      ])
      const reader = (p: string) => fakeFs.get(p) ?? null
      const hits = scanFilesForProbes(['src/a.ts', 'src/b.ts'], '/cwd', reader)
      assert.equal(hits.length, 1)
      assert.equal(hits[0]!.filePath, 'src/a.ts')
    })

    it('skips files that no longer exist (null from reader)', () => {
      const reader = (_: string): string | null => null
      const hits = scanFilesForProbes(['src/gone.ts'], '/cwd', reader)
      assert.equal(hits.length, 0)
    })

    it('skips whitelisted paths', () => {
      const fakeFs = new Map<string, string>([
        ['/cwd/src/foo.test.ts', 'console.log("ok")\n'],
      ])
      const reader = (p: string) => fakeFs.get(p) ?? null
      const hits = scanFilesForProbes(['src/foo.test.ts'], '/cwd', reader)
      assert.equal(hits.length, 0)
    })
  })

  describe('formatProbeHits', () => {
    it('returns empty array for no hits', () => {
      assert.deepEqual(formatProbeHits([]), [])
    })

    it('formats hits grouped by file', () => {
      const hits: ProbeHit[] = [
        { filePath: 'src/a.ts', pattern: 'console.log/debug/dir/trace', line: '  console.log("x")', lineNumber: 5 },
        { filePath: 'src/a.ts', pattern: 'debugger', line: '  debugger', lineNumber: 10 },
        { filePath: 'src/b.ts', pattern: '.only() test isolation', line: 'it.only("t",)', lineNumber: 1 },
      ]
      const lines = formatProbeHits(hits)
      assert.ok(lines.some(l => l.includes('src/a.ts')))
      assert.ok(lines.some(l => l.includes('src/b.ts')))
      assert.ok(lines.some(l => l.includes('L5')))
      assert.ok(lines.some(l => l.includes('L10')))
      assert.ok(lines.some(l => l.includes('清理探针')))
    })

    it('truncates to 3 hits per file', () => {
      const hits: ProbeHit[] = Array.from({ length: 5 }, (_, i) => ({
        filePath: 'src/a.ts',
        pattern: 'debugger',
        line: `  debugger // ${i}`,
        lineNumber: i + 1,
      }))
      const lines = formatProbeHits(hits)
      assert.ok(lines.some(l => l.includes('+2 more')))
    })
  })
})
