import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { syntaxCheck } from '../syntax-check.js'

describe('syntaxCheck', () => {
  it('returns null for valid .ts content', () => {
    const result = syntaxCheck('/project/src/foo.ts', 'const x: number = 1\nexport { x }\n')
    assert.equal(result, null)
  })

  it('returns null for valid .tsx content', () => {
    const result = syntaxCheck('/project/src/App.tsx', 'export const App = () => <div>hi</div>\n')
    assert.equal(result, null)
  })

  it('returns null for non-ts files (.js, .json, .md)', () => {
    assert.equal(syntaxCheck('/project/src/foo.js', 'const x = }'), null)
    assert.equal(syntaxCheck('/project/src/foo.json', '{bad}'), null)
    assert.equal(syntaxCheck('/project/README.md', '# broken {{{'), null)
  })

  it('returns warning string for .ts with syntax error', () => {
    const result = syntaxCheck('/project/src/foo.ts', 'const x: number =\nexport { x }\n')
    assert.notEqual(result, null)
    assert.ok(result!.includes('Syntax error'))
    assert.ok(result!.includes('ERROR') || result!.includes('error'))
  })

  it('returns warning for .tsx with broken JSX', () => {
    const result = syntaxCheck('/project/src/Broken.tsx', 'export const X = () => <div><span></div>\n')
    assert.notEqual(result, null)
    assert.ok(result!.includes('Syntax error'))
  })

  it('includes the error location in the message', () => {
    const result = syntaxCheck('/project/src/foo.ts', 'const x = 1\n}\n')
    assert.notEqual(result, null)
    // Should mention a line number or "Unexpected"
    assert.ok(result!.length > 20, `Expected meaningful error message, got: ${result}`)
  })
})
