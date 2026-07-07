import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPresentation, CREATE_PRESENTATION_TOOL, renderPresentation } from '../create-presentation.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-create-presentation-'))
}

describe('create_presentation', () => {
  it('creates an HTML presentation with slides', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'deck.ppt')
      const result = await createPresentation({
        destination_path: destination,
        title: 'Q4 Review',
        slides: [
          { title: 'Overview', content: 'Key results' },
          { title: 'Next Steps', content: 'Launch\nIterate' },
        ],
      })

      assert.equal(result.format, 'ppt')
      const content = readFileSync(destination, 'utf-8')
      assert.ok(content.includes('<!doctype html>'))
      assert.ok(content.includes('<title>Q4 Review</title>'))
      assert.ok(content.includes('<h1'))
      assert.ok(content.includes('Overview'))
      assert.ok(content.includes('Next Steps'))
      assert.ok(content.includes('page-break-after'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports dark theme', () => {
    const result = renderPresentation({
      slides: [{ title: 'Slide', content: 'Body' }],
      theme: 'dark',
    })
    assert.ok(result.content.includes('background:#0f172a'))
    assert.ok(result.content.includes('color:#e2e8f0'))
  })

  it('tool execute returns useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'pitch.ppt')
      const result = await CREATE_PRESENTATION_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-pres',
        input: {
          destination_path: destination,
          title: 'Pitch',
          slides: [{ title: 'Hello', content: 'World' }],
        },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('Created ppt presentation'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects empty slides', async () => {
    const result = await CREATE_PRESENTATION_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-pres-error',
      input: { destination_path: '/tmp/empty.ppt', slides: [] },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /slides must be a non-empty array/)
  })

  it('escapes HTML in slide content', () => {
    const result = renderPresentation({
      slides: [{ title: 'A&B', content: '<script>alert(1)</script>' }],
    })
    assert.ok(result.content.includes('A&amp;B'))
    assert.ok(result.content.includes('&lt;script&gt;'))
    assert.ok(!result.content.includes('<script>'))
  })
})
