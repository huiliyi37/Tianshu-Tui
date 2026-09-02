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

  it('reports root-mismatch with the actual location when the file lives in a cwd subdirectory', async () => {
    mkdirSync(join(dir, 'app/ui'), { recursive: true })
    writeFileSync(join(dir, 'app/ui/panel.ts'), 'export {}\n', 'utf-8')
    const report = await checkPlanFactAnchors('修改 `ui/panel.ts` 的布局。', dir)
    assert.equal(report.drifts.length, 1)
    assert.equal(report.drifts[0]!.kind, 'root-mismatch')
    assert.match(report.drifts[0]!.detail, /app\/ui\/panel\.ts/)
  })

  it('reports root-mismatch for parent and sibling roots (cross-project plans)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-anchors-reroot-'))
    const proj = join(base, 'proj')
    const sib = join(base, 'sib')
    mkdirSync(proj, { recursive: true })
    mkdirSync(join(sib, 'engine'), { recursive: true })
    mkdirSync(join(base, 'docs'), { recursive: true })
    writeFileSync(join(sib, 'engine/core.ts'), 'export {}\n', 'utf-8')
    writeFileSync(join(base, 'docs/notes.md'), '# n\n', 'utf-8')
    try {
      const report = await checkPlanFactAnchors('修改 `engine/core.ts` 与 `docs/notes.md`。', proj)
      assert.equal(report.drifts.length, 2)
      const byPath = new Map(report.drifts.map(d => [d.path, d]))
      assert.equal(byPath.get('engine/core.ts')!.kind, 'root-mismatch')
      assert.match(byPath.get('engine/core.ts')!.detail, /\.\.\/sib\/engine\/core\.ts/)
      assert.equal(byPath.get('docs/notes.md')!.kind, 'root-mismatch')
      assert.match(byPath.get('docs/notes.md')!.detail, /\.\.\/docs\/notes\.md/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('does not line-check re-rooted files (existence-only probing)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-anchors-noline-'))
    const proj = join(base, 'proj')
    const sib = join(base, 'sib')
    mkdirSync(proj, { recursive: true })
    mkdirSync(join(sib, 'engine'), { recursive: true })
    writeFileSync(join(sib, 'engine/core.ts'), '// 1\n// 2\n', 'utf-8')
    try {
      const report = await checkPlanFactAnchors('修改 `engine/core.ts:999`。', proj)
      assert.equal(report.drifts.length, 1)
      assert.equal(report.drifts[0]!.kind, 'root-mismatch')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('skips placeholder-shaped example anchors missing at every root', async () => {
    const report = await checkPlanFactAnchors('幻觉引用如 `src/foo.ts:42`、`src/a.py` 会被自动暴露。', dir)
    assert.deepEqual(report.drifts, [])
  })

  it('checks a placeholder-named file normally when it actually exists', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/foo.ts'), '// 1\n// 2\n', 'utf-8')
    const report = await checkPlanFactAnchors('修改 `src/foo.ts:99`。', dir)
    assert.equal(report.drifts.length, 1)
    assert.equal(report.drifts[0]!.kind, 'line-out-of-range')
  })

  it('does not extract enumeration-glued path tokens', () => {
    const anchors = extractPlanAnchors('同步 `README.md/README.zh.md/README.i18n.yaml` 三处描述。')
    assert.deepEqual(anchors, [])
  })

  it('bounds reroot probing on huge directories (budget cap, fail-open to missing-file)', async () => {
    // 300 子目录 + 50 个同首段 miss 锚点：换根探测 syscall 总数必须封顶，
    // 与目录规模解耦——渐进式探测的核心承诺。预算耗尽后剩余锚点 fail-open
    // 报 missing-file，不崩溃、不卡顿。
    const base = mkdtempSync(join(tmpdir(), 'rivet-anchors-budget-'))
    const proj = join(base, 'proj')
    mkdirSync(proj, { recursive: true })
    for (let i = 0; i < 300; i++) mkdirSync(join(proj, 'pkg-' + i), { recursive: true })
    try {
      const anchors = Array.from({ length: 50 }, (_, i) => `engine/mod${i}.ts`).join('`、`')
      const report = await checkPlanFactAnchors(`修改 \`${anchors}\`。`, proj)
      assert.ok(report.rerootProbes !== undefined, 'rerootProbes 统计字段存在')
      assert.ok(report.rerootProbes <= 128, `reroot probes bounded: ${report.rerootProbes}`)
      assert.equal(report.drifts.length, 50)
      assert.ok(report.drifts.every(d => d.kind === 'missing-file'), '预算耗尽降级为 missing-file')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('shares root first-level enumeration across same-segment anchors', async () => {
    // 多个同首段锚点共享同一份 root readdir 结果：每个候选根只枚举一次，
    // 各锚点独立命中（首段过滤缓存不破坏逐锚点探测语义）。
    mkdirSync(join(dir, 'app/ui'), { recursive: true })
    writeFileSync(join(dir, 'app/ui/panel.ts'), 'export {}\n', 'utf-8')
    writeFileSync(join(dir, 'app/ui/panel2.ts'), 'export {}\n', 'utf-8')
    const report = await checkPlanFactAnchors('修改 `ui/panel.ts` 与 `ui/panel2.ts`。', dir)
    assert.equal(report.drifts.length, 2)
    assert.ok(report.drifts.every(d => d.kind === 'root-mismatch'), '两个锚点都应命中 root-mismatch')
    assert.ok(report.rerootProbes <= 128)
  })

  it('reports zero reroot probes when no reroot is needed', async () => {
    const report = await checkPlanFactAnchors('修改 `engine/core/alpha.ts`。', dir)
    assert.equal(report.rerootProbes, 0, '全部锚点直接命中时不做换根探测')
    assert.deepEqual(report.drifts, [])
  })

  it('skips placeholder-shaped anchors silently when reroot budget is exhausted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'rivet-anchors-placeholder-budget-'))
    const proj = join(base, 'proj')
    mkdirSync(proj, { recursive: true })
    for (let i = 0; i < 300; i++) mkdirSync(join(proj, 'pkg-' + i), { recursive: true })
    try {
      const report = await checkPlanFactAnchors('幻觉引用如 `src/foo.ts:42` 会被静默跳过。', proj)
      assert.deepEqual(report.drifts, [], '占位锚点在预算压力下静默跳过而非误报')
      assert.ok(report.rerootProbes <= 128)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
