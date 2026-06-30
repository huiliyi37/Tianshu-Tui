import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectMention, applyMention, formatFileMention } from '../mention-input'

test('detectMention: detects @ token after whitespace', () => {
  const text = 'hello @src/fo'
  const t = detectMention(text, text.length)
  assert.ok(t)
  assert.equal(t!.query, 'src/fo')
  assert.equal(t!.start, 6)
  assert.equal(t!.end, text.length)
})

test('detectMention: @ at string start triggers', () => {
  const t = detectMention('@foo', 4)
  assert.ok(t)
  assert.equal(t!.query, 'foo')
  assert.equal(t!.start, 0)
})

test('detectMention: @ glued to a word does not trigger', () => {
  assert.equal(detectMention('a@foo', 5), null)
})

test('detectMention: whitespace after @word ends the token', () => {
  const text = 'hi @a b'
  assert.equal(detectMention(text, text.length), null)
})

test('detectMention: strips a typed file: prefix', () => {
  const text = '@file:src/x'
  const t = detectMention(text, text.length)
  assert.ok(t)
  assert.equal(t!.query, 'src/x')
})

test('applyMention: inserts canonical @file: token with trailing space', () => {
  const text = 'see @sr'
  const t = detectMention(text, text.length)!
  const { text: next, caret } = applyMention(text, t, 'src/foo.ts')
  assert.equal(next, 'see @file:src/foo.ts ')
  assert.equal(caret, next.length)
})

test('applyMention: preserves text after the token', () => {
  const text = '@sr end'
  // caret right after "@sr"
  const t = detectMention(text, 3)!
  const { text: next } = applyMention(text, t, 'a/b.ts')
  assert.equal(next, '@file:a/b.ts  end')
})

test('formatFileMention: quotes paths containing spaces', () => {
  assert.equal(formatFileMention('src/a.ts'), '@file:src/a.ts')
  assert.equal(formatFileMention('C:\\Program Files\\app\\main.ts'), '@file:"C:\\Program Files\\app\\main.ts"')
})

test('applyMention: quotes a spaced path on insert', () => {
  const text = 'see @sr'
  const t = detectMention(text, text.length)!
  const { text: next } = applyMention(text, t, 'C:\\Program Files\\x.ts')
  assert.equal(next, 'see @file:"C:\\Program Files\\x.ts" ')
})
