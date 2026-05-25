import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

describe('prefix-cache-isolation', () => {
  const SURFACE_DIR = join(import.meta.dirname, '..')
  const SOURCE_FILES = readdirSync(SURFACE_DIR)
    .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter(f => f !== 'index.ts')

  const FORBIDDEN_IMPORTS = [
    '../prompt/',
    'src/prompt/',
    '../agent/loop',
    '../agent/session',
    'AgentSession',
    'getMessages',
    'replaceMessages',
  ]

  it('surface/ source files do not import prompt or session modules', () => {
    for (const file of SOURCE_FILES) {
      const content = readFileSync(join(SURFACE_DIR, file), 'utf-8')
      for (const pattern of FORBIDDEN_IMPORTS) {
        assert.ok(
          !content.includes(pattern),
          `${file} violates isolation: contains "${pattern}"`
        )
      }
    }
  })

  it('surface/ source files do not reference AgentLoop', () => {
    for (const file of SOURCE_FILES) {
      const content = readFileSync(join(SURFACE_DIR, file), 'utf-8')
      assert.ok(
        !content.includes('AgentLoop'),
        `${file} violates isolation: references AgentLoop`
      )
    }
  })
})
