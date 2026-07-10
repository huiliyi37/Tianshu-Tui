import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseRecording,
  renderEventTimeline,
  buildDistillPrompt,
  RECORDING_SCHEMA_VERSION,
  type RecordingEvent,
} from '../rpa-distill.js'

const HEADER = JSON.stringify({ schema: RECORDING_SCHEMA_VERSION, startedAt: 1770000000000, platform: 'darwin' })

const CLICK = JSON.stringify({
  ts: 1250,
  type: 'click',
  app: 'QQ',
  data: {
    x: 640, y: 410, button: 'left', count: 1,
    element: { role: 'AXTextField', title: '搜索', value: '', ancestors: [{ role: 'AXWindow', title: 'QQ' }] },
  },
})
const TEXT = JSON.stringify({ ts: 3480, type: 'text', app: 'QQ', data: { text: 'TUI', redacted: false } })
const COMBO = JSON.stringify({ ts: 4020, type: 'key_combo', app: 'QQ', data: { combo: 'return' } })
const SWITCH = JSON.stringify({ ts: 5100, type: 'app_switch', app: 'WeChat', data: { from: 'QQ' } })

test('parseRecording 接受合法录制并解析全部事件', () => {
  const parsed = parseRecording([HEADER, CLICK, TEXT, COMBO, SWITCH].join('\n'))
  assert.ok(parsed.ok)
  assert.equal(parsed.events.length, 4)
  assert.equal(parsed.header.platform, 'darwin')
})

test('parseRecording 拒绝 schema 版本不符', () => {
  const badHeader = JSON.stringify({ schema: 'rivet-recording/999' })
  const parsed = parseRecording([badHeader, CLICK].join('\n'))
  assert.ok(!parsed.ok)
  assert.match(parsed.error, /unsupported_schema/)
})

test('parseRecording 拒绝空录制与无事件录制', () => {
  assert.ok(!parseRecording('').ok)
  const onlyHeader = parseRecording(HEADER)
  assert.ok(!onlyHeader.ok)
  assert.equal(onlyHeader.error, 'no_events')
})

test('parseRecording 跳过损坏行而不废整个录制', () => {
  const parsed = parseRecording([HEADER, '{broken json', CLICK].join('\n'))
  assert.ok(parsed.ok)
  assert.equal(parsed.events.length, 1)
})

test('renderEventTimeline 有元素证据时引用 role/title，无证据时标注需推断', () => {
  const events = [JSON.parse(CLICK), JSON.parse(TEXT)] as RecordingEvent[]
  const timeline = renderEventTimeline(events)
  assert.match(timeline, /AXTextField/)
  assert.match(timeline, /「搜索」/)
  assert.match(timeline, /输入文本「TUI」/)

  const bare = renderEventTimeline([
    { ts: 100, type: 'click', app: 'QQ', data: { x: 1, y: 2, button: 'left', count: 1, element: null } },
  ])
  assert.match(bare, /无元素证据/)
})

test('renderEventTimeline 脱敏文本不落原文', () => {
  const timeline = renderEventTimeline([
    { ts: 100, type: 'text', app: 'QQ', data: { text: '[redacted]', redacted: true } },
  ])
  assert.match(timeline, /已脱敏/)
  assert.ok(!timeline.includes('[redacted]'))
})

test('buildDistillPrompt 组装完整蒸馏任务并统计 app', () => {
  const built = buildDistillPrompt({
    recordingId: 'rec-1',
    jsonl: [HEADER, CLICK, TEXT, COMBO, SWITCH].join('\n'),
    workflowPath: '.rivet/recordings/rec-1.workflow.md',
  })
  assert.ok(built.ok)
  assert.equal(built.eventCount, 4)
  assert.deepEqual(built.apps, ['QQ', 'WeChat'])
  // 四节要求 + 交付路径 + 验证步骤要求都要在 prompt 里
  assert.match(built.prompt, /目标/)
  assert.match(built.prompt, /验证步骤/)
  assert.match(built.prompt, /不确定点/)
  assert.match(built.prompt, /\.rivet\/recordings\/rec-1\.workflow\.md/)
  assert.match(built.prompt, /wait_for/)
})

test('buildDistillPrompt 对坏输入返回错误而非抛出', () => {
  const built = buildDistillPrompt({ recordingId: 'x', jsonl: 'not json', workflowPath: 'w.md' })
  assert.ok(!built.ok)
})
