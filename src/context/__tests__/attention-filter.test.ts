import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPath } from '../attention-filter.js'

function tier(path: string) {
  return classifyPath(path).tier
}

describe('attention path classifier', () => {
  it('classifies build and dependency outputs as L0', () => {
    for (const file of [
      'node_modules/pkg/index.js',
      'dist/main.js',
      'build/output.js',
      '.next/server/app.js',
      'target/debug/app',
      '__pycache__/x.pyc',
      'coverage/lcov.info',
    ]) {
      const verdict = classifyPath(file)
      assert.equal(verdict.tier, 'L0_build', file)
      assert.equal(verdict.silent, true, file)
    }
  })

  it('classifies runtime fragments as L1', () => {
    for (const file of [
      'layout.log',
      'package-lock.lock',
      'worker.pid',
      'swap.swp',
      'scratch.tmp',
      'bundle.js.map',
      'tsconfig.tsbuildinfo',
      '.DS_Store',
      'Thumbs.db',
      'docs/teamtask.zip',
      'opencode-tui-beta.tar.gz',
      '.test-tmp/npm-test-current.log',
      '.rivet/sessions/session.jsonl',
      '.rivet/tasks/events/task_1.jsonl',
      '.rivet/plans/p0.md',
      '.rivet/cache-log/trace.jsonl',
      '.rivet/meridian.db-wal',
    ]) {
      const verdict = classifyPath(file)
      assert.equal(verdict.tier, 'L1_fragment', file)
      assert.equal(verdict.silent, true, file)
    }
  })

  it('classifies foreign tool footprints as L2 but keeps them distinct from L0', () => {
    for (const file of [
      '.agents/skills/writing-plans/SKILL.md',
      '.codex/hooks.json',
      '.obsidian/workspace.json',
      '.claude/settings.json',
    ]) {
      const verdict = classifyPath(file)
      assert.equal(verdict.tier, 'L2_foreign', file)
      assert.equal(verdict.silent, true, file)
      assert.notEqual(verdict.tier, 'L0_build', file)
    }
  })

  it('keeps human content visible by default', () => {
    for (const file of [
      'src/context/fs-watcher.ts',
      'docs/teamtask/T7-天枢注意力闸·运行碎片识别层.md',
      'docs/teamtask/G1-阶段验证与迭代基线计划.md',
      '.rivet/knowledge/memory.jsonl',
      'README.md',
      'weird-thing-no-ext',
    ]) {
      const verdict = classifyPath(file)
      assert.equal(verdict.tier, 'L3_content', file)
      assert.equal(verdict.silent, false, file)
    }
  })

  it('keeps editor project configuration in L3 for the first baseline', () => {
    assert.equal(tier('.vscode/settings.json'), 'L3_content')
    assert.equal(tier('.idea/workspace.xml'), 'L3_content')
  })

  it('normalizes platform separators without reading git or filesystem state', () => {
    assert.deepEqual(classifyPath('node_modules/pkg/index.js'), classifyPath('node_modules\\pkg\\index.js'))
    assert.deepEqual(classifyPath('./.codex/hooks.json'), classifyPath('.codex/hooks.json'))
    assert.equal(tier('new-project-specific-file'), 'L3_content')
  })
})
