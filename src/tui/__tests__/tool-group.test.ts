import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ToolGroup } from '../tool-group.js'

describe('ToolGroup', () => {
  it('exports ToolGroup component', () => {
    assert.ok(typeof ToolGroup === 'function' || typeof ToolGroup === 'object', 'ToolGroup should be a React component')
  })
})
