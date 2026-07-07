import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFile, groupFilesByDomain, decomposeByDataContract } from '../dispatcher.js'
import type { TaskContract } from '../../context/task-contract.js'

function makeContract(files: string[], objective = 'test objective'): TaskContract {
  return {
    id: 'test-contract',
    objective,
    scope: { mentionedFiles: files },
    constraints: [],
    successCriteria: [],
    status: 'exploring',
    createdAtTurn: 0,
    updatedAtTurn: 0,
    isActionable: true,
  }
}

describe('classifyFile', () => {
  it('classifies src/tui/ as frontend', () => {
    assert.equal(classifyFile('src/tui/app.tsx'), 'frontend')
    assert.equal(classifyFile('src/tui/status-bar.tsx'), 'frontend')
  })

  it('classifies src/prompt/ as prompt', () => {
    assert.equal(classifyFile('src/prompt/engine.ts'), 'prompt')
    assert.equal(classifyFile('src/prompt/static.ts'), 'prompt')
  })

  it('classifies src/config/ as config', () => {
    assert.equal(classifyFile('src/config/schema.ts'), 'config')
    assert.equal(classifyFile('src/config/manager.ts'), 'config')
  })

  it('classifies src/tools/ as tools', () => {
    assert.equal(classifyFile('src/tools/grep.ts'), 'tools')
    assert.equal(classifyFile('src/tools/bash.ts'), 'tools')
  })

  it('classifies src/agent/ as backend', () => {
    assert.equal(classifyFile('src/agent/loop.ts'), 'backend')
    assert.equal(classifyFile('src/agent/coordinator.ts'), 'backend')
  })

  it('classifies src/api/ as backend', () => {
    assert.equal(classifyFile('src/api/client.ts'), 'backend')
  })

  it('classifies docs/ as docs', () => {
    assert.equal(classifyFile('docs/spec.md'), 'docs')
  })

  it('classifies test files as tests', () => {
    assert.equal(classifyFile('src/agent/__tests__/loop.test.ts'), 'tests')
    assert.equal(classifyFile('src/tools/__tests__/grep.test.ts'), 'tests')
  })
})

describe('groupFilesByDomain', () => {
  it('groups mixed files by domain', () => {
    const groups = groupFilesByDomain([
      'src/tui/app.tsx',
      'src/agent/loop.ts',
      'src/prompt/engine.ts',
      'src/agent/__tests__/loop.test.ts',
    ])
    assert.deepEqual(groups.get('frontend'), ['src/tui/app.tsx'])
    assert.deepEqual(groups.get('backend'), ['src/agent/loop.ts'])
    assert.deepEqual(groups.get('prompt'), ['src/prompt/engine.ts'])
    assert.deepEqual(groups.get('tests'), ['src/agent/__tests__/loop.test.ts'])
  })
})

describe('decomposeByDataContract', () => {
  it('returns single task for no files', () => {
    const tasks = decomposeByDataContract(makeContract([], 'fix the bug'))
    assert.equal(tasks.length, 1)
    assert.equal(tasks[0]!.domain, 'backend')
  })

  it('returns multiple tasks for multi-domain files', () => {
    const tasks = decomposeByDataContract(makeContract([
      'src/agent/loop.ts',
      'src/tui/app.tsx',
    ]))
    assert.equal(tasks.length, 2)
    const domains = tasks.map(t => t.domain).sort()
    assert.deepEqual(domains, ['backend', 'frontend'])
  })

  it('tests domain depends on source domain via data-flow', () => {
    const tasks = decomposeByDataContract(makeContract([
      'src/agent/loop.ts',
      'src/agent/__tests__/loop.test.ts',
    ]))
    assert.equal(tasks.length, 2)
    const testTask = tasks.find(t => t.domain === 'tests')
    const backendTask = tasks.find(t => t.domain === 'backend')
    assert.ok(testTask)
    assert.ok(backendTask)
    // tests should depend on backend (data-flow: test tests the source)
    assert.ok(testTask.dependsOn.includes(tasks.indexOf(backendTask)))
  })

  it('independent domains have no dependencies (parallel)', () => {
    const tasks = decomposeByDataContract(makeContract([
      'src/agent/loop.ts',
      'src/tui/app.tsx',
    ]))
    for (const task of tasks) {
      assert.deepEqual(task.dependsOn, [], `${task.title} should have no deps`)
    }
  })
})
