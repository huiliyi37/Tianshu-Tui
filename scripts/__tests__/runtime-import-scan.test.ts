import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pkgRoot, scanDist, ALLOWED_EXTERNALS } from '../runtime-import-scan.js'

test('pkgRoot handles plain and scoped packages', () => {
  assert.equal(pkgRoot('pixelmatch'), 'pixelmatch')
  assert.equal(pkgRoot('pngjs/lib/png'), 'pngjs')
  assert.equal(pkgRoot('@ast-grep/napi'), '@ast-grep/napi')
  assert.equal(pkgRoot('@ast-grep/napi-darwin-arm64'), '@ast-grep/napi-darwin-arm64')
})

test('scanDist flags unlisted bare imports with the importing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-import-scan-'))
  try {
    writeFileSync(join(dir, 'main.js'), '#!/usr/bin/env node\nimport { readFileSync } from "fs";\nimport { join as j } from "node:path";\nexport const x = 1\n')
    writeFileSync(join(dir, 'chunk-BAD.js'), 'import pixelmatch from "pixelmatch";\nimport { PNG } from "pngjs";\nconst m = await import("dyn-leak-pkg");\nexport const y = pixelmatch ? PNG && m : 0\n')
    const violations = await scanDist(dir)
    // esbuild 的 importer 是 realpath（macOS /var → /private/var），按文件名断言
    const byName = new Map([...violations].map(([f, s]) => [basename(f), s]))
    const bad = byName.get('chunk-BAD.js')
    assert.ok(bad, `chunk-BAD.js should be flagged, got: ${JSON.stringify([...byName].map(([f, s]) => [f, [...s]]))}`)
    assert.deepEqual([...bad].sort(), ['dyn-leak-pkg', 'pixelmatch', 'pngjs'])
    assert.equal(byName.has('main.js'), false, 'builtins must not be flagged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanDist passes allowlisted externals, string literals, and skipped dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-import-scan-'))
  try {
    writeFileSync(
      join(dir, 'main.js'),
      'import x from "esbuild";\nimport c from "@mariozechner/clipboard";\nconst tpl = `require("ajv/dist/runtime/uri").default`;\nconst s = "import fake from \\"not-a-real-import\\"";\nexport const y = [x, c, tpl, s]\n',
    )
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'ignored.js'), 'import y from "not-scanned-pkg";\n')
    const violations = await scanDist(dir)
    assert.equal(violations.size, 0, `unexpected: ${JSON.stringify([...violations].map(([f, s]) => [f, [...s]]))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanDist allowlist override is honored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-import-scan-'))
  try {
    writeFileSync(join(dir, 'main.js'), 'import pixelmatch from "pixelmatch";\nexport const p = pixelmatch\n')
    const violations = await scanDist(dir, { allowed: new Set([...ALLOWED_EXTERNALS, 'pixelmatch']) })
    assert.equal(violations.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
