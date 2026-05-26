import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamOutput } from '../stream.js'

function innerFn(component: unknown): (props: { text: string; isStreaming: boolean }) => unknown {
  return (component as { type: (props: { text: string; isStreaming: boolean }) => unknown }).type
}

describe('StreamOutput', () => {
  it('renders a waiting indicator when streaming has no visible text', () => {
    const rendered = innerFn(StreamOutput)({ text: '', isStreaming: true }) as any

    assert.ok(rendered)
    assert.equal(rendered.props.children.props.children, '◌ Waiting for model…')
  })

  it('renders nothing when not streaming and no visible text exists', () => {
    const rendered = innerFn(StreamOutput)({ text: '', isStreaming: false })

    assert.equal(rendered, null)
  })

  it('renders a streaming cursor when visible text exists', () => {
    const rendered = innerFn(StreamOutput)({ text: 'hello', isStreaming: true }) as any

    assert.ok(rendered)
    assert.equal(rendered.props.children.props.children[1].props.children.props.children, 'hello▊')
  })
})
