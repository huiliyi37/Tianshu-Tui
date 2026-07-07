import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { hyperlink, fileLink, setHyperlinksEnabled, detectHyperlinkSupport } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { formatMarkdown } from '../format/markdown.js'
import { formatDiff } from '../format/diff.js'
import { getTheme } from '../theme.js'

const theme = getTheme()

afterEach(() => setHyperlinksEnabled(null))

describe('hyperlink (OSC 8)', () => {
  it('支持时输出 OSC 8 包裹序列', () => {
    setHyperlinksEnabled(true)
    const out = hyperlink('click me', 'https://example.com')
    assert.equal(out, '\x1B]8;;https://example.com\x07click me\x1B]8;;\x07')
  })

  it('不支持时纯文本降级（零污染）', () => {
    setHyperlinksEnabled(false)
    assert.equal(hyperlink('click me', 'https://example.com'), 'click me')
    assert.equal(fileLink('a.ts', '/x/a.ts'), 'a.ts')
  })

  it('URL 中控制字符被剥离（OSC 注入防护）', () => {
    setHyperlinksEnabled(true)
    const out = hyperlink('t', 'https://e.com/\x07\x1B]evil')
    assert.ok(!out.includes('\x07\x1B]evil'))
    assert.ok(out.includes('https://e.com/]evil'))
  })

  it('fileLink 相对路径归一为 file:// 绝对路径', () => {
    setHyperlinksEnabled(true)
    const out = fileLink('a.ts', 'src/a.ts', '/proj')
    assert.ok(out.includes('file:///proj/src/a.ts'))
    const abs = fileLink('a.ts', '/proj/src/a.ts', '/ignored')
    assert.ok(abs.includes('file:///proj/src/a.ts'))
  })

  it('detectHyperlinkSupport：环境开关与终端识别', () => {
    assert.equal(detectHyperlinkSupport({ RIVET_HYPERLINKS: '0', TERM_PROGRAM: 'iTerm.app' }), false)
    assert.equal(detectHyperlinkSupport({ RIVET_HYPERLINKS: '1', TERM: 'dumb' }), true)
    assert.equal(detectHyperlinkSupport({ TERM: 'dumb' }), false)
    assert.equal(detectHyperlinkSupport({ TERM: 'xterm-256color', TMUX: '/tmp/tmux-1' }), false)
  })
})

describe('width 口径：OSC 8 序列不计宽', () => {
  it('displayWidth 忽略 OSC 8 序列', () => {
    setHyperlinksEnabled(true)
    const linked = hyperlink('abc', 'https://very-long-url.example.com/path/to/thing')
    assert.equal(displayWidth(linked), 3)
  })

  it('truncateToDisplayWidth 截断链接文本时补 OSC 8 闭合', () => {
    setHyperlinksEnabled(true)
    const linked = hyperlink('abcdefgh', 'https://e.com') + ' tail'
    const out = truncateToDisplayWidth(linked, 4)
    assert.equal(displayWidth(out), 4)
    // 开链接后被截断 → 必须补 \x1B]8;;\x07 闭合，防止链接吞掉后续输出
    const opens = (out.match(/\x1B\]8;;https/g) ?? []).length
    const closes = (out.match(/\x1B\]8;;\x07/g) ?? []).length
    assert.ok(closes >= opens, `每个 OSC 8 开必须有闭: opens=${opens} closes=${closes}`)
  })
})

describe('消费点接线', () => {
  it('markdown [text](url) 渲染为 OSC 8 链接', () => {
    setHyperlinksEnabled(true)
    const lines = formatMarkdown({ text: 'see [docs](https://example.com/docs) here', columns: 80 }, theme)
    const joined = lines.join('\n')
    assert.ok(joined.includes('\x1B]8;;https://example.com/docs\x07'), `含 OSC 8 开: ${JSON.stringify(joined)}`)
    assert.ok(joined.includes('docs'))
  })

  it('markdown 链接在不支持终端只保留下划线文本', () => {
    setHyperlinksEnabled(false)
    const lines = formatMarkdown({ text: '[docs](https://example.com)', columns: 80 }, theme)
    const joined = lines.join('\n')
    assert.ok(!joined.includes('\x1B]8;;'))
    assert.ok(joined.includes('docs'))
    assert.ok(!joined.includes('https://example.com'), 'URL 本体不显示')
  })

  it('diff 文件头 (+++/---) 渲染为 file:// 链接', () => {
    setHyperlinksEnabled(true)
    const content = ['--- a/src/foo.ts', '+++ b/src/foo.ts', '@@ -1,2 +1,2 @@', ' ctx', '-old', '+new'].join('\n')
    const lines = formatDiff({ content }, theme)
    const joined = lines.join('\n')
    assert.ok(joined.includes(']8;;file://'), `diff 头带 file 链接`)
    assert.ok(joined.includes('src/foo.ts'))
  })

  it('diff /dev/null 头不生成链接', () => {
    setHyperlinksEnabled(true)
    const content = ['--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1 @@', '+x'].join('\n')
    const lines = formatDiff({ content }, theme)
    const devNullLine = lines.find(l => l.includes('/dev/null'))!
    assert.ok(!devNullLine.includes(']8;;'))
  })
})
