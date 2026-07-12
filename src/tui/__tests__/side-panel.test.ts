/**
 * Side panel rendering tests.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth } from '../width.js'
import { renderSidePanel, resolveSidePanelWidth, SIDE_PANEL_MIN_COLUMNS } from '../side-panel.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('renderSidePanel', () => {
  it('returns non-empty output with minimal input', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'deepseek-chat',
    }, theme)
    assert.ok(lines.length > 0, 'should produce at least one line')
  })

  it('includes model name in output', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'claude-opus',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('claude-opus'), `model name: ${all}`)
  })

  it('renders todo items', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [
        { id: '1', content: 'Fix the cache bug', status: 'in_progress' },
      ],
      workers: [],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('Fix the cache bug'), `todo item: ${all}`)
  })

  it('renders worker info', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [{
        workerId: 'wo_01',
        shortLabel: 'T1',
        parentToolId: 'tool_01',
        profile: 'code_scout',
        authority: 'tianquan',
        status: 'running',
        panelStatus: 'running',
        terminal: false,
        activity: 'reading files...',
        activityLog: [],
        elapsedMs: 5000,
        toolUseCount: 0,
        tokenCount: 0,
        unread: false,
      }],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    // 复用主区 formatWorkerRow 后，侧栏 worker 行字段与主区一致：
    //   ◐ {星名 · 职能名} {elapsed}（窄列省略 activity），不再显示 shortLabel(如 T1)。
    assert.ok(all.includes('侦察'), `worker profile label (unified with main area): ${all}`)
    assert.ok(all.includes('◐'), `running status glyph: ${all}`)
    assert.ok(all.includes('5s'), `worker elapsed: ${all}`)
  })

  it('renders current tool info', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      currentTool: { name: 'grep', elapsedMs: 2300 },
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('grep'), `tool name: ${all}`)
  })

  it('renders token gauge when tokens given', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      estimatedTokens: 64_000,
      maxTokens: 128_000,
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('50%'), `token ratio: ${all}`)
  })

  it('renders domain glyph and name', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      domainGlyph: '◇',
      domainName: '天枢',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('天枢'), `domain name: ${all}`)
    assert.ok(all.includes('◇'), `domain glyph: ${all}`)
  })

  it('each line does not exceed panel width', () => {
    for (const width of [24, 32]) {
      const lines = renderSidePanel({
        columns: width,
        todos: [
          { id: '1', content: 'A very long todo item that should be truncated or wrapped properly', status: 'in_progress' },
        ],
        workers: [{
          workerId: 'wo_01', shortLabel: 'T1', parentToolId: 'tool_01',
          profile: 'code_scout', authority: 'tianquan', status: 'running',
          panelStatus: 'running', terminal: false,
          activity: 'reading many files in the repository...',
          activityLog: [],
          elapsedMs: 5000,
          toolUseCount: 0,
          tokenCount: 0,
          unread: false,
        }],
        modelName: 'very-long-model-name-that-exceeds-panel',
        currentTool: { name: 'very-long-tool-name', elapsedMs: 1234567 },
        estimatedTokens: 123456789, maxTokens: 999999999,
        cacheHitRate: 0.8555,
        domainGlyph: '❂', domainName: '天枢测试星域',
      }, theme)
      for (const line of lines) {
        const w = displayWidth(line, { ambiguousAsWide: true })
        assert.ok(w <= width, `panel width=${width}: line display-width ${w} must be ≤ ${width}, got: "${stripAnsi(line)}"`)
      }
    }
  })

  it('lines with East-Asian Ambiguous symbols stay within panel width under wide metric', () => {
    // — … · → 等 ambiguous 符号在 CJK 终端按 2 列渲染。narrow(stringWidth) 度量会
    // 低估，让含这些符号的行溢出折行。本测试用 wide 口径断言，确保 formatWorkerRow /
    // truncateStr / formatTaskList 都按 wide 截断，杜绝溢出。
    for (const width of [24, 32]) {
      const lines = renderSidePanel({
        columns: width,
        todos: [
          { id: '1', content: '处理边界——重试→策略·缓存…并发', status: 'in_progress' },
        ],
        workers: [{
          workerId: 'wo_01', shortLabel: 'T1', parentToolId: 'tool_01',
          profile: 'code_scout', authority: 'tianquan', status: 'running',
          panelStatus: 'running', terminal: false,
          activity: '扫描——目录→过滤·结果……',
          activityLog: [],
          elapsedMs: 5000,
          toolUseCount: 0,
          tokenCount: 0,
          unread: false,
        }],
        modelName: '模型—名称…·',
        currentTool: { name: '工具→名称·…', elapsedMs: 1234567 },
        estimatedTokens: 123456789, maxTokens: 999999999,
        cacheHitRate: 0.5,
        domainGlyph: '❂', domainName: '天枢',
      }, theme)
      for (const line of lines) {
        const w = displayWidth(line, { ambiguousAsWide: true })
        assert.ok(w <= width, `ambiguous width=${width}: wide display-width ${w} must be ≤ ${width}, got: "${stripAnsi(line)}"`)
      }
    }
  })

  it('handles empty state gracefully', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: '',
    }, theme)
    assert.ok(lines.length > 0, 'should still render something even with empty model')
    for (const line of lines) {
      assert.ok(!stripAnsi(line).includes('undefined'), 'no undefined in output')
    }
  })

  it('renders active plan section when pointer given', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      activePlan: '<active-plan slug="p1" title="Rewrite ANSI renderer" path=".rivet/plans/p1.md">go</active-plan>',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('Rewrite ANSI renderer'), `plan title: ${all}`)
    assert.ok(all.includes('.rivet/plans/p1.md'), `plan path: ${all}`)
  })

  it('renders plan-mode draft path while drafting', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
      planDraft: { path: '.rivet/plans/draft-99.md', bytes: 420 },
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('起草中'), `drafting label: ${all}`)
    assert.ok(all.includes('draft-99.md'), `draft path: ${all}`)
    assert.ok(all.includes('420b'), `draft bytes: ${all}`)
  })

  it('decodes XML entities in active plan title/path (named + numeric + amp-first ordering)', () => {
    // 覆盖 decodeXmlEntities 三类修复：
    //  - &apos; / &#39; → '  （旧实现未处理，会原样残留）
    //  - &amp;lt; → &lt; （应停在 &lt; 文本，不被二次解成 <；验证 amp-last 顺序）
    //  - &#x27; → '      （十六进制数字实体）
    const lines = renderSidePanel({
      columns: 48,
      todos: [],
      workers: [],
      modelName: 'test',
      activePlan: '<active-plan title="Bob&apos;s &amp;lt;tag&gt; task &#39;A&#x27;s" path="x/y.txt">',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes("Bob's"), `apos decoded: ${all}`)
    // &#39; → ' and &#x27; → ' ; 验证数字实体被解码
    assert.ok(all.includes("'A's"), `&#39; and &#x27; decoded to apostrophe: ${all}`)
    // &amp;lt; 必须解成字面 "&lt;"，不能进一步变成 "<"
    assert.ok(all.includes('&lt;'), `amp-first would corrupt: ${all}`)
    assert.ok(!all.includes(' <tag'), `no double-decode of escaped lt: ${all}`)
  })

  it('renders shortcuts hint', () => {
    const lines = renderSidePanel({
      columns: 32,
      todos: [],
      workers: [],
      modelName: 'test',
    }, theme)
    const all = lines.map(stripAnsi).join(' ')
    assert.ok(all.includes('ctrl+] toggle'), `toggle hint: ${all}`)
    assert.ok(all.includes('ctrl+x r'), `open hint: ${all}`)
  })
})

describe('resolveSidePanelWidth', () => {
  it('uses 32 columns on wide terminals', () => {
    assert.equal(resolveSidePanelWidth(130), 32)
    assert.equal(resolveSidePanelWidth(120), 32)
  })

  it('falls back to 24 columns on medium terminals', () => {
    assert.equal(resolveSidePanelWidth(119), 24)
    assert.equal(resolveSidePanelWidth(100), 24)
  })

  it('returns 0 when terminal is too narrow', () => {
    assert.equal(resolveSidePanelWidth(99), 0)
    assert.equal(resolveSidePanelWidth(80), 0)
  })

  it('exposes a minimum threshold of 100 columns', () => {
    assert.equal(SIDE_PANEL_MIN_COLUMNS, 100)
  })
})
