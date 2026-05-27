import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PLAN_CLOSE_TOOL } from '../plan-close.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(tmpdir(), 'opencode-plan-close-tool-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

function writePlan(name = 'demo.md'): string {
  const planDir = join(TEST_DIR, 'docs', 'superpowers', 'plans')
  mkdirSync(planDir, { recursive: true })
  const file = join(planDir, name)
  writeFileSync(file, `# Demo 实现计划\n\n**技术栈：** TypeScript。\n\n### Task 1 — Alpha\n\n- [ ] 修改：\`src/a.ts\`\n\n## 7. Execution handoff\n\n选哪种方式？\n`, 'utf-8')
  return file
}

describe('plan_close tool', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('previews without modifying the file', async () => {
    const file = writePlan()
    const before = readFileSync(file, 'utf-8')

    const result = await PLAN_CLOSE_TOOL.execute(makeParams({
      file_path: file,
      tasks: '1',
    }))

    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Plan close preview'))
    assert.ok(result.content.includes('No files changed'))
    assert.equal(readFileSync(file, 'utf-8'), before)
    assert.ok(readFileSync(file, 'utf-8').includes('- [ ] 修改'))
  })

  it('applies plan closure when approved by caller', async () => {
    const file = writePlan()

    const result = await PLAN_CLOSE_TOOL.execute(makeParams({
      file_path: file,
      tasks: '1',
      apply: true,
      verifiedCommands: ['npx tsc --noEmit'],
      deliveryState: 'GREEN',
    }))

    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Plan closed'))
    const after = readFileSync(file, 'utf-8')
    assert.ok(after.includes('- [x] 修改'))
    assert.ok(after.includes('## 7. Execution closure'))
    assert.ok(after.includes('npx tsc --noEmit'))
  })

  it('rejects paths outside docs superpowers plans', async () => {
    const file = join(TEST_DIR, 'README.md')
    writeFileSync(file, '# Readme\n', 'utf-8')

    const result = await PLAN_CLOSE_TOOL.execute(makeParams({
      file_path: file,
      tasks: '1',
    }))

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('docs/superpowers/plans'))
  })

  it('requires approval only for apply mode', () => {
    assert.equal(PLAN_CLOSE_TOOL.requiresApproval(makeParams({ apply: false })), false)
    assert.equal(PLAN_CLOSE_TOOL.requiresApproval(makeParams({ apply: true })), true)
  })
})
