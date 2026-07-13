import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkPlanFactAnchors, extractPlanAnchors, formatAnchorDrifts } from '../plan-fact-anchors.js'

/**
 * Fixture uses an arbitrary project shape (engine/, notes/) that does NOT
 * mirror this repository's layout — pins the "generic path recognition"
 * contract: recognition is shape-based (contains '/', known extension) +
 * filesystem stat, never a hardcoded directory whitelist. Rivet ships to
 * arbitrary user projects.
 */
describe('checkPlanFactAnchors', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-anchors-'))
    mkdirSync(join(dir, 'engine/core'), { recursive: true })
    mkdirSync(join(dir, 'notes'), { recursive: true })
    writeFileSync(join(dir, 'engine/core/alpha.ts'), Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join('\n'), 'utf-8')
    writeFileSync(join(dir, 'notes/design.md'), '# design\n', 'utf-8')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes anchors that exist in the working tree', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/alpha.ts` 和 `notes/design.md`。', dir)
    assert.equal(report.checked, 2)
    assert.deepEqual(report.drifts, [])
  })

  it('flags a referenced file that does not exist', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/missing.ts` 的导出。', dir)
    assert.equal(report.drifts.length, 1)
    assert.equal(report.drifts[0]!.kind, 'missing-file')
    assert.equal(report.drifts[0]!.path, 'engine/core/missing.ts')
  })

  it('passes 新增 file even when parent directory does not exist (new modules create dirs on write)', async () => {
    const report = await checkPlanFactAnchors('- [ ] 新增 `engine/components/selector.tsx` — 选择器组件', dir)
    assert.deepEqual(report.drifts, [])
  })

  it('passes 新增 file when the parent directory exists', async () => {
    const report = await checkPlanFactAnchors('- [ ] 新增 `engine/core/beta.ts` — 新模块', dir)
    assert.deepEqual(report.drifts, [])
  })

  it('exempts a path declared 新增 elsewhere when re-referenced without the marker', async () => {
    const plan = [
      '- [ ] 新增 `engine/core/beta.ts` — 新模块',
      '验证时读取 `engine/core/beta.ts`。',
    ].join('\n')
    const report = await checkPlanFactAnchors(plan, dir)
    assert.deepEqual(report.drifts, [])
  })

  it('flags line anchors beyond the current file length', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/alpha.ts:120`。', dir)
    assert.equal(report.drifts.length, 1)
    assert.equal(report.drifts[0]!.kind, 'line-out-of-range')
    assert.equal(report.drifts[0]!.line, 120)
  })

  it('passes line anchors within the current file length', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/alpha.ts:42-45`。', dir)
    assert.deepEqual(report.drifts, [])
  })

  it('skips absolute paths, escapes and node_modules references', async () => {
    const plan = [
      '参考 /etc/hosts.conf 与 `../outside/file.ts`。',
      '依赖 node_modules/ink/build/index.js 的行为。',
    ].join('\n')
    const report = await checkPlanFactAnchors(plan, dir)
    assert.equal(report.checked, 0)
    assert.deepEqual(report.drifts, [])
  })

  it('does not extract paths embedded in URLs', () => {
    const anchors = extractPlanAnchors('见 https://github.com/foo/bar/blob/main/src/thing.ts 的实现。')
    assert.deepEqual(anchors, [])
  })

  it('skips non-shell fenced blocks but checks shell fences', async () => {
    const plan = [
      '```mermaid',
      'flowchart TD',
      '    A[engine/fake/diagram.ts] --> B',
      '```',
      '```ts',
      "import { x } from 'engine/fake/proposal.ts'",
      '```',
      '```bash',
      'npx tsx --test engine/core/missing.test.ts',
      '```',
    ].join('\n')
    const report = await checkPlanFactAnchors(plan, dir)
    assert.equal(report.drifts.length, 1)
    assert.equal(report.drifts[0]!.path, 'engine/core/missing.test.ts')
  })

  it('formats drifts as markdown bullets', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/gone.ts`。', dir)
    const text = formatAnchorDrifts(report.drifts)
    assert.match(text, /^- /)
    assert.match(text, /engine\/core\/gone\.ts/)
  })
})
