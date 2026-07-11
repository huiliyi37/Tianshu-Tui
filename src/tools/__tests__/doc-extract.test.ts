import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildEngineChain,
  extractDocumentText,
  isExtractableDocument,
  EXTRACTION_CAVEAT,
  type CommandRunner,
} from '../doc-extract.js'

function enoent(): NodeJS.ErrnoException {
  const err = new Error('spawn ENOENT') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

describe('doc-extract', () => {
  describe('isExtractableDocument', () => {
    it('recognizes office/pdf extensions case-insensitively', () => {
      assert.equal(isExtractableDocument('/x/report.PDF'), true)
      assert.equal(isExtractableDocument('/x/spec.docx'), true)
      assert.equal(isExtractableDocument('/x/deck.pptx'), true)
      assert.equal(isExtractableDocument('/x/notes.odt'), true)
    })

    it('rejects plain text and unknown extensions', () => {
      assert.equal(isExtractableDocument('/x/readme.md'), false)
      assert.equal(isExtractableDocument('/x/archive.zip'), false)
      assert.equal(isExtractableDocument('/x/noext'), false)
    })
  })

  describe('buildEngineChain', () => {
    it('pdf uses pdftotext only', () => {
      const chain = buildEngineChain('.pdf', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['pdftotext'])
    })

    it('docx on linux skips textutil, ends with pandoc', () => {
      const chain = buildEngineChain('.docx', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['soffice', 'pandoc'])
    })

    it('legacy .doc never includes pandoc (cannot read .doc)', () => {
      const chain = buildEngineChain('.doc', 'linux')
      assert.deepEqual(chain.map(s => s.engine), ['soffice'])
    })

    it('pptx is soffice-only', () => {
      const chain = buildEngineChain('.pptx', 'darwin')
      assert.deepEqual(chain.map(s => s.engine), ['soffice'])
    })

    it('unknown extension yields empty chain', () => {
      assert.deepEqual(buildEngineChain('.zip', 'linux'), [])
    })
  })

  describe('extractDocumentText', () => {
    it('returns text from the first available engine', async () => {
      const calls: string[] = []
      const runner: CommandRunner = async (binary) => {
        calls.push(binary)
        if (binary === 'pdftotext') return { stdout: 'PDF BODY TEXT' }
        throw enoent()
      }
      const result = await extractDocumentText('/tmp/x.pdf', { runner, platform: 'linux' })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.equal(result.engine, 'pdftotext')
        assert.equal(result.text, 'PDF BODY TEXT')
      }
      assert.deepEqual(calls, ['pdftotext'])
    })

    it('falls through ENOENT engines to the next in chain', async () => {
      const calls: string[] = []
      const runner: CommandRunner = async (binary) => {
        calls.push(binary)
        if (binary === 'pandoc') return { stdout: 'DOCX VIA PANDOC' }
        throw enoent()
      }
      const result = await extractDocumentText('/tmp/spec.docx', { runner, platform: 'linux' })
      assert.equal(result.ok, true)
      if (result.ok) assert.equal(result.engine, 'pandoc')
      // soffice tries both binary names before falling through
      assert.deepEqual(calls, ['soffice', 'libreoffice', 'pandoc'])
    })

    it('treats empty output as failure and advances', async () => {
      const runner: CommandRunner = async (binary) => {
        if (binary === 'pdftotext') return { stdout: '   \n  ' }
        throw enoent()
      }
      const result = await extractDocumentText('/tmp/x.pdf', { runner, platform: 'linux' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.suggestion, /empty output/)
    })

    it('reports install suggestion when every engine is missing', async () => {
      const runner: CommandRunner = async () => { throw enoent() }
      const result = await extractDocumentText('/tmp/x.pdf', { runner, platform: 'linux' })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.match(result.suggestion, /pdftotext: not installed/)
        assert.match(result.suggestion, /poppler/)
      }
    })

    it('returns fail for unknown extensions without invoking any engine', async () => {
      let invoked = false
      const runner: CommandRunner = async () => { invoked = true; return { stdout: 'x' } }
      const result = await extractDocumentText('/tmp/data.zip', { runner, platform: 'linux' })
      assert.equal(result.ok, false)
      assert.equal(invoked, false)
    })

    it('conversion failure message is carried into the suggestion', async () => {
      const runner: CommandRunner = async () => { throw new Error('malformed PDF header') }
      const result = await extractDocumentText('/tmp/x.pdf', { runner, platform: 'linux' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.suggestion, /malformed PDF header/)
    })
  })

  it('EXTRACTION_CAVEAT flags lossy layout for downstream consumers', () => {
    assert.match(EXTRACTION_CAVEAT, /lossy/)
    assert.match(EXTRACTION_CAVEAT, /original file/)
  })
})
