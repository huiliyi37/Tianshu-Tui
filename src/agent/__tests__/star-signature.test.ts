import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getStarSignature } from '../star-signature.js'

describe('getStarSignature', () => {
  describe('ground tools (highest training-lock risk)', () => {
    it('bash → 执令', () => {
      assert.equal(getStarSignature('bash'), '\n── 执令（bash）')
    })
    it('grep → 寻迹', () => {
      assert.equal(getStarSignature('grep'), '\n── 寻迹（grep）')
    })
    it('git → 史官', () => {
      assert.equal(getStarSignature('git'), '\n── 史官（git）')
    })
  })

  describe('file observation tools', () => {
    it('read_file → 观象', () => {
      assert.equal(getStarSignature('read_file'), '\n── 观象（read_file）')
    })
    it('read_section → 观象', () => {
      assert.equal(getStarSignature('read_section'), '\n── 观象（read_section）')
    })
    it('diff → 观象', () => {
      assert.equal(getStarSignature('diff'), '\n── 观象（diff）')
    })
  })

  describe('file mutation tools', () => {
    it('edit_file → 织造', () => {
      assert.equal(getStarSignature('edit_file'), '\n── 织造（edit_file）')
    })
    it('write_file → 织造', () => {
      assert.equal(getStarSignature('write_file'), '\n── 织造（write_file）')
    })
  })

  describe('navigation tools', () => {
    it('glob → 巡天', () => {
      assert.equal(getStarSignature('glob'), '\n── 巡天（glob）')
    })
    it('repo_map → 巡天', () => {
      assert.equal(getStarSignature('repo_map'), '\n── 巡天（repo_map）')
    })
  })

  describe('verification tools', () => {
    it('run_tests → 试炼', () => {
      assert.equal(getStarSignature('run_tests'), '\n── 试炼（run_tests）')
    })
    it('deliver_task → 试炼', () => {
      assert.equal(getStarSignature('deliver_task'), '\n── 试炼（deliver_task）')
    })
  })

  describe('delegation tools', () => {
    it('delegate_task → 分星', () => {
      assert.equal(getStarSignature('delegate_task'), '\n── 分星（delegate_task）')
    })
  })

  describe('interrupt tools (no signature)', () => {
    it('ask_user_question returns null', () => {
      assert.equal(getStarSignature('ask_user_question'), null)
    })
  })

  describe('unknown tool (no signature)', () => {
    it('returns null for unmapped tool', () => {
      assert.equal(getStarSignature('nonexistent_tool'), null)
    })
  })

  describe('tool name is preserved in signature', () => {
    const allTools = [
      'bash', 'grep', 'git', 'read_file', 'read_section', 'diff',
      'edit_file', 'write_file', 'glob', 'repo_map', 'run_tests',
      'deliver_task', 'delegate_task', 'sandbox_exec', 'undo',
      'inspect_project', 'repo_graph', 'web_fetch', 'web_search',
      'recall', 'todo', 'delegate_batch', 'related_tests',
    ]

    for (const tool of allTools) {
      it(`${tool} has mapping`, () => {
        const sig = getStarSignature(tool)
        // All declared tools should have a mapping
        assert.notEqual(sig, null, `${tool} should have a star signature`)
        // And the signature should contain the tool name
        assert.ok(sig!.includes(tool), `${tool} signature should contain tool name`)
      })
    }
  })
})
