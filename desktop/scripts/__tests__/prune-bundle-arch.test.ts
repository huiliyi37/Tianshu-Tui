import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resolveKeepArch,
  planPrunePaths,
  pruneBundleArch,
} from '../prune-bundle-arch.js'

test('resolveKeepArch maps apple triples', () => {
  assert.equal(resolveKeepArch('aarch64-apple-darwin'), 'arm64')
  assert.equal(resolveKeepArch('x86_64-apple-darwin'), 'x64')
})

test('planPrunePaths keeps only target node + native platform pkgs', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-'))
  try {
    const nodeRoot = join(root, 'node-runtime')
    mkdirSync(join(nodeRoot, 'darwin-arm64'), { recursive: true })
    mkdirSync(join(nodeRoot, 'darwin-x64'), { recursive: true })
    writeFileSync(join(nodeRoot, 'darwin-arm64', 'node'), 'arm')
    writeFileSync(join(nodeRoot, 'darwin-x64', 'node'), 'x64')
    const nm = join(root, 'rivet-runtime', 'node_modules')
    mkdirSync(join(nm, '@esbuild', 'darwin-arm64'), { recursive: true })
    mkdirSync(join(nm, '@esbuild', 'darwin-x64'), { recursive: true })
    mkdirSync(join(nm, '@ast-grep', 'napi-darwin-arm64'), { recursive: true })
    mkdirSync(join(nm, '@ast-grep', 'napi-darwin-x64'), { recursive: true })

    const plan = planPrunePaths(root, 'arm64')
    assert.ok(plan.some((p) => p.endsWith(join('darwin-x64'))))
    assert.ok(!plan.some((p) => p.endsWith(join('darwin-arm64'))))
    assert.ok(plan.some((p) => p.includes('@esbuild') && p.includes('darwin-x64')))
    assert.ok(plan.some((p) => p.includes('napi-darwin-x64')))

    pruneBundleArch(root, 'arm64')
    assert.equal(existsSync(join(nodeRoot, 'darwin-x64')), false)
    assert.equal(existsSync(join(nodeRoot, 'darwin-arm64')), true)
    assert.equal(existsSync(join(nm, '@esbuild', 'darwin-x64')), false)
    assert.equal(existsSync(join(nm, '@esbuild', 'darwin-arm64')), true)
    assert.equal(existsSync(join(nm, '@ast-grep', 'napi-darwin-x64')), false)
    assert.equal(existsSync(join(nm, '@ast-grep', 'napi-darwin-arm64')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planPrunePaths for x64 drops arm64 siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'prune-x64-'))
  try {
    mkdirSync(join(root, 'node-runtime', 'darwin-arm64'), { recursive: true })
    mkdirSync(join(root, 'node-runtime', 'darwin-x64'), { recursive: true })
    const plan = planPrunePaths(root, 'x64')
    assert.ok(plan.some((p) => p.endsWith(join('darwin-arm64'))))
    assert.ok(!plan.some((p) => p.endsWith(join('darwin-x64'))))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
