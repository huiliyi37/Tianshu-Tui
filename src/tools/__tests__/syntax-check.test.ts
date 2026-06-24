import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { syntaxCheck } from '../syntax-check.js'

describe('syntaxCheck', () => {
  describe('CSS', () => {
    it('passes valid CSS', () => {
      assert.equal(syntaxCheck('/a/style.css', 'body{color:red}'), null)
    })

    it('passes CSS with custom properties', () => {
      assert.equal(syntaxCheck('/a/style.css', ':root{--x:1}@media(max-width:768px){.m{display:none}}'), null)
    })

    it('flags unmatched opening brace', () => {
      const r = syntaxCheck('/a/style.css', 'body{color:red')
      assert.ok(r, 'should detect missing }')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('flags unmatched closing brace', () => {
      const r = syntaxCheck('/a/style.css', 'body{color:red}}')
      assert.ok(r, 'should detect extra }')
      assert.match(r!, /unmatched.*\}/i)
    })

    it('flags the exact broken CSS from our site bug', () => {
      // Missing } to close @media — the actual bug we shipped
      const broken = '@media(max-width:768px){.nav{display:none}\n.nav-mobile a{color:gray}\n\n/* Hero */\n#hero{padding:80px}'
      const r = syntaxCheck('/a/style.css', broken)
      assert.ok(r, 'should detect unmatched { from unclosed @media')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('passes complex valid CSS with multiple @media', () => {
      const css = '.a{color:red}@media(max-width:768px){.b{display:none}}@media(max-width:480px){.c{display:block}}.d{margin:0}'
      assert.equal(syntaxCheck('/a/style.css', css), null)
    })
  })

  describe('HTML', () => {
    it('passes valid HTML', () => {
      const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>T</title></head><body><p>Hello</p></body></html>'
      assert.equal(syntaxCheck('/a/index.html', html), null)
    })

    it('flags missing closing tag', () => {
      const r = syntaxCheck('/a/index.html', '<html><body><div>unclosed')
      assert.ok(r, 'should detect unclosed div')
      assert.match(r!, /unclosed.*<div>/i)
    })

    it('flags extra closing tag', () => {
      const r = syntaxCheck('/a/index.html', '<html><body><div>text</div></div></body></html>')
      assert.ok(r, 'should detect extra </div>')
      assert.match(r!, /unexpected.*<\/div>/i)
    })

    it('does not flag self-closing tags', () => {
      assert.equal(syntaxCheck('/a/index.html', '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><img src="x"><br><hr></body></html>'), null)
    })
  })

  describe('JSON', () => {
    it('passes valid JSON', () => {
      assert.equal(syntaxCheck('/a/data.json', '{"a":1,"b":[2,3]}'), null)
    })

    it('flags invalid JSON', () => {
      const r = syntaxCheck('/a/data.json', '{"a":1,}')
      assert.ok(r, 'should detect trailing comma')
      assert.match(r!, /Invalid JSON/)
    })

    it('flags truncated JSON', () => {
      const r = syntaxCheck('/a/data.json', '{"a":1')
      assert.ok(r, 'should detect unexpected end')
      assert.match(r!, /Invalid JSON/)
    })
  })

  describe('JavaScript', () => {
    it('passes valid JS', () => {
      assert.equal(syntaxCheck('/a/script.js', 'const x = 1;\nconsole.log(x);'), null)
    })

    it('flags JS syntax error', () => {
      const r = syntaxCheck('/a/script.js', 'const x = ;')
      assert.ok(r, 'should detect incomplete expression')
      assert.match(r!, /error/i)
    })

    it('passes JSX', () => {
      assert.equal(syntaxCheck('/a/comp.jsx', 'const el = <div>hi</div>;'), null)
    })
  })

  describe('TypeScript (existing behavior preserved)', () => {
    it('passes valid TS', () => {
      assert.equal(syntaxCheck('/a/file.ts', 'const x: number = 1;'), null)
    })

    it('flags TS error', () => {
      const r = syntaxCheck('/a/file.ts', 'const x: number = ;')
      assert.ok(r, 'should flag syntax error')
    })
  })

  describe('unknown extensions', () => {
    it('returns null for unsupported file types', () => {
      assert.equal(syntaxCheck('/a/file.md', '# Hello'), null)
      assert.equal(syntaxCheck('/a/file.txt', 'hello'), null)
      assert.equal(syntaxCheck('/a/file.py', 'print("hi")'), null)
    })
  })
})
