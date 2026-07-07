import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildVerboseTranscript } from '../transcript-verbose.js'
import { renderPager } from '../format/overlay.js'
import { getTheme } from '../theme.js'
import type { OaiMessage } from '../../api/oai-types.js'

const theme = getTheme()

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
}

describe('buildVerboseTranscript', () => {
  const messages: OaiMessage[] = [
    { role: 'system', content: 'SYSTEM PROMPT SHOULD BE SKIPPED' },
    { role: 'user', content: '帮我看看这个文件' },
    {
      role: 'assistant',
      content: '我来读取。',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'FULL TOOL OUTPUT LINE\n'.repeat(200) },
    { role: 'assistant', content: '读完了。' },
  ]

  it('保留完整工具输出（scrollback 截断的部分在 verbose 层可见）', () => {
    const { content } = buildVerboseTranscript(messages)
    const occurrences = content.split('FULL TOOL OUTPUT LINE').length - 1
    assert.equal(occurrences, 200, 'verbose 层保留全部 200 行工具输出')
  })

  it('跳过 system 消息', () => {
    const { content } = buildVerboseTranscript(messages)
    assert.ok(!content.includes('SYSTEM PROMPT SHOULD BE SKIPPED'))
  })

  it('消息解析：user/tool 标记可被 transcript parser 识别（供 n/N 搜索跳转）', () => {
    const { messages: parsed } = buildVerboseTranscript(messages)
    const roles = parsed.map(m => m.role)
    assert.ok(roles.includes('user'), 'user 消息被识别')
    assert.ok(roles.includes('tool'), 'tool 消息被识别')
  })

  it('极端超大工具输出有护栏截断', () => {
    const huge: OaiMessage[] = [
      { role: 'tool', tool_call_id: 'x', content: 'y'.repeat(500_000) },
    ]
    const { content } = buildVerboseTranscript(huge)
    assert.ok(content.length < 200_000, '100k 护栏生效')
    assert.ok(content.includes('truncated at'), '带截断说明')
  })

  it('空会话返回空内容', () => {
    const { content, messages: parsed } = buildVerboseTranscript([])
    assert.equal(content, '')
    assert.equal(parsed.length, 0)
  })
})

describe('renderPager verbose 层 UI', () => {
  it('verbose 时标题带 [verbose]，footer 提示切回简略', () => {
    const lines = renderPager({ content: 'hello', page: 0, title: 'Transcript', verbose: true }, 80, 20, theme)
    const joined = stripAnsi(lines.join('\n'))
    assert.ok(joined.includes('[verbose]'), `标题带 verbose 标记: ${joined.split('\n')[1]}`)
    assert.ok(joined.includes('简略'), 'footer 提示 v 切回简略')
  })

  it('非 verbose 时 footer 提示 v 进详细', () => {
    const lines = renderPager({ content: 'hello', page: 0, title: 'Scrollback' }, 80, 20, theme)
    const joined = stripAnsi(lines.join('\n'))
    assert.ok(!joined.includes('[verbose]'))
    assert.ok(joined.includes('详细'), 'footer 提示 v 进详细')
  })
})
