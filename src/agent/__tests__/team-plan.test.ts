import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hasOverlappingFiles, parseTeamTaskDrafts } from '../team-plan.js'

describe('parseTeamTaskDrafts', () => {
  it('parses loop-split style Step sections', () => {
    const tasks = parseTeamTaskDrafts(`
### 推荐的提取顺序

**Step 6a: \`initializeRun()\`（~103 行）**
- 修改：\`src/agent/loop.ts\`
- 测试：npm exec -- tsx --test src/agent/__tests__/loop.test.ts

**Step 6b: \`runCompaction(turn, compactFailures)\`（~80 行）**
- 修改：src/agent/compaction-controller.ts
- 验证：npx tsc --noEmit
`)

    assert.equal(tasks.length, 2)
    assert.equal(tasks[0]!.id, 'Step 6a')
    assert.match(tasks[0]!.title, /initializeRun/)
    assert.deepEqual(tasks[0]!.files, ['src/agent/loop.ts', 'src/agent/__tests__/loop.test.ts'])
    assert.equal(tasks[0]!.profile, 'adversarial_verifier')
    assert.equal(tasks[0]!.kind, 'verify')
    assert.ok(tasks[0]!.verification.some(line => line.includes('npm exec')))
    assert.equal(tasks[1]!.id, 'Step 6b')
    assert.deepEqual(tasks[1]!.files, ['src/agent/compaction-controller.ts'])
  })

  it('classifies review and verification tasks', () => {
    const tasks = parseTeamTaskDrafts(`
### Task 1: 实现 parser
修改 src/agent/team-plan.ts

### Task 2: Review Squadron 审查
审查 src/agent/team-plan.ts

### Task 3: 验证测试
运行 npx tsc --noEmit
`)

    assert.equal(tasks[0]!.profile, 'patcher')
    assert.equal(tasks[0]!.kind, 'patch_proposal')
    assert.equal(tasks[1]!.profile, 'reviewer')
    assert.equal(tasks[1]!.kind, 'review')
    assert.equal(tasks[2]!.profile, 'adversarial_verifier')
    assert.equal(tasks[2]!.kind, 'verify')
  })

  it('returns empty list for documents without task headings', () => {
    assert.deepEqual(parseTeamTaskDrafts('# Design only\nNo tasks yet.'), [])
  })

  it('detects overlapping file scopes', () => {
    const [a, b, c] = parseTeamTaskDrafts(`
### T1: edit A
修改 src/a.ts
### T2: edit A again
修改 src/a.ts
### T3: edit B
修改 src/b.ts
`)

    assert.equal(hasOverlappingFiles(a!, b!), true)
    assert.equal(hasOverlappingFiles(a!, c!), false)
  })
})
