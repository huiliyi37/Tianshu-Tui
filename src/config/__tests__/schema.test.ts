import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { agentSchema, configSchema, workersSchema } from '../schema.js'
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

  it('routes repo summarization workers to MiMo by default', () => {
    const parsed = configSchema.parse(DEFAULT_CONFIG)

    assert.equal(parsed.workers.routing.repo_summarization, 'mimo')
    assert.equal(parsed.workers.profiles.mimo?.provider, 'mimo')
    assert.equal(parsed.workers.profiles.mimo?.model, 'mimo-v2.5')
  })

  it('fills missing worker routing defaults with MiMo for repo summarization', () => {
    const parsed = workersSchema.parse({
      profiles: {
        mimo: { provider: 'mimo', model: 'mimo-v2.5' },
        capable: { provider: 'deepseek', model: 'deepseek-v4-pro' },
      },
    })

    assert.equal(parsed.routing.repo_summarization, 'mimo')
    assert.equal(parsed.routing.code_edit, 'capable')
  })
})
