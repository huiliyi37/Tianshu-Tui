import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { IMPORT_RESOURCE_TOOL, parseGitHubUrl } from '../import-resource.js'
import type { ToolCallParams } from '../types.js'

function makeParams(input: Record<string, unknown>, cwd: string): ToolCallParams {
  return {
    input,
    toolUseId: 'test-import',
    cwd,
  }
}

describe('import_resource', () => {
  let tmpCwd: string
  let tmpExternal: string

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'import-test-'))
    tmpExternal = join(tmpCwd, '.rivet', 'external')
  })

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true })
  })

  describe('parseGitHubUrl', () => {
    it('parses simple owner/repo', () => {
      const result = parseGitHubUrl('github.com/user/repo')
      assert.deepEqual(result, { owner: 'user', repo: 'repo', ref: undefined, subpath: undefined })
    })

    it('parses https URL', () => {
      const result = parseGitHubUrl('https://github.com/owner/project')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: undefined, subpath: undefined })
    })

    it('parses URL with .git suffix', () => {
      const result = parseGitHubUrl('https://github.com/owner/project.git')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: undefined, subpath: undefined })
    })

    it('parses URL with tree ref and subpath', () => {
      const result = parseGitHubUrl('https://github.com/owner/project/tree/main/src/lib')
      assert.deepEqual(result, { owner: 'owner', repo: 'project', ref: 'main', subpath: 'src/lib' })
    })

    it('returns null for non-GitHub URLs', () => {
      assert.equal(parseGitHubUrl('https://example.com/file.txt'), null)
      assert.equal(parseGitHubUrl('/tmp/file.txt'), null)
    })
  })

  describe('local file import', () => {
    it('imports a local file via symlink', async () => {
      // Create an external file
      const externalDir = mkdtempSync(join(tmpdir(), 'ext-'))
      const externalFile = join(externalDir, 'test.txt')
      writeFileSync(externalFile, 'Hello, external world!')

      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: externalFile }, tmpCwd))
        assert.equal(result.isError, undefined)

        // Should contain the local path
        assert.match(result.content, /Imported:/)
        assert.match(result.content, /\.rivet\/external\//)

        // File should be accessible — check the import directory exists
        assert.ok(existsSync(join(tmpCwd, '.rivet', 'external')))

        // Should include preview
        assert.match(result.content, /Hello, external world!/)
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    })

    it('imports a directory via junction', async () => {
      const externalDir = mkdtempSync(join(tmpdir(), 'extdir-'))
      writeFileSync(join(externalDir, 'a.ts'), 'const a = 1')
      writeFileSync(join(externalDir, 'b.ts'), 'const b = 2')

      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: externalDir }, tmpCwd))
        assert.equal(result.isError, undefined)
        assert.match(result.content, /Type: directory/)
        assert.match(result.content, /Linked as junction/)
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    })

    it('returns error for nonexistent path', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: '/nonexistent/path/file.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      assert.match(result.content, /does not exist/)
    })

    it('returns error for empty source', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(makeParams({ source: '' }, tmpCwd))
      assert.equal(result.isError, true)
      assert.match(result.content, /source is required/)
    })

    it('expands ~ to HOME', async () => {
      // Just verify it doesn't crash — we can't test actual HOME reading without a real file
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: '~/nonexistent_test_file_xyz.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      // Should have expanded ~ to actual HOME path
      assert.doesNotMatch(result.content, /~/)
    })
  })

  describe('URL import', () => {
    it('returns error for unreachable URL', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: 'https://nonexistent.invalid/test.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
    })

    it('downloads a text file via httpFetchGuarded', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () =>
        new Response('downloaded content', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        })
      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(
          makeParams({ source: 'http://example.com/file.txt' }, tmpCwd),
        )
        assert.equal(result.isError, undefined)
        assert.match(result.content, /Imported:/)
        assert.match(result.content, /downloaded content/)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('rejects private IP URLs (SSRF)', async () => {
      const result = await IMPORT_RESOURCE_TOOL.execute(
        makeParams({ source: 'http://127.0.0.1/secret.txt' }, tmpCwd),
      )
      assert.equal(result.isError, true)
      assert.match(result.content, /Access denied/)
    })

    it('surfaces HTTP errors from the remote server', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async () => new Response('not found', { status: 404 })
      try {
        const result = await IMPORT_RESOURCE_TOOL.execute(
          makeParams({ source: 'http://example.com/missing.txt' }, tmpCwd),
        )
        assert.equal(result.isError, true)
        assert.match(result.content, /HTTP 404/)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('GitHub URL parsing edge cases', () => {
    it('handles blob URLs', () => {
      const result = parseGitHubUrl('https://github.com/owner/repo/blob/main/README.md')
      assert.ok(result)
      assert.equal(result.owner, 'owner')
      assert.equal(result.repo, 'repo')
      assert.equal(result.ref, 'main')
      assert.equal(result.subpath, 'README.md')
    })

    it('returns null for empty string', () => {
      assert.equal(parseGitHubUrl(''), null)
    })
  })

  describe('tool metadata', () => {
    it('requires approval', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.requiresApproval(makeParams({ source: '/tmp/x' }, tmpCwd)), true)
    })

    it('is not concurrency safe', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.isConcurrencySafe(), false)
    })

    it('is always enabled', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.isEnabled(), true)
    })

    it('has correct definition name', () => {
      assert.equal(IMPORT_RESOURCE_TOOL.definition.name, 'import_resource')
    })
  })
})
