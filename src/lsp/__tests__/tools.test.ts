import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGotoDefinitionTool, createFindReferencesTool } from '../tools.js'
import type { LspManager } from '../manager.js'
import type { ToolCallParams } from '../../tools/types.js'

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'tu_1', cwd: '/project' }
}

describe('createGotoDefinitionTool', () => {
  it('has correct tool definition', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.definition.name, 'lsp_goto_definition')
    assert.ok(tool.definition.description!.includes('Go to the definition'))
    assert.ok(tool.definition.input_schema)
    assert.equal(tool.definition.input_schema!.required!.length, 3)
    assert.ok(tool.definition.input_schema!.required!.includes('file_path'))
    assert.ok(tool.definition.input_schema!.required!.includes('line'))
    assert.ok(tool.definition.input_schema!.required!.includes('column'))
    assert.ok(tool.isEnabled())
    assert.equal(tool.requiresApproval(makeParams({})), false)
    assert.equal(tool.isConcurrencySafe(), true)
  })

  it('disabled when LSP not ready', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => false,
      supportsDefinition: () => false,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.isEnabled(), false)
  })

  it('disabled when server lacks definition support', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    assert.equal(tool.isEnabled(), false)
  })

  it('returns definition location', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async (file, line, col) => {
        assert.equal(file, 'src/foo.ts')
        assert.equal(line, 10)
        assert.equal(col, 5)
        return [{
          uri: 'src/bar.ts',
          range: { start: { line: 5, character: 3 }, end: { line: 5, character: 10 } },
        }]
      },
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 10, column: 5 }))

    assert.ok(result.content.includes('src/bar.ts'))
    assert.ok(result.content.includes(':6:')) // display uses 1-based line: 5 → 6
    assert.ok(result.content.includes(':3')) // column unchanged
    assert.equal(result.isError, undefined)
  })

  it('handles empty result gracefully', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/nonexistent.ts', line: 1, column: 1 }))

    assert.ok(result.content.includes('No definition found'))
  })

  it('returns error for missing file_path parameter', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => true,
      supportsReferences: () => false,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createGotoDefinitionTool(mgr)
    const result = await tool.execute(makeParams({ line: 1, column: 1 }))

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('file_path'))
  })
})

describe('createFindReferencesTool', () => {
  it('returns reference list', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [
        { uri: 'src/a.ts', range: { start: { line: 5, character: 3 }, end: { line: 5, character: 9 } } },
        { uri: 'src/b.ts', range: { start: { line: 12, character: 1 }, end: { line: 12, character: 7 } } },
      ],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 10, column: 5 }))

    assert.ok(result.content.includes('2 reference(s)'))
    assert.ok(result.content.includes('src/a.ts'))
    assert.ok(result.content.includes('src/b.ts'))
    assert.ok(result.content.includes(':6:')) // 5 → 1-based: 6
    assert.ok(result.content.includes(':13:')) // 12 → 1-based: 13
    assert.equal(result.isError, undefined)
  })

  it('handles empty result', async () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => true,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    const result = await tool.execute(makeParams({ file_path: 'src/foo.ts', line: 1, column: 1 }))

    assert.ok(result.content.includes('No references found'))
  })

  it('disabled when not ready', () => {
    const mgr: LspManager = {
      initialize: async () => {},
      isReady: () => false,
      supportsDefinition: () => false,
      supportsReferences: () => true,
      gotoDefinition: async () => [],
      findReferences: async () => [],
      changeFile: () => {},
      getFileDiagnostics: async () => [],
      dispose: () => {},
    }

    const tool = createFindReferencesTool(mgr)
    assert.equal(tool.isEnabled(), false)
  })
})
