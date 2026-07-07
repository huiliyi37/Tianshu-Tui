import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createImage, CREATE_IMAGE_TOOL, renderImage } from '../create-image.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-create-image-'))
}

describe('create_image', () => {
  it('creates an SVG file from a full SVG document', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, '白嫖gpt', 'logo.svg')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#38bdf8"/></svg>'
      const result = await createImage({ destination_path: destination, svg })

      assert.equal(result.format, 'svg')
      const content = readFileSync(destination, 'utf-8')
      assert.ok(content.includes('<svg xmlns='))
      assert.ok(content.includes('<circle'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wraps raw SVG inner elements in <svg> tag', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'chart.svg')
      const svg = '<rect x="10" y="20" width="30" height="40" fill="#818cf8"/>'
      const result = await createImage({ destination_path: destination, svg, width: 200, height: 120 })

      assert.equal(result.format, 'svg')
      const content = readFileSync(destination, 'utf-8')
      assert.ok(content.includes('<svg xmlns='))
      assert.ok(content.includes('width="200"'))
      assert.ok(content.includes('height="120"'))
      assert.ok(content.includes('viewBox="0 0 200 120"'))
      assert.ok(content.includes('<rect'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('extracts SVG from markdown code fence', () => {
    const result = renderImage({
      svg: '```svg\n<circle r="10"/>\n```',
    })
    assert.ok(result.content.includes('<svg xmlns='))
    assert.ok(result.content.includes('<circle r="10"/>'))
    assert.ok(!result.content.includes('```'))
  })

  it('tool execute returns useful success message', async () => {
    const dir = tempDir()
    try {
      const destination = join(dir, 'icon.svg')
      const result = await CREATE_IMAGE_TOOL.execute({
        cwd: process.cwd(),
        toolUseId: 'tu-img',
        input: { destination_path: destination, svg: '<circle r="10"/>' },
      })

      assert.equal(result.isError, undefined)
      assert.ok(result.content.includes('Created svg image'))
      assert.ok(result.content.includes(destination))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing svg', async () => {
    const result = await CREATE_IMAGE_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-img-error',
      input: { destination_path: '/tmp/no-svg.svg' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /svg is required/)
  })
})
