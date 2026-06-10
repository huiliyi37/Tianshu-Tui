import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPdf, CREATE_PDF_TOOL, renderPdf } from '../create-pdf.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-create-pdf-'))
}

describe('create_pdf', () => {
  it('creates a print-ready HTML document', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'report.html')
      const result = await createPdf({
        destination_path: destination,
        title: 'Q4 Report',
        content: '<h1>Q4 Report</h1><p>Revenue grew 15%</p>',
      })

      assert.equal(result.format, 'html')
      const content = readFileSync(destination, 'utf-8')
      assert.ok(content.includes('<!doctype html>'))
      assert.ok(content.includes('<title>Q4 Report</title>'))
      assert.ok(content.includes('<h1>Q4 Report</h1>'))
      assert.ok(content.includes('@page'))
      assert.ok(content.includes('size: 210mm 297mm'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports Letter landscape', () => {
    const result = renderPdf({
      title: 'Invoice',
      content: '<p>Line</p>',
      pageSize: 'Letter',
      orientation: 'landscape',
    })
    assert.ok(result.content.includes('size: 8.5in 11in landscape'))
  })

  it('includes print CSS rules', () => {
    const result = renderPdf({
      content: '<h1>Title</h1><p>Body</p>',
    })
    assert.ok(result.content.includes('@page'))
    assert.ok(result.content.includes('page-break-after'))
    assert.ok(result.content.includes('orphans:3'))
  })

  it('tool execute returns useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'doc.html')
      const result = await CREATE_PDF_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-pdf',
        input: { destination_path: destination, title: 'Doc', content: '<p>Hello</p>' },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('Created print-ready html document'))
      assert.ok(result.content.includes('Cmd+P'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing content', async () => {
    const result = await CREATE_PDF_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-pdf-error',
      input: { destination_path: '/tmp/no-content.html' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /content is required/)
  })
})
