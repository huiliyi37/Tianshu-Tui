import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSpreadsheet, CREATE_SPREADSHEET_TOOL, renderSpreadsheet } from '../create-spreadsheet.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-create-spreadsheet-'))
}

describe('create_spreadsheet', () => {
  it('creates CSV with quoted commas, quotes, and newlines', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, '白嫖gpt', 'scores.csv')
      const result = await createSpreadsheet({
        destination_path: destination,
        headers: ['Name', 'Note'],
        rows: [['天枢', 'a,b'], ['quote', 'x"y'], ['line', 'a\nb']],
      })

      assert.equal(result.format, 'csv')
      assert.equal(readFileSync(destination, 'utf-8'), 'Name,Note\n天枢,"a,b"\nquote,"x""y"\nline,"a\nb"\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates Excel-openable xls as escaped HTML table', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'Honglin   zhang', 'report.xls')
      const result = await createSpreadsheet({
        destination_path: destination,
        title: 'A&B',
        headers: ['<Name>', 'Score'],
        rows: [['天枢', 100]],
      })
      const content = readFileSync(destination, 'utf-8')

      assert.equal(result.format, 'xls')
      assert.ok(content.includes('<!doctype html>'))
      assert.ok(content.includes('<caption>A&amp;B</caption>'))
      assert.ok(content.includes('&lt;Name&gt;'))
      assert.ok(content.includes('<td>天枢</td>'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders TSV without quoting normal comma cells', () => {
    assert.deepEqual(
      renderSpreadsheet({ destination_path: '/tmp/a.tsv', headers: ['A'], rows: [['x,y']] }),
      { format: 'tsv', content: 'A\nx,y\n' },
    )
  })

  it('tool execute returns useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'table.html')
      const result = await CREATE_SPREADSHEET_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-sheet',
        input: { destination_path: destination, headers: ['A'], rows: [[1]] },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('Created html spreadsheet'))
      assert.ok(result.content.includes(destination))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing rows', async () => {
    const result = await CREATE_SPREADSHEET_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-sheet-error',
      input: { destination_path: '/tmp/no-rows.csv' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /rows is required/)
  })
})
