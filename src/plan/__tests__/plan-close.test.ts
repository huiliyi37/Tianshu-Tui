import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { closePlanMarkdown, parseTaskSelection } from '../plan-close.js'

const fixture = `# Demo 实现计划

**技术栈：** TypeScript strict。

说明：示例 checkbox \`- [ ]\` 不应被改。

### Task 1 — Alpha

- [ ] 修改：\`src/a.ts:1-10\`
- [ ] 测试：\`src/a.test.ts\`

### Task 2 — Beta

- [ ] 修改：\`src/b.ts:1-10\`

### Task 4 — Delta

- [x] 测试：\`src/d.test.ts\`
`

describe('parseTaskSelection', () => {
  it('parses single numbers, ranges, and comma-separated selections', () => {
    assert.deepEqual(parseTaskSelection('1'), [1])
    assert.deepEqual(parseTaskSelection('1-3'), [1, 2, 3])
    assert.deepEqual(parseTaskSelection('1,3-4,3'), [1, 3, 4])
    assert.deepEqual(parseTaskSelection('all'), [])
  })

  it('rejects invalid selections', () => {
    assert.throws(() => parseTaskSelection(''), /Invalid task selection/)
    assert.throws(() => parseTaskSelection('0'), /Invalid task selection/)
    assert.throws(() => parseTaskSelection('3-1'), /Invalid task selection/)
    assert.throws(() => parseTaskSelection('1,,2'), /Invalid task selection/)
    assert.throws(() => parseTaskSelection('x'), /Invalid task selection/)
  })
})

describe('closePlanMarkdown', () => {
  it('marks only selected task blocks as complete', () => {
    const result = closePlanMarkdown(fixture, { tasks: '1', updateClosure: false })

    assert.equal(result.totalChangedCheckboxes, 2)
    assert.deepEqual(result.changes, [{ taskNumber: 1, checkboxCount: 2, changedCheckboxCount: 2 }])
    assert.ok(result.content.includes('说明：示例 checkbox `- [ ]` 不应被改。'))
    assert.ok(result.content.includes('### Task 1 — Alpha\n\n- [x] 修改：`src/a.ts:1-10`\n- [x] 测试：`src/a.test.ts`'))
    assert.ok(result.content.includes('### Task 2 — Beta\n\n- [ ] 修改：`src/b.ts:1-10`'))
  })

  it('supports task ranges and comma separated selections', () => {
    const result = closePlanMarkdown(fixture, { tasks: '1-2,4', updateClosure: false })

    assert.deepEqual(result.changes.map(change => change.taskNumber), [1, 2, 4])
    assert.equal(result.totalChangedCheckboxes, 3)
    assert.ok(result.content.includes('- [x] 修改：`src/a.ts:1-10`'))
    assert.ok(result.content.includes('- [x] 修改：`src/b.ts:1-10`'))
    assert.ok(result.content.includes('- [x] 测试：`src/d.test.ts`'))
  })

  it('is idempotent when selected tasks are already complete', () => {
    const input = `# Done Plan\n\n### Task 4 — Delta\n\n- [x] 测试：\`src/d.test.ts\`\n`
    const result = closePlanMarkdown(input, { tasks: '4', updateClosure: false })

    assert.equal(result.totalChangedCheckboxes, 0)
    assert.equal(result.alreadyClosed, true)
    assert.equal(result.content, input)
  })

  it('inserts execution status near the header and rewrites handoff to closure', () => {
    const input = `${fixture}\n## 7. Execution handoff\n\n选哪种方式？\n`
    const result = closePlanMarkdown(input, {
      tasks: '1-2',
      verifiedCommands: ['npx tsc --noEmit', 'npm exec -- tsx --test src/plan/__tests__/plan-close.test.ts'],
      deliveryState: 'YELLOW',
      note: '共享 worktree 中存在外部文件，owned files 已验证。',
    })

    assert.ok(result.content.includes('**执行状态：** 已闭环。Task 1-2 均已完成；验证通过；交付门检查：YELLOW。'))
    assert.ok(result.content.includes('## 7. Execution closure'))
    assert.ok(!result.content.includes('## 7. Execution handoff'))
    assert.ok(result.content.includes('```bash\nnpx tsc --noEmit\nnpm exec -- tsx --test src/plan/__tests__/plan-close.test.ts\n```'))
    assert.ok(result.content.includes('备注：共享 worktree 中存在外部文件，owned files 已验证。'))
    assert.equal(result.closureUpdated, true)
  })

  it('updates existing execution status and closure without duplicating sections', () => {
    const input = `${fixture}\n**执行状态：** 旧状态。\n\n## 7. Execution closure\n\n旧闭环。\n`
    const first = closePlanMarkdown(input, { tasks: 'all', deliveryState: 'GREEN' })
    const second = closePlanMarkdown(first.content, { tasks: 'all', deliveryState: 'GREEN' })

    assert.equal(second.content.match(/\*\*执行状态：\*\*/g)?.length, 1)
    assert.equal(second.content.match(/## 7\. Execution closure/g)?.length, 1)
    assert.ok(second.content.includes('**执行状态：** 已闭环。Task 1,2,4 均已完成；验证通过；交付门检查：GREEN。'))
  })

  it('ignores task headings and checkboxes inside fenced code blocks', () => {
    const input = `# Demo 实现计划\n\n### Task 1 — Real\n\n- [ ] 修改：\`src/real.ts\`\n\n\`\`\`md\n### Task 2 — Example Only\n\n- [ ] 修改：\`src/example.ts\`\n\`\`\`\n\n### Task 3 — Real Later\n\n- [ ] 测试：\`src/real.test.ts\`\n`

    const result = closePlanMarkdown(input, { tasks: '1-3', updateClosure: false })

    assert.deepEqual(result.changes.map(change => change.taskNumber), [1, 3])
    assert.equal(result.totalChangedCheckboxes, 2)
    assert.ok(result.content.includes('### Task 2 — Example Only\n\n- [ ] 修改：`src/example.ts`'))
    assert.ok(result.content.includes('### Task 3 — Real Later\n\n- [x] 测试：`src/real.test.ts`'))
  })

  it('ignores execution closure headings inside fenced code blocks', () => {
    const input = `# Demo 实现计划\n\n**技术栈：** TypeScript strict。\n\n### Task 1 — Real\n\n- [ ] 修改：\`src/real.ts\`\n\n\`\`\`md\n## 7. Execution closure\n\n示例闭环内容，不是真实章节。\n\`\`\`\n\n### Task 2 — Real Later\n\n- [ ] 测试：\`src/real.test.ts\`\n\n## 7. Execution handoff\n\n选哪种方式？\n`

    const result = closePlanMarkdown(input, { tasks: '1-2', deliveryState: 'GREEN' })

    assert.ok(result.content.includes('```md\n## 7. Execution closure\n\n示例闭环内容，不是真实章节。\n```'))
    assert.ok(result.content.includes('## 7. Execution closure\n\n已闭环：Task 1-2 均已完成并通过验证。'))
    assert.ok(!result.content.includes('选哪种方式？'))
  })

  it('throws when no selected task blocks match', () => {
    assert.throws(() => closePlanMarkdown(fixture, { tasks: '9' }), /No matching task blocks/)
  })
})
