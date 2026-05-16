import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentSchema, configSchema } from '../schema.js'
import { DEFAULT_CONFIG } from '../default.js'

describe('config permissions schema', () => {
  it('defaults permissions.allow to an empty list', () => {
    const agent = agentSchema.parse({})

    assert.deepEqual(agent.permissions.allow, [])
  })

  it('parses permissions.allow tool and params entries', () => {
    const agent = agentSchema.parse({
      permissions: {
        allow: [
          { tool: 'read_file', params: { file_path: 'docs/*' } },
          { tool: 'bash', params: { command: 'git status*' } },
        ],
      },
    })

    assert.equal(agent.permissions.allow.length, 2)
    assert.equal(agent.permissions.allow[0]?.tool, 'read_file')
    assert.deepEqual(agent.permissions.allow[1]?.params, { command: 'git status*' })
  })

  it('keeps DEFAULT_CONFIG compatible with configSchema', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.deepEqual(parsed.agent.permissions.allow, [])
  })
})
