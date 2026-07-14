import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TS_WASM_KEEP, pruneTreeSitterWasms } from '../tree-sitter-wasm-keep.js'

test('TS_WASM_KEEP matches meridian-parser LANG_WASM set', () => {
  assert.ok(TS_WASM_KEEP.has('tree-sitter-typescript.wasm'))
  assert.ok(TS_WASM_KEEP.has('tree-sitter-python.wasm'))
  assert.ok(TS_WASM_KEEP.has('tree-sitter-go.wasm'))
  assert.equal(TS_WASM_KEEP.size, 3)
})

test('pruneTreeSitterWasms keeps allowlist and deletes the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'ts-wasm-'))
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  for (const f of [
    'tree-sitter-typescript.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-go.wasm',
    'tree-sitter-rust.wasm',
    'tree-sitter-java.wasm',
    'README.txt',
  ]) {
    writeFileSync(join(outDir, f), 'x')
  }

  const { kept, removed } = pruneTreeSitterWasms(outDir)
  assert.deepEqual(kept.sort(), [
    'tree-sitter-go.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-typescript.wasm',
  ])
  assert.ok(removed.includes('tree-sitter-rust.wasm'))
  assert.ok(removed.includes('tree-sitter-java.wasm'))
  assert.equal(existsSync(join(outDir, 'tree-sitter-typescript.wasm')), true)
  assert.equal(existsSync(join(outDir, 'tree-sitter-rust.wasm')), false)
  // Non-wasm files are left alone
  assert.equal(existsSync(join(outDir, 'README.txt')), true)
  assert.equal(readdirSync(outDir).filter((f) => f.endsWith('.wasm')).length, 3)

  rmSync(root, { recursive: true, force: true })
})

test('pruneTreeSitterWasms is a no-op when outDir missing', () => {
  const { kept, removed } = pruneTreeSitterWasms(join(tmpdir(), 'no-such-wasm-out'))
  assert.deepEqual(kept, [])
  assert.deepEqual(removed, [])
})
