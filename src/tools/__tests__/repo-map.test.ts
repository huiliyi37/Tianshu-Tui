import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { REPO_MAP_TOOL } from '../repo-map.js'

describe('REPO_MAP_TOOL', () => {
  let testDir: string

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), 'repomap-test-'))
    mkdirSync(join(testDir, 'src', 'agent'), { recursive: true })
    mkdirSync(join(testDir, 'src', 'tools', '__tests__'), { recursive: true })
    mkdirSync(join(testDir, 'src', 'tui'), { recursive: true })
    mkdirSync(join(testDir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(testDir, '.codex'), { recursive: true })
    mkdirSync(join(testDir, '.test-tmp'), { recursive: true })
    writeFileSync(join(testDir, 'src', 'main.tsx'), '')
    writeFileSync(join(testDir, 'src', 'agent', 'loop.ts'), '')
    writeFileSync(join(testDir, 'src', 'tools', 'bash.ts'), '')
    writeFileSync(join(testDir, 'src', 'tools', '__tests__', 'bash.test.ts'), '')
    writeFileSync(join(testDir, 'src', 'tui', 'app.tsx'), '')
    writeFileSync(join(testDir, 'package.json'), '{}')
    writeFileSync(join(testDir, 'tsconfig.json'), '{}')
    writeFileSync(join(testDir, 'README.md'), '# test')
    writeFileSync(join(testDir, 'layout.log'), '')
    writeFileSync(join(testDir, '.codex', 'hooks.json'), '{}')
    writeFileSync(join(testDir, '.test-tmp', 'debug.json'), '{}')
    writeFileSync(join(testDir, 'node_modules', 'pkg', 'index.ts'), '')
  })

  after(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  function makeParams(input: Record<string, unknown> = {}) {
    return { input, toolUseId: 'test', cwd: testDir }
  }

  it('generates tree for a simple project', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams())
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src'))
    assert.ok(result.content.includes('agent'))
    assert.ok(result.content.includes('tools'))
    assert.ok(result.content.includes('tui'))
    // Summary line
    assert.match(result.content, /\d+ files in tree, \d+ directories/)
  })

  it('excludes build/runtime/foreign attention noise from default root map', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams())
    assert.ok(!result.content.includes('node_modules'))
    assert.ok(!result.content.includes('pkg'))
    assert.ok(!result.content.includes('layout.log'))
    assert.ok(!result.content.includes('.codex'))
    assert.ok(!result.content.includes('.test-tmp'))
  })

  it('allows explicit focus on a silent foreign directory', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams({ path: '.codex' }))
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('.codex/'))
    assert.ok(result.content.includes('hooks.json'))
  })

  it('annotates entry/test/config/doc files', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams())
    assert.ok(result.content.includes('main.tsx [entry]'), 'main.tsx should be [entry]')
    assert.ok(result.content.includes('app.tsx [entry]'), 'app.tsx should be [entry]')
    assert.ok(result.content.includes('bash.test.ts [test]'), 'test file should be [test]')
    assert.ok(result.content.includes('package.json [config]'), 'package.json should be [config]')
    assert.ok(result.content.includes('tsconfig.json [config]'), 'tsconfig.json should be [config]')
    assert.ok(result.content.includes('README.md [doc]'), 'README.md should be [doc]')
  })

  it('respects max_files limit', async () => {
    const limitDir = mkdtempSync(join(tmpdir(), 'repomap-limit-'))
    try {
      for (let i = 0; i < 20; i++) {
        writeFileSync(join(limitDir, `file${i}.ts`), '')
      }
      const result = await REPO_MAP_TOOL.execute({
        input: { max_files: 5 },
        toolUseId: 'test',
        cwd: limitDir,
      })
      assert.ok(result.content.includes('truncated'), 'should show truncated message')
      assert.ok(result.content.includes('15 files omitted'), 'should report omitted count')
      assert.ok(result.content.includes('repo_map({path:'), 'should suggest targeted follow-up')
      // Should have at most 5 file lines in the tree
      const lines = result.content.split('\n')
      const fileLines = lines.filter(l => l.includes('├── file') || l.includes('└── file'))
      assert.ok(fileLines.length <= 5, `expected <= 5 file lines, got ${fileLines.length}`)
    } finally {
      rmSync(limitDir, { recursive: true, force: true })
    }
  })

  it('respects depth parameter', async () => {
    const depthDir = mkdtempSync(join(tmpdir(), 'repomap-depth-param-'))
    try {
      mkdirSync(join(depthDir, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
      writeFileSync(join(depthDir, 'a', 'b', 'c', 'd', 'e', 'deep.ts'), '')
      writeFileSync(join(depthDir, 'a', 'b', 'c', 'd', 'mid.ts'), '')
      writeFileSync(join(depthDir, 'a', 'b', 'shallow.ts'), '')
      // depth=2: should show a/ → b/ → shallow.ts but not c/ or deeper
      const result = await REPO_MAP_TOOL.execute({
        input: { depth: 2 },
        toolUseId: 'test',
        cwd: depthDir,
      })
      assert.ok(result.content.includes('shallow.ts'), 'depth 2 should include a/b/shallow.ts')
      assert.ok(!result.content.includes('mid.ts'), 'depth 2 should exclude a/b/c/d/mid.ts')
      assert.ok(!result.content.includes('deep.ts'), 'depth 2 should exclude deep.ts')
    } finally {
      rmSync(depthDir, { recursive: true, force: true })
    }
  })

  it('focuses on subdirectory with path parameter', async () => {
    const result = await REPO_MAP_TOOL.execute({
      input: { path: 'src/agent' },
      toolUseId: 'test',
      cwd: testDir,
    })
    assert.equal(result.isError, undefined)
    // Should show the focused subdirectory in header
    assert.ok(result.content.includes('agent'), 'should include agent directory')
    assert.ok(result.content.includes('loop.ts'), 'should include loop.ts inside agent')
    // Should NOT include files outside the focused path
    assert.ok(!result.content.includes('app.tsx'), 'should not include tui/app.tsx')
    assert.ok(!result.content.includes('package.json'), 'should not include root package.json')
  })

  it('returns error for non-existent path', async () => {
    const result = await REPO_MAP_TOOL.execute({
      input: { path: 'nonexistent/dir' },
      toolUseId: 'test',
      cwd: testDir,
    })
    assert.ok(result.isError, 'should be an error')
    assert.ok(result.content.includes('not found') || result.content.includes('Error'), 'should mention error')
  })

  it('returns error when path is a file', async () => {
    const result = await REPO_MAP_TOOL.execute({
      input: { path: 'package.json' },
      toolUseId: 'test',
      cwd: testDir,
    })
    assert.ok(result.isError, 'should be an error')
    assert.ok(result.content.includes('Not a directory'), 'should mention not a directory')
  })

  it('rejects path traversal outside project', async () => {
    const result = await REPO_MAP_TOOL.execute({
      input: { path: '../../etc' },
      toolUseId: 'test',
      cwd: testDir,
    })
    assert.ok(result.isError, 'should be an error')
    assert.ok(result.content.includes('within the project'), 'should mention project boundary')
  })

  it('rejects prefix injection via sibling directory', async () => {
    // e.g. cwd=/tmp/app, path="../app-secrets" → /tmp/app-secrets
    // This passes startsWith("/tmp/app") but should be blocked
    const parentDir = mkdtempSync(join(tmpdir(), 'repomap-parent-'))
    const targetDir = join(parentDir, 'app')
    const siblingDir = join(parentDir, 'app-secrets')
    mkdirSync(targetDir, { recursive: true })
    mkdirSync(siblingDir, { recursive: true })
    try {
      const result = await REPO_MAP_TOOL.execute({
        input: { path: '../app-secrets' },
        toolUseId: 'test',
        cwd: targetDir,
      })
      assert.ok(result.isError, 'should block sibling with shared prefix')
    } finally {
      rmSync(parentDir, { recursive: true, force: true })
    }
  })

  it('allows depth: 0 (only files at root)', async () => {
    const d0Dir = mkdtempSync(join(tmpdir(), 'repomap-d0-'))
    try {
      mkdirSync(join(d0Dir, 'sub'), { recursive: true })
      writeFileSync(join(d0Dir, 'root.txt'), '')
      writeFileSync(join(d0Dir, 'sub', 'nested.txt'), '')
      const result = await REPO_MAP_TOOL.execute({
        input: { depth: 0 },
        toolUseId: 'test',
        cwd: d0Dir,
      })
      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('root.txt'), 'should include root file')
      assert.ok(!result.content.includes('nested.txt'), 'depth 0 should exclude nested files')
      assert.ok(!result.content.includes('sub'), 'depth 0 should exclude subdirectories')
    } finally {
      rmSync(d0Dir, { recursive: true, force: true })
    }
  })

  it('backward compatible: no params gives same behavior', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams())
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('src'))
    assert.ok(result.content.includes('agent'))
    assert.ok(result.content.includes('tools'))
    // Same as original test — full tree with default depth=4
    assert.ok(result.content.includes('bash.ts'))
    assert.ok(result.content.includes('bash.test.ts'))
  })

  it('shows file sizes in tree output', async () => {
    const result = await REPO_MAP_TOOL.execute(makeParams())
    // Files should have size suffixes like "123B", "5KB", "1.2MB"
    assert.match(result.content, /\d+B\b/, 'should show byte sizes')
    // Directories should NOT have size suffixes
    const lines = result.content.split('\n')
    const dirLine = lines.find(l => l.includes('agent') && l.includes('├──') && !l.includes('.'))
    if (dirLine) {
      assert.ok(!/\d+[BKMG]/.test(dirLine), `directory line should not have size: ${dirLine}`)
    }
  })

  it('formats large files with KB/MB', async () => {
    const bigDir = mkdtempSync(join(tmpdir(), 'repomap-size-'))
    try {
      // 50KB file
      writeFileSync(join(bigDir, 'medium.ts'), 'x'.repeat(50 * 1024))
      // 2MB file
      writeFileSync(join(bigDir, 'huge.json'), 'x'.repeat(2 * 1024 * 1024))
      // 100B file
      writeFileSync(join(bigDir, 'tiny.ts'), 'x'.repeat(100))
      const result = await REPO_MAP_TOOL.execute({
        input: {},
        toolUseId: 'test',
        cwd: bigDir,
      })
      assert.match(result.content, /tiny\.ts.*100B/)
      assert.match(result.content, /medium\.ts.*50KB/)
      assert.match(result.content, /huge\.json.*2\.0MB/)
    } finally {
      rmSync(bigDir, { recursive: true, force: true })
    }
  })

  it('max depth limit', async () => {
    const depthDir = mkdtempSync(join(tmpdir(), 'repomap-depth-'))
    try {
      mkdirSync(join(depthDir, 'a', 'b', 'c', 'd', 'e'), { recursive: true })
      writeFileSync(join(depthDir, 'a', 'b', 'c', 'd', 'e', 'deep.ts'), '')
      writeFileSync(join(depthDir, 'a', 'b', 'c', 'd', 'shallow.ts'), '')
      const result = await REPO_MAP_TOOL.execute({
        input: {},
        toolUseId: 'test',
        cwd: depthDir,
      })
      // deep.ts is at depth 5, should not appear
      assert.ok(!result.content.includes('deep.ts'), 'files beyond max depth should be excluded')
      assert.ok(result.content.includes('shallow.ts'), 'files within max depth should appear')
    } finally {
      rmSync(depthDir, { recursive: true, force: true })
    }
  })

  it('requiresApproval and isConcurrencySafe', () => {
    assert.equal(REPO_MAP_TOOL.requiresApproval(makeParams()), false)
    assert.equal(REPO_MAP_TOOL.isConcurrencySafe(), true)
  })
})
