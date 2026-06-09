import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDocument, CREATE_DOCUMENT_TOOL, renderDocument } from '../create-document.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-create-document-'))
}

describe('create_document', () => {
  it('creates markdown with a title inferred from .md extension', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, '白嫖gpt', '报告.md')
      const result = await createDocument({ destination_path: destination, title: '天枢报告', content: '正文' })

      assert.equal(result.format, 'md')
      assert.equal(readFileSync(destination, 'utf-8'), '# 天枢报告\n\n正文')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates Word-openable doc as escaped HTML', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'Honglin   zhang', 'report.doc')
      const result = await createDocument({ destination_path: destination, title: 'A&B', content: '<hello>\nworld' })
      const content = readFileSync(destination, 'utf-8')

      assert.equal(result.format, 'doc')
      assert.ok(content.includes('<!doctype html>'))
      assert.ok(content.includes('<h1>A&amp;B</h1>'))
      assert.ok(content.includes('&lt;hello&gt;'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders txt with title and content', () => {
    assert.deepEqual(
      renderDocument({ destination_path: '/tmp/a.txt', title: 'Title', content: 'Body' }),
      { format: 'txt', content: 'Title\n\nBody' },
    )
  })

  it('tool execute returns useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'notes.html')
      const result = await CREATE_DOCUMENT_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-doc',
        input: { destination_path: destination, title: 'Notes', content: 'Line' },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('Created html document'))
      assert.ok(result.content.includes(destination))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing content', async () => {
    const result = await CREATE_DOCUMENT_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-doc-error',
      input: { destination_path: '/tmp/no-content.md' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /content is required/)
  })
})
