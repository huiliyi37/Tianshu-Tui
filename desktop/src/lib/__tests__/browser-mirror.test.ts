import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveBrowserState, EMPTY_BROWSER_STATE } from '../browser-mirror.ts'
import type { ConvoBlock } from '../../state/event-reducer.ts'

function tool(key: string, text: string): ConvoBlock {
  return { key, kind: 'tool', role: 'tool · browser_debug', text }
}
function result(key: string, text: string): ConvoBlock {
  return { key, kind: 'result', role: 'result · browser_debug', text }
}

test('empty blocks yield the inactive empty state', () => {
  assert.deepEqual(deriveBrowserState([]), EMPTY_BROWSER_STATE)
})

test('ignores non-browser blocks (stays inactive)', () => {
  const blocks: ConvoBlock[] = [
    { key: 'a', kind: 'assistant', text: 'hi' },
    { key: 't', kind: 'tool', role: 'tool · bash', text: 'ls' },
  ]
  assert.equal(deriveBrowserState(blocks).active, false)
})

test('derives current URL and timeline from navigate tool blocks', () => {
  const blocks = [
    tool('tu-1', 'open https://example.com'),
    tool('tu-2', 'navigate https://example.com/docs'),
  ]
  const s = deriveBrowserState(blocks)
  assert.equal(s.active, true)
  assert.equal(s.currentUrl, 'https://example.com/docs')
  assert.equal(s.timeline.length, 2)
  assert.equal(s.timeline[0]!.action, 'open')
  assert.equal(s.timeline[1]!.url, 'https://example.com/docs')
})

test('result "Navigated to" overrides the intent URL (redirect) and strips trailing punctuation', () => {
  const blocks = [
    tool('tu-1', 'navigate https://example.com'),
    result('tr-1', 'Navigated to https://example.com/home. Captured 3 network requests.'),
  ]
  const s = deriveBrowserState(blocks)
  assert.equal(s.currentUrl, 'https://example.com/home')
})

test('extracts the latest screenshot artifact id', () => {
  const blocks = [
    tool('tu-1', 'screenshot'),
    result('tr-1', 'Captured screenshot of https://example.com → artifact shot-abc'),
  ]
  const s = deriveBrowserState(blocks)
  assert.equal(s.latestScreenshotArtifactId, 'shot-abc')
  assert.equal(s.currentUrl, 'https://example.com')
})

test('later screenshot artifact replaces the earlier one', () => {
  const blocks = [
    result('tr-1', 'screenshot → artifact shot-1'),
    result('tr-2', 'screenshot → artifact shot-2'),
  ]
  assert.equal(deriveBrowserState(blocks).latestScreenshotArtifactId, 'shot-2')
})

test('keeps the latest non-screenshot text as extracted text', () => {
  const blocks = [
    tool('tu-1', 'snapshot'),
    result('tr-1', 'Page title: Example\nHeading: Welcome'),
    result('tr-2', 'screenshot → artifact shot-9'),
  ]
  const s = deriveBrowserState(blocks)
  assert.equal(s.latestText, 'Page title: Example\nHeading: Welcome')
  assert.equal(s.latestScreenshotArtifactId, 'shot-9')
})

test('localhost URLs are treated as navigable', () => {
  const s = deriveBrowserState([tool('tu-1', 'open localhost:3000/app')])
  assert.equal(s.currentUrl, 'http://localhost:3000/app')
  assert.equal(s.timeline.length, 1)
  assert.equal(s.timeline[0]!.url, 'http://localhost:3000/app')
})

test('127.0.0.1 URLs receive an implied http:// scheme', () => {
  const s = deriveBrowserState([tool('tu-1', 'navigate 127.0.0.1:8080')])
  assert.equal(s.currentUrl, 'http://127.0.0.1:8080')
})
