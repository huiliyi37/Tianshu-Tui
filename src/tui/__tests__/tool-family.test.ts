import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getToolFamily, getGroupSummary } from '../tool-family.js'

describe('ToolFamily', () => {
  it('classifies read_file as read family', () => {
    const f = getToolFamily('read_file')
    assert.equal(f.family, 'read')
    assert.equal(f.verb, 'read')
  })

  it('classifies grep as find family', () => {
    const f = getToolFamily('grep')
    assert.equal(f.family, 'find')
    assert.equal(f.verb, 'search')
  })

  it('classifies bash as run family', () => {
    const f = getToolFamily('bash')
    assert.equal(f.family, 'run')
    assert.equal(f.verb, 'run')
  })

  it('classifies edit_file as write family', () => {
    const f = getToolFamily('edit_file')
    assert.equal(f.family, 'write')
    assert.equal(f.verb, 'patch')
  })

  it('classifies unknown tool as other', () => {
    const f = getToolFamily('custom_mcp_tool')
    assert.equal(f.family, 'other')
    assert.equal(f.verb, 'tool')
  })

  it('getGroupSummary summarizes multiple tools', () => {
    const summary = getGroupSummary([
      { toolName: 'read_file' },
      { toolName: 'read_file' },
      { toolName: 'grep' },
      { toolName: 'bash' },
    ])
    assert.equal(summary, '4 tool calls: read_file x2, grep x1, bash x1')
  })

  it('getGroupSummary with single tool', () => {
    const summary = getGroupSummary([
      { toolName: 'edit_file' },
    ])
    assert.equal(summary, '1 tool call: edit_file x1')
  })

  it('getGroupSummary with tools without name', () => {
    const summary = getGroupSummary([
      {},
      {},
    ])
    assert.equal(summary, '2 tool calls: unknown x2')
  })
})
