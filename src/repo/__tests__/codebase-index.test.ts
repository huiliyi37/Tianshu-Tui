import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  detectProjectState,
  discoverModules,
  seedModuleSummaries,
  extractCliEntries,
  generateCodebaseIndexBlock,
  KNOWN_MODULE_SUMMARIES,
} from '../codebase-index.js'
import type { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)

// ── Helper: create a throwaway MeridianDb ──────────────────────────

function createTestDb(): { db: MeridianDb; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cbi-test-'))
  const { MeridianDb } = require('../meridian-db.js') as typeof import('../meridian-db.js')
  const db = new MeridianDb(dir)
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

// ── Helper: seed a file with symbols into DB ──────────────────────

function seedFileWithExports(db: MeridianDb, filePath: string, symbols: Array<{ name: string; kind: string; exported: boolean; line: number }>): void {
  const hash = 'abc123'
  // Insert file
  db.upsertFile({
    filePath,
    contentHash: hash,
    symbols: symbols.map(s => ({
      id: `${filePath}:${s.name}:${s.line}`,
      name: s.name,
      kind: s.kind as any,
      filePath,
      line: s.line,
      exported: s.exported,
      contentHash: hash,
    })),
    edges: [],
    imports: [],
  })
}

// ════════════════════════════════════════════════════════════════════

describe('detectProjectState', () => {
  it('returns "empty" when DB has no files', () => {
    const { db, cleanup } = createTestDb()
    const emptyDir = mkdtempSync(join(tmpdir(), 'rivet-empty-'))
    try {
      assert.equal(detectProjectState(emptyDir, db), 'empty')
    } finally {
      cleanup()
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('returns "indexed" when module_summaries have entries', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.upsertModuleSummary({
        dirPath: 'src/agent/',
        summary: 'test',
        keyExports: [],
        fileCount: 1,
        status: 'active',
        contentHash: '',
        verifiedAtCommit: 'abc',
      })
      assert.equal(detectProjectState(process.cwd(), db), 'indexed')
    } finally {
      cleanup()
    }
  })
})

describe('discoverModules', () => {
  it('groups files by top-level directory and collects exports', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedFileWithExports(db, 'src/agent/loop.ts', [
        { name: 'AgentLoop', kind: 'class', exported: true, line: 1 },
        { name: 'runTurn', kind: 'function', exported: true, line: 10 },
      ])
      seedFileWithExports(db, 'src/tools/bash.ts', [
        { name: 'BASH_TOOL', kind: 'variable', exported: true, line: 1 },
      ])
      seedFileWithExports(db, 'src/tools/__tests__/bash.test.ts', [
        { name: 'testHelper', kind: 'function', exported: true, line: 1 },
      ])

      const modules = discoverModules(db)
      assert.ok(modules.length >= 2)

      const agentMod = modules.find(m => m.dirPath === 'src/agent/')
      assert.ok(agentMod, 'should find src/agent/ module')
      assert.equal(agentMod.files.length, 1)
      assert.ok(agentMod.exportedSymbols.some(s => s.name === 'AgentLoop'))

      const toolsMod = modules.find(m => m.dirPath === 'src/tools/')
      assert.ok(toolsMod, 'should find src/tools/ module')
      // test files should be excluded
      assert.ok(!toolsMod.files.some(f => f.includes('.test.')))
    } finally {
      cleanup()
    }
  })
})

describe('seedModuleSummaries', () => {
  it('seeds known modules with descriptions from AGENTS.md', () => {
    const { db, cleanup } = createTestDb()
    try {
      seedFileWithExports(db, 'src/agent/loop.ts', [
        { name: 'AgentLoop', kind: 'class', exported: true, line: 1 },
      ])

      const count = seedModuleSummaries(db, 'deadbeef')
      assert.ok(count >= 1)

      const summaries = db.getModuleSummaries()
      const agentSummary = summaries.find(s => s.dirPath === 'src/agent/')
      assert.ok(agentSummary)
      assert.equal(agentSummary.summary, KNOWN_MODULE_SUMMARIES['src/agent/'])
      assert.equal(agentSummary.verifiedAtCommit, 'deadbeef')
    } finally {
      cleanup()
    }
  })
})

describe('extractCliEntries', () => {
  it('extracts args[0] === patterns', () => {
    const source = `
      if (args[0] === 'serve') { startServer() }
      if (args[0] === '--help') { showHelp() }
    `
    const entries = extractCliEntries(source, null, 'src/main.tsx', 'src/headless.ts', 'abc123')
    assert.ok(entries.some(e => e.flag === 'serve'))
    assert.ok(entries.some(e => e.flag === '--help'))
    assert.ok(entries.every(e => e.sourceFile === 'src/main.tsx'))
    assert.ok(entries.every(e => e.verifiedAtCommit === 'abc123'))
  })

  it('extracts args.includes patterns', () => {
    const source = `
      if (args.includes('--goal')) { }
      if (args.includes('-p')) { }
    `
    const entries = extractCliEntries(source, null, 'src/main.tsx', 'src/headless.ts')
    assert.ok(entries.some(e => e.flag === '--goal'))
    assert.ok(entries.some(e => e.flag === '-p'))
  })

  it('extracts args.indexOf patterns', () => {
    const source = `
      const portIdx = args.indexOf('--port')
      const modelIdx = args.indexOf('--model')
    `
    const entries = extractCliEntries(source, null, 'src/main.tsx', 'src/headless.ts')
    assert.ok(entries.some(e => e.flag === '--port'))
    assert.ok(entries.some(e => e.flag === '--model'))
  })

  it('extracts headless flags when headless source provided', () => {
    const mainSource = ''
    const headlessSource = `
      const jsonIdx = args.findIndex(a => a === '--json')
      if (args.includes('--print')) { }
    `
    const entries = extractCliEntries(mainSource, headlessSource, 'src/main.tsx', 'src/headless.ts')
    assert.ok(entries.some(e => e.flag === '--json' && e.sourceFile === 'src/headless.ts'))
    assert.ok(entries.some(e => e.flag === '--print' && e.sourceFile === 'src/headless.ts'))
  })
})

describe('generateCodebaseIndexBlock', () => {
  it('returns empty string when DB is empty', () => {
    const { db, cleanup } = createTestDb()
    try {
      const block = generateCodebaseIndexBlock(db)
      assert.equal(block, '')
    } finally {
      cleanup()
    }
  })

  it('generates index block with modules and CLI entries', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.upsertModuleSummary({
        dirPath: 'src/agent/',
        summary: 'Core agent loop',
        keyExports: ['AgentLoop', 'runTurn'],
        fileCount: 5,
        status: 'active',
        contentHash: '',
        verifiedAtCommit: 'abc123',
      })
      db.upsertCliEntry({
        flag: '--print',
        handler: 'main.tsx:998',
        wired: true,
        verifiedAtCommit: 'abc123',
        sourceFile: 'src/main.tsx',
      })

      const block = generateCodebaseIndexBlock(db, 'abc123')
      assert.ok(block.includes('<codebase-index>'))
      assert.ok(block.includes('src/agent/'))
      assert.ok(block.includes('Core agent loop'))
      assert.ok(block.includes('AgentLoop'))
      assert.ok(block.includes('--print'))
      assert.ok(block.includes('main.tsx:998'))
      assert.ok(!block.includes('⚠stale'))
    } finally {
      cleanup()
    }
  })

  it('marks stale entries when HEAD differs', () => {
    const { db, cleanup } = createTestDb()
    try {
      db.upsertModuleSummary({
        dirPath: 'src/agent/',
        summary: 'Core agent loop',
        keyExports: [],
        fileCount: 5,
        status: 'active',
        contentHash: '',
        verifiedAtCommit: 'oldsha',
      })

      const block = generateCodebaseIndexBlock(db, 'newsha')
      assert.ok(block.includes('⚠stale'))
    } finally {
      cleanup()
    }
  })
})
