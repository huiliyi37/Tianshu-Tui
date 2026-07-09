import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { syntaxCheck } from '../syntax-check.js'

describe('syntaxCheck', async () => {
  describe('CSS', async () => {
    it('passes valid CSS', async () => {
      assert.equal(await syntaxCheck('/a/style.css', 'body{color:red}'), null)
    })

    it('passes CSS with custom properties', async () => {
      assert.equal(await syntaxCheck('/a/style.css', ':root{--x:1}@media(max-width:768px){.m{display:none}}'), null)
    })

    it('flags unmatched opening brace', async () => {
      const r = await syntaxCheck('/a/style.css', 'body{color:red')
      assert.ok(r, 'should detect missing }')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('flags unmatched closing brace', async () => {
      const r = await syntaxCheck('/a/style.css', 'body{color:red}}')
      assert.ok(r, 'should detect extra }')
      assert.match(r!, /unmatched.*\}/i)
    })

    it('flags the exact broken CSS from our site bug', async () => {
      // Missing } to close @media — the actual bug we shipped
      const broken = '@media(max-width:768px){.nav{display:none}\n.nav-mobile a{color:gray}\n\n/* Hero */\n#hero{padding:80px}'
      const r = await syntaxCheck('/a/style.css', broken)
      assert.ok(r, 'should detect unmatched { from unclosed @media')
      assert.match(r!, /unmatched.*\{/i)
    })

    it('passes complex valid CSS with multiple @media', async () => {
      const css = '.a{color:red}@media(max-width:768px){.b{display:none}}@media(max-width:480px){.c{display:block}}.d{margin:0}'
      assert.equal(await syntaxCheck('/a/style.css', css), null)
    })
  })

  describe('HTML', async () => {
    it('passes valid HTML', async () => {
      const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="UTF-8"><title>T</title></head><body><p>Hello</p></body></html>'
      assert.equal(await syntaxCheck('/a/index.html', html), null)
    })

    it('flags missing closing tag', async () => {
      const r = await syntaxCheck('/a/index.html', '<html><body><div>unclosed')
      assert.ok(r, 'should detect unclosed div')
      assert.match(r!, /unclosed.*<div>/i)
    })

    it('flags extra closing tag', async () => {
      const r = await syntaxCheck('/a/index.html', '<html><body><div>text</div></div></body></html>')
      assert.ok(r, 'should detect extra </div>')
      assert.match(r!, /unexpected.*<\/div>/i)
    })

    it('does not flag self-closing tags', async () => {
      assert.equal(await syntaxCheck('/a/index.html', '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body><img src="x"><br><hr></body></html>'), null)
    })
  })

  describe('JSON', async () => {
    it('passes valid JSON', async () => {
      assert.equal(await syntaxCheck('/a/data.json', '{"a":1,"b":[2,3]}'), null)
    })

    it('flags invalid JSON', async () => {
      const r = await syntaxCheck('/a/data.json', '{"a":1,}')
      assert.ok(r, 'should detect trailing comma')
      assert.match(r!, /Invalid JSON/)
    })

    it('flags truncated JSON', async () => {
      const r = await syntaxCheck('/a/data.json', '{"a":1')
      assert.ok(r, 'should detect unexpected end')
      assert.match(r!, /Invalid JSON/)
    })
  })

  describe('JavaScript', async () => {
    it('passes valid JS', async () => {
      assert.equal(await syntaxCheck('/a/script.js', 'const x = 1;\nconsole.log(x);'), null)
    })

    it('flags JS syntax error', async () => {
      const r = await syntaxCheck('/a/script.js', 'const x = ;')
      assert.ok(r, 'should detect incomplete expression')
      assert.match(r!, /error/i)
    })

    it('passes JSX', async () => {
      assert.equal(await syntaxCheck('/a/comp.jsx', 'const el = <div>hi</div>;'), null)
    })
  })

  describe('TypeScript (existing behavior preserved)', async () => {
    it('passes valid TS', async () => {
      assert.equal(await syntaxCheck('/a/file.ts', 'const x: number = 1;'), null)
    })

    it('flags TS error', async () => {
      const r = await syntaxCheck('/a/file.ts', 'const x: number = ;')
      assert.ok(r, 'should flag syntax error')
    })
  })

  describe('Python', async () => {
    it('passes valid Python', async () => {
      assert.equal(await syntaxCheck('/a/script.py', 'def foo():\n    return 1\n'), null)
    })

    it('flags Python indentation error', async () => {
      const r = await syntaxCheck('/a/script.py', 'def foo():\n    return 1\n  bad\n')
      assert.ok(r, 'should detect indentation error')
      assert.match(r!, /IndentationError|syntax error/i)
    })

    it('flags invalid Python syntax', async () => {
      const r = await syntaxCheck('/a/script.py', 'def foo(\n')
      assert.ok(r, 'should detect invalid syntax')
      assert.match(r!, /SyntaxError|syntax error/i)
    })

    it('does not produce a false fatal under an aggressive timeout (degrade to OK)', async () => {
      // A 1ms budget almost always trips the hung-interpreter guard before
      // python3 finishes. The guard must degrade to OK (null), never surface a
      // spurious syntax error that would roll back a perfectly valid file.
      const prev = process.env.RIVET_PY_SYNTAX_TIMEOUT
      process.env.RIVET_PY_SYNTAX_TIMEOUT = '1'
      try {
        const r = await syntaxCheck('/a/script.py', 'def foo():\n    return 1\n')
        assert.equal(r, null)
      } finally {
        if (prev === undefined) delete process.env.RIVET_PY_SYNTAX_TIMEOUT
        else process.env.RIVET_PY_SYNTAX_TIMEOUT = prev
      }
    })
  })

  describe('unknown extensions', async () => {
    it('returns null for unsupported file types', async () => {
      assert.equal(await syntaxCheck('/a/file.md', '# Hello'), null)
      assert.equal(await syntaxCheck('/a/file.txt', 'hello'), null)
    })
  })
})
