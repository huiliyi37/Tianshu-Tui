import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyTaskDepth,
  extractTaskContract,
  type TaskContract,
  type DepthImpactHint,
} from '../task-contract.js'

function contract(objective: string, mentionedFiles: string[] = []): TaskContract {
  const base = extractTaskContract(objective, 1)
  return { ...base, scope: { mentionedFiles } }
}

describe('classifyTaskDepth', () => {
  describe('verb override — highest priority', () => {
    it('detects system verbs: E2E, 端到端, 全链路', () => {
      assert.equal(classifyTaskDepth(contract('添加端到端测试覆盖全链路')), 'system')
      assert.equal(classifyTaskDepth(contract('add E2E tests for the auth flow')), 'system')
      assert.equal(classifyTaskDepth(contract('end-to-end integration')), 'system')
      assert.equal(classifyTaskDepth(contract('cross-layer validation')), 'system')
    })

    it('detects wiring verbs: 接通, wire, integrate, 对接, 串联', () => {
      assert.equal(classifyTaskDepth(contract('接通 lspManager 到 tool-pipeline')), 'wiring')
      assert.equal(classifyTaskDepth(contract('wire lspManager into tool-pipeline')), 'wiring')
      assert.equal(classifyTaskDepth(contract('integrate auth module')), 'wiring')
      assert.equal(classifyTaskDepth(contract('对接第三方 API')), 'wiring')
      assert.equal(classifyTaskDepth(contract('串联 agent 和 TUI')), 'wiring')
      assert.equal(classifyTaskDepth(contract('hook up the new parser')), 'wiring')
    })

    it('system verb overrides even with single file', () => {
      assert.equal(
        classifyTaskDepth(contract('端到端测试 src/agent/loop.ts', ['src/agent/loop.ts'])),
        'system',
      )
    })

    it('wiring verb overrides even with zero files', () => {
      assert.equal(classifyTaskDepth(contract('接通 LSP 和编辑器')), 'wiring')
    })
  })

  describe('file count + impact analysis', () => {
    it('single file with no impact → unit', () => {
      assert.equal(
        classifyTaskDepth(contract('fix regex', ['src/context/task-contract.ts'])),
        'unit',
      )
    })

    it('2 files in same directory → unit', () => {
      assert.equal(
        classifyTaskDepth(contract('refactor helpers', ['src/agent/loop.ts', 'src/agent/types.ts'])),
        'unit',
      )
    })

    it('2 files in different top-level directories → wiring', () => {
      assert.equal(
        classifyTaskDepth(contract('fix integration', ['src/agent/loop.ts', 'src/prompt/engine.ts'])),
        'wiring',
      )
    })

    it('3+ files → wiring', () => {
      assert.equal(
        classifyTaskDepth(contract('refactor', [
          'src/agent/loop.ts',
          'src/agent/types.ts',
          'src/prompt/engine.ts',
        ])),
        'wiring',
      )
    })

    it('impact with 3+ direct deps → wiring', () => {
      const impact: DepthImpactHint = { directCount: 4, transitiveCount: 2 }
      assert.equal(classifyTaskDepth(contract('fix bug'), impact), 'wiring')
    })

    it('impact with 9+ direct deps → system', () => {
      const impact: DepthImpactHint = { directCount: 10, transitiveCount: 5 }
      assert.equal(classifyTaskDepth(contract('big refactor'), impact), 'system')
    })

    it('impact with 5+ direct and 10+ transitive → system', () => {
      const impact: DepthImpactHint = { directCount: 6, transitiveCount: 12 }
      assert.equal(classifyTaskDepth(contract('migrate API'), impact), 'system')
    })
  })

  describe('IntentTaskKind bias', () => {
    it('architecture_design → system', () => {
      assert.equal(
        classifyTaskDepth(contract('design the new module'), undefined, ['architecture_design']),
        'system',
      )
    })

    it('refactor + multi-file → wiring', () => {
      assert.equal(
        classifyTaskDepth(
          contract('clean up imports', ['src/agent/loop.ts', 'src/prompt/engine.ts']),
          undefined,
          ['refactor'],
        ),
        'wiring',
      )
    })

    it('refactor + single file → unit (no upgrade)', () => {
      assert.equal(
        classifyTaskDepth(
          contract('clean up', ['src/agent/loop.ts']),
          undefined,
          ['refactor'],
        ),
        'unit',
      )
    })

    it('bug_fix + single file → unit', () => {
      assert.equal(
        classifyTaskDepth(
          contract('fix the crash', ['src/agent/loop.ts']),
          undefined,
          ['bug_fix'],
        ),
        'unit',
      )
    })
  })

  describe('default case', () => {
    it('no signals → unit', () => {
      assert.equal(classifyTaskDepth(contract('do something')), 'unit')
    })

    it('empty mentioned files + no impact → unit', () => {
      assert.equal(classifyTaskDepth(contract('small fix', [])), 'unit')
    })
  })
})
