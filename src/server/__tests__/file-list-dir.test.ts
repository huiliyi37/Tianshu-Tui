import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listDirEntries } from '../file-list.js'

// ── listDirEntries: single-level directory listing for file browser ──

test('listDirEntries: returns direct children of a directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-listdir-'))
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1')
    writeFileSync(join(dir, 'b.md'), '# B')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'nested.ts'), 'deep')

    const entries = await listDirEntries(dir)
    assert.ok(entries.length >= 3, `expected ≥3 entries, got ${entries.length}`)
    const names = entries.map(e => e.name).sort()
    assert.ok(names.includes('a.ts'))
    assert.ok(names.includes('b.md'))
    assert.ok(names.includes('src'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listDirEntries: marks directories vs files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-listdir-'))
  try {
    writeFileSync(join(dir, 'file.txt'), 'x')
    mkdirSync(join(dir, 'subdir'))

    const entries = await listDirEntries(dir)
    const fileEntry = entries.find(e => e.name === 'file.txt')
    const dirEntry = entries.find(e => e.name === 'subdir')
    assert.ok(fileEntry, 'file entry present')
    assert.equal(fileEntry!.isDirectory, false)
    assert.ok(dirEntry, 'dir entry present')
    assert.equal(dirEntry!.isDirectory, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listDirEntries: excludes common build/dep dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-listdir-'))
  try {
    mkdirSync(join(dir, 'node_modules'))
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'real.ts'), 'x')

    const entries = await listDirEntries(dir)
    const names = entries.map(e => e.name)
    assert.ok(names.includes('real.ts'), 'real file present')
    assert.ok(!names.includes('node_modules'), 'node_modules excluded')
    assert.ok(!names.includes('.git'), '.git excluded')
    assert.ok(!names.includes('dist'), 'dist excluded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listDirEntries: respects gitignore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-listdir-'))
  try {
    writeFileSync(join(dir, '.gitignore'), '*.log\n')
    writeFileSync(join(dir, 'app.ts'), 'x')
    writeFileSync(join(dir, 'debug.log'), 'log')

    const entries = await listDirEntries(dir)
    const names = entries.map(e => e.name)
    assert.ok(names.includes('app.ts'), 'non-ignored file present')
    assert.ok(!names.includes('debug.log'), 'gitignored file excluded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listDirEntries: non-existent directory returns empty array', async () => {
  const entries = await listDirEntries(join(tmpdir(), 'does-not-exist-xyz-123'))
  assert.deepEqual(entries, [])
})

test('listDirEntries: sorts directories first, then files alphabetically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-listdir-'))
  try {
    writeFileSync(join(dir, 'z-file.ts'), 'x')
    mkdirSync(join(dir, 'a-dir'))
    writeFileSync(join(dir, 'a-file.ts'), 'x')
    mkdirSync(join(dir, 'z-dir'))

    const entries = await listDirEntries(dir)
    const order = entries.map(e => `${e.isDirectory ? 'D' : 'F'}:${e.name}`)
    // Directories first (a-dir, z-dir), then files (a-file, z-file)
    assert.deepEqual(order, ['D:a-dir', 'D:z-dir', 'F:a-file.ts', 'F:z-file.ts'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
