import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMcpToolWrapper, createMcpConnectorConsent, mcpToolName } from '../wrapper.js'

describe('mcpToolName', () => {
  it('prefixes with server id', () => {
    assert.equal(mcpToolName('github', 'create_issue'), 'mcp__github__create_issue')
  })

  it('handles tool names with slashes', () => {
    assert.equal(mcpToolName('ctx7', 'resolve-library-id'), 'mcp__ctx7__resolve-library-id')
  })
})

describe('createMcpToolWrapper', () => {
  it('wraps MCP tool definition as Rivet Tool', () => {
    const mcpDef = {
      name: 'search',
      description: 'Search the web',
      inputSchema: {
        type: 'object' as const,
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }
    const callTool = async (_input: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'result text' }],
      isError: false,
    })
    const tool = createMcpToolWrapper('web', mcpDef, callTool)

    assert.equal(tool.definition.name, 'mcp__web__search')
    assert.equal(tool.definition.description, 'Search the web')
    assert.ok(tool.isEnabled())
    assert.ok(tool.isConcurrencySafe())
  })

  it('executes via callTool and returns string content', async () => {
    const mcpDef = {
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object' as const, properties: { msg: { type: 'string' } } },
    }
    const callTool = async (input: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `Echo: ${input.msg}` }],
      isError: false,
    })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: { msg: 'hello' },
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.content, 'Echo: hello\n[MCP: test · read-only]')
    assert.equal(result.isError, undefined)
  })

  it('handles MCP error responses', async () => {
    const mcpDef = {
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({
      content: [{ type: 'text' as const, text: 'Server error' }],
      isError: true,
    })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: {},
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Server error'))
  })

  it('handles callTool exceptions gracefully', async () => {
    const mcpDef = {
      name: 'crash',
      description: 'Crashes',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => { throw new Error('Connection lost') }
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: {},
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Connection lost'))
  })

  it('MCP tool error: model content is concise (first line), full text in uiContent', async () => {
    const mcpDef = {
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const bigError = 'Server error: root cause here\n' + Array.from({ length: 50 }, (_, i) => `stack frame ${i}`).join('\n')
    const callTool = async () => ({ content: [{ type: 'text' as const, text: bigError }], isError: true })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({ input: {}, toolUseId: 'tu_1', cwd: '/tmp' })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('root cause here'), 'model sees the first-line reason')
    assert.ok(!result.content.includes('stack frame 40'), 'model does NOT get the full stack dump')
    assert.ok(result.uiContent && result.uiContent.includes('stack frame 49'), 'uiContent keeps full text for TUI')
  })

  it('MCP exception: model content concise, full message in uiContent', async () => {
    const mcpDef = {
      name: 'crash',
      description: 'Crashes',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => { throw new Error('Connection lost\nverbose detail line') }
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({ input: {}, toolUseId: 'tu_1', cwd: '/tmp' })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Connection lost'))
    assert.ok(!result.content.includes('verbose detail line'), 'model content omits the verbose tail')
    assert.ok(result.uiContent && result.uiContent.includes('verbose detail line'), 'uiContent keeps full message')
  })

  it('converts MCP inputSchema to Rivet input_schema', () => {
    const mcpDef = {
      name: 'write',
      description: 'Write file',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], isError: false })
    const tool = createMcpToolWrapper('fs', mcpDef, callTool)

    assert.deepEqual(tool.definition.input_schema?.required, ['path', 'content'])
    assert.equal((tool.definition.input_schema?.properties as any).path.description, 'File path')
  })

  it('requires approval for write-like MCP tools', () => {
    const mcpDef = {
      name: 'create_file',
      description: 'Create or overwrite a file',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })
    const tool = createMcpToolWrapper('fs', mcpDef, callTool)

    assert.equal(tool.requiresApproval({ input: {}, toolUseId: '1', cwd: '/tmp' }), true)
  })

  it('does not require approval for read-like MCP tools', () => {
    const mcpDef = {
      name: 'search_code',
      description: 'Search code in repository',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })
    const tool = createMcpToolWrapper('grep', mcpDef, callTool)

    assert.equal(tool.requiresApproval({ input: {}, toolUseId: '1', cwd: '/tmp' }), false)
  })
})

describe('MCP connector opt-in (first-use consent)', () => {
  const readDef = {
    name: 'search_code',
    description: 'Search code in repository',
    inputSchema: { type: 'object' as const, properties: {} },
  }
  const okCall = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], isError: false })
  const callParams = { input: {}, toolUseId: '1', cwd: '/tmp' }

  it('requires approval on first use of a connector when consent is wired', () => {
    const consent = createMcpConnectorConsent()
    const tool = createMcpToolWrapper('ctx7', readDef, okCall, consent)
    assert.equal(tool.requiresApproval(callParams), true)
  })

  it('stops requiring approval after the connector has been used (opted in)', async () => {
    const consent = createMcpConnectorConsent()
    const tool = createMcpToolWrapper('ctx7', readDef, okCall, consent)
    assert.equal(tool.requiresApproval(callParams), true)
    await tool.execute(callParams)
    assert.equal(tool.requiresApproval(callParams), false)
  })

  it('opt-in is per connector — approving one does not unlock another', async () => {
    const consent = createMcpConnectorConsent()
    const a = createMcpToolWrapper('serverA', readDef, okCall, consent)
    const b = createMcpToolWrapper('serverB', readDef, okCall, consent)
    await a.execute(callParams)
    assert.equal(a.requiresApproval(callParams), false)
    assert.equal(b.requiresApproval(callParams), true)
  })

  it('write-capable tools still require approval even after opt-in', async () => {
    const consent = createMcpConnectorConsent()
    const writeDef = {
      name: 'create_issue',
      description: 'Create an issue',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const tool = createMcpToolWrapper('gh', writeDef, okCall, consent)
    await tool.execute(callParams)
    assert.equal(tool.requiresApproval(callParams), true)
  })

  it('without a consent store, read-only tools behave as before (no opt-in gate)', () => {
    const tool = createMcpToolWrapper('ctx7', readDef, okCall)
    assert.equal(tool.requiresApproval(callParams), false)
  })
})
