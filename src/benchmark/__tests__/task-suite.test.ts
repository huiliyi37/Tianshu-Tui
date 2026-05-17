import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadTaskSuite } from '../task-suite.js'

describe('loadTaskSuite', () => {
  let dir: string

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'rivet-tasks-'))
  }

  function teardown() {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  function writeSuite(name: string, tasks: unknown[]) {
    const file = join(dir, `${name}.json`)
    writeFileSync(file, JSON.stringify({ tasks }), 'utf-8')
    return file
  }

  it('loads and validates a valid task suite', () => {
    setup()
    try {
      const file = writeSuite('valid', [
        {
          id: 'task-1',
          title: 'Read a file',
          category: 'repo_inspection',
          prompt: 'Read README.md',
          timeoutMs: 30000,
        },
        {
          id: 'task-2',
          title: 'Fix a bug',
          category: 'test_repair',
          prompt: 'Fix the failing test',
          setupCommands: ['npm install'],
          successCommands: ['npm test'],
          timeoutMs: 60000,
          tags: ['fast', 'repair'],
        },
      ])

      const suite = loadTaskSuite(file)
      assert.equal(suite.tasks.length, 2)
      assert.equal(suite.tasks[0]!.id, 'task-1')
      assert.equal(suite.tasks[1]!.id, 'task-2')
      assert.deepStrictEqual(suite.tasks[1]!.tags, ['fast', 'repair'])
    } finally {
      teardown()
    }
  })

  it('throws on missing tasks array', () => {
    setup()
    try {
      const file = writeSuite('bad', [])
      // Write a file without a "tasks" key
      writeFileSync(file, JSON.stringify({ something: 'else' }), 'utf-8')
      assert.throws(() => loadTaskSuite(file), /tasks/)
    } finally {
      teardown()
    }
  })

  it('throws on invalid task definition', () => {
    setup()
    try {
      const file = writeSuite('invalid-task', [
        {
          id: 'x',
          // missing title
          category: 'invalid',
          prompt: '',
          timeoutMs: -1,
        },
      ])
      assert.throws(() => loadTaskSuite(file))
    } finally {
      teardown()
    }
  })

  it('throws on non-existent file', () => {
    assert.throws(() => loadTaskSuite('/nonexistent/path/tasks.json'))
  })
})
