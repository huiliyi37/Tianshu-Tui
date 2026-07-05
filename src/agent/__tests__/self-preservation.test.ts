import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSelfDestructiveKill, getSelfProcessTree, type SelfProcessTree } from '../self-preservation.js'

const TREE: SelfProcessTree = { selfPid: 4242, ancestorPids: [1717] }

describe('isSelfDestructiveKill — node image kills (always self)', () => {
  it('blocks the field-report command that killed the sidecar', () => {
    assert.equal(
      isSelfDestructiveKill('taskkill //F //IM node.exe 2>/dev/null; sleep 1; echo killed', TREE),
      true,
    )
  })

  it('blocks taskkill /IM node.exe (single slash)', () => {
    assert.equal(isSelfDestructiveKill('taskkill /F /IM node.exe', TREE), true)
  })

  it('blocks pkill node and pkill -f node', () => {
    assert.equal(isSelfDestructiveKill('pkill node', TREE), true)
    assert.equal(isSelfDestructiveKill('pkill -f node', TREE), true)
  })

  it('blocks killall node', () => {
    assert.equal(isSelfDestructiveKill('killall node', TREE), true)
  })

  it('blocks wmic terminate of node.exe', () => {
    assert.equal(
      isSelfDestructiveKill('wmic process where name="node.exe" delete', TREE),
      true,
    )
  })

  it('catches a node kill hidden inside a chained command', () => {
    assert.equal(isSelfDestructiveKill('echo restarting && taskkill //IM node.exe', TREE), true)
  })

  it('catches a node kill inside a subshell', () => {
    assert.equal(isSelfDestructiveKill('foo $(pkill node)', TREE), true)
  })
})

describe('isSelfDestructiveKill — kill by own/ancestor PID', () => {
  it('blocks kill of the own PID', () => {
    assert.equal(isSelfDestructiveKill('kill -9 4242', TREE), true)
  })

  it('blocks kill of an ancestor PID', () => {
    assert.equal(isSelfDestructiveKill('kill 1717', TREE), true)
  })

  it('blocks taskkill /PID <ownpid>', () => {
    assert.equal(isSelfDestructiveKill('taskkill /F /PID 4242', TREE), true)
  })

  it('does not treat the signal number as a PID', () => {
    // -9 is the signal; 9 must NOT be read as a PID even if 9 were in the tree.
    const tree: SelfProcessTree = { selfPid: 9, ancestorPids: [] }
    assert.equal(isSelfDestructiveKill('kill -9 5555', tree), false)
  })
})

describe('isSelfDestructiveKill — legitimate uses stay allowed', () => {
  it('allows npx kill-port for restarting a dev server', () => {
    assert.equal(isSelfDestructiveKill('npx kill-port 3001', TREE), false)
  })

  it('allows a targeted kill of an unrelated PID', () => {
    assert.equal(isSelfDestructiveKill('kill -9 99999', TREE), false)
  })

  it('allows taskkill of a non-node image', () => {
    assert.equal(isSelfDestructiveKill('taskkill /F /IM chrome.exe', TREE), false)
  })

  it('allows an ordinary command', () => {
    assert.equal(isSelfDestructiveKill('git status', TREE), false)
  })

  it('ignores empty / non-string input', () => {
    assert.equal(isSelfDestructiveKill('', TREE), false)
    assert.equal(isSelfDestructiveKill('   ', TREE), false)
  })
})

describe('getSelfProcessTree', () => {
  it('reports the running process PID and (best-effort) parent', () => {
    const tree = getSelfProcessTree()
    assert.equal(tree.selfPid, process.pid)
    assert.ok(Array.isArray(tree.ancestorPids))
  })
})
