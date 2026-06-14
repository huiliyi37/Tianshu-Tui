import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(__dirname, '../app.tsx'), 'utf-8')

function extractBlock(label: string): string {
  const idx = appSource.indexOf(label)
  assert.ok(idx >= 0, `app.tsx must contain the label "${label}"`)
  const slice = appSource.slice(idx, idx + 1500)
  return slice
}

describe('pendingIntent card: minimal inline source contract', () => {
  const block = extractBlock('pendingIntent && (')
  const jsx = block.slice(block.indexOf('<Box'))

  it('renders without border (minimal style)', () => {
    assert.ok(
      !jsx.includes('borderStyle='),
      'pendingIntent must not use borders (minimal design)',
    )
  })

  it('uses theme.primary for the intent content', () => {
    assert.ok(
      /theme\.primary/.test(jsx),
      'pendingIntent must reference theme.primary',
    )
  })
})

describe('pendingApproval card: minimal inline source contract', () => {
  const block = extractBlock('pendingApproval && (')
  const jsx = block.slice(block.indexOf('<Box'))

  it('renders without border (minimal style)', () => {
    assert.ok(
      !jsx.includes('borderStyle='),
      'pendingApproval must not use borders (minimal design)',
    )
  })

  it('uses theme.warning for tool name', () => {
    assert.ok(
      /theme\.warning/.test(jsx),
      'pendingApproval must reference theme.warning for the tool name',
    )
  })

  it('highlights the y/n keys in semantic colors', () => {
    assert.ok(
      /theme\.(success|primary|warning)\}[\s\S]{0,200}\[y\]/.test(jsx) || /theme\.(success|primary|warning)\}[\s\S]{0,200}y/.test(jsx),
      '[y] key must use a semantic theme color',
    )
    assert.ok(
      /theme\.(error|dim|warning)\}[\s\S]{0,200}\[n\]/.test(jsx) || /theme\.(error|dim|warning)\}[\s\S]{0,200}n/.test(jsx),
      '[n] key must use a semantic theme color',
    )
  })
})
