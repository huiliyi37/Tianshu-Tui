import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMentions, renderMentionContext, stripMentions } from '../mention-parser.js'

describe('mention-parser', () => {
  it('parses file folder and symbol mentions', () => {
    const refs = parseMentions('Fix @file:src/a.ts and @symbol:authenticate @folder:src/auth')
    assert.equal(refs.length, 3)
    assert.equal(refs[0]!.type, 'file')
    assert.equal(refs[0]!.value, 'src/a.ts')
  })

  it('parses a quoted path with spaces (Windows)', () => {
    const refs = parseMentions('look at @file:"C:\\Program Files\\app\\main.ts" please')
    assert.equal(refs.length, 1)
    assert.equal(refs[0]!.type, 'file')
    assert.equal(refs[0]!.value, 'C:\\Program Files\\app\\main.ts')
  })

  it('strips mentions from input', () => {
    assert.equal(stripMentions('hello @file:src/a.ts world'), 'hello world')
  })

  it('renders mention context block', () => {
    const block = renderMentionContext(parseMentions('@file:src/x.ts'))
    assert.match(block ?? '', /<mentions>/)
    assert.match(block ?? '', /src\/x.ts/)
  })
})
