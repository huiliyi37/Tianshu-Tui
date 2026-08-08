import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractExpressRoutes, extractJsxChildren, stripComments } from '../meridian-framework.js'
import type { MeridianSymbol } from '../meridian-types.js'

function sym(name: string, line: number, kind: MeridianSymbol['kind'] = 'function'): MeridianSymbol {
  return { id: `src/x.ts:${name}:${line}`, name, kind, filePath: 'src/x.ts', line, exported: true, contentHash: 'h' }
}

describe('meridian framework extraction', () => {
  describe('stripComments', () => {
    it('removes line and block comments but keeps strings', () => {
      const src = "// head comment\nrouter.get('/x', h) // trailing\n/* block */ const s = '// not a comment'"
      const out = stripComments(src)
      assert.ok(!out.includes('head comment'))
      assert.ok(!out.includes('trailing'))
      assert.ok(!out.includes('block'))
      assert.ok(out.includes("'// not a comment'"))
    })
  })

  describe('extractExpressRoutes', () => {
    it('produces a route symbol + route_handles edge to a known named handler', () => {
      const source = `import { Router } from 'express'\nconst router = Router()\n// route decl\nrouter.get('/users', listUsers)\nfunction listUsers() {}`
      const known = [sym('listUsers', 5)]
      const { symbols, edges } = extractExpressRoutes('src/routes.ts', source, known)
      const route = symbols.find(s => s.kind === 'route')
      assert.ok(route, 'expected a route symbol')
      assert.equal(route.name, 'GET /users')
      const edge = edges.find(e => e.kind === 'route_handles')
      assert.ok(edge, 'expected a route_handles edge')
      assert.equal(edge.sourceId, route.id)
      assert.equal(edge.targetId, 'src/x.ts:listUsers:5')
      assert.equal(edge.confidence, 'inferred')
    })

    it('skips app.use with non-path first arg (middleware)', () => {
      const source = `app.use(cors())\napp.use('/api', apiRouter)`
      const { symbols } = extractExpressRoutes('src/app.ts', source, [])
      const withMiddleware = symbols.filter(s => s.kind === 'route')
      // only '/api' qualifies; `app.use(cors())` has no quoted path
      assert.equal(withMiddleware.length, 1)
      assert.equal(withMiddleware[0]?.name, 'USE /api')
    })

    it('does not emit route_handles when handler is not a known symbol', () => {
      const source = `router.post('/items', unknownHandler)`
      const { symbols, edges } = extractExpressRoutes('src/r.ts', source, [])
      assert.equal(symbols.filter(s => s.kind === 'route').length, 1)
      assert.equal(edges.filter(e => e.kind === 'route_handles').length, 0)
    })
  })

  describe('extractJsxChildren', () => {
    const fileSymbols = [sym('AppBar', 1, 'function')]

    it('emits jsx_children edge from enclosing component to known child symbol', () => {
      const source = `function AppBar() {\n  return <div><UserCard id={1} /><NavBar/></div>\n}`
      const known = [sym('UserCard', 10), sym('NavBar', 20)]
      const { edges } = extractJsxChildren('src/ui.tsx', source, fileSymbols, known)
      const children = edges.filter(e => e.kind === 'jsx_children')
      assert.equal(children.length, 2)
      for (const e of children) {
        assert.equal(e.sourceId, fileSymbols[0]!.id)
        assert.equal(e.confidence, 'inferred')
      }
      const targetNames = children.map(e => e.targetId).sort()
      assert.deepEqual(targetNames, ['src/x.ts:NavBar:20', 'src/x.ts:UserCard:10'])
    })

    it('does not emit jsx_children for child tags unknown to the repo (anti over-extraction)', () => {
      const source = `function AppBar() {\n  return <div><UnknownThing /></div>\n}`
      const { edges } = extractJsxChildren('src/ui.tsx', source, fileSymbols, [])
      assert.equal(edges.filter(e => e.kind === 'jsx_children').length, 0)
    })

    it('does not treat lowercase html tags as components', () => {
      const source = `function AppBar() {\n  return <div><span>hi</span></div>\n}`
      const { edges } = extractJsxChildren('src/ui.tsx', source, fileSymbols, [sym('span', 99)])
      assert.equal(edges.filter(e => e.kind === 'jsx_children').length, 0)
    })

    it('preserves line numbers across multi-line block comments (MEDIUM-4)', () => {
      const source = 'function a() {}\n/* multi\nline\ncomment */\napp.get("/x", h)\n'
      const { symbols } = extractExpressRoutes('app.ts', source, [sym('h', 5)])
      assert.equal(symbols[0]!.line, 5, 'route line must count original source lines')
    })
  })

  describe('indexFile production-path integration (council 验收：经 indexFile 后 DB 断言边存在)', () => {
    it('persists route_handles edges after indexing an Express sample', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { MeridianIndexer } = await import('../meridian-indexer.js')
      const cwd = mkdtempSync(join(tmpdir(), 'meridian-fw-integ-'))
      const stateDir = mkdtempSync(join(tmpdir(), 'meridian-fw-integ-state-'))
      const indexer = new MeridianIndexer(cwd, stateDir)
      try {
        writeFileSync(join(cwd, 'app.ts'), `
import express from 'express'
const app = express()
function health(_req: unknown, res: { send: (s: string) => void }) { res.send('ok') }
app.get('/health', health)
`)
        await indexer.indexFile('app.ts')
        const symbols = indexer['db'].getSymbolsForFile('app.ts')
        const routes = symbols.filter(s => s.kind === 'route')
        assert.equal(routes.length, 1, 'route symbol must exist in DB after indexFile')
        assert.ok(routes[0]!.name.includes('/health'), `expected /health route, got ${routes[0]!.name}`)
      } finally {
        indexer.close()
        rmSync(cwd, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }
    })

    it('keeps route symbols across invalidateFile hot-update (HIGH-1)', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { MeridianIndexer } = await import('../meridian-indexer.js')
      const cwd = mkdtempSync(join(tmpdir(), 'meridian-fw-hot-'))
      const stateDir = mkdtempSync(join(tmpdir(), 'meridian-fw-hot-state-'))
      const indexer = new MeridianIndexer(cwd, stateDir)
      const appPath = join(cwd, 'app.ts')
      const original = `
import express from 'express'
const app = express()
function health(_req: unknown, res: { send: (s: string) => void }) { res.send('ok') }
app.get('/health', health)
`
      try {
        writeFileSync(appPath, original)
        await indexer.indexFile('app.ts')
        assert.equal(indexer['db'].getSymbolsForFile('app.ts').filter(s => s.kind === 'route').length, 1, 'baseline route exists')
        // Simulate agent edit: same routes, just a trailing comment
        writeFileSync(appPath, original + '\n// edited by agent\n')
        await indexer.invalidateFile('app.ts')
        const after = indexer['db'].getSymbolsForFile('app.ts').filter(s => s.kind === 'route')
        assert.equal(after.length, 1, 'route symbol must survive invalidateFile hot-update')
      } finally {
        indexer.close()
        rmSync(cwd, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }
    })

    it('resolves cross-file route handlers after import expansion (HIGH-2)', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { MeridianIndexer } = await import('../meridian-indexer.js')
      const cwd = mkdtempSync(join(tmpdir(), 'meridian-fw-cross-'))
      const stateDir = mkdtempSync(join(tmpdir(), 'meridian-fw-cross-state-'))
      const indexer = new MeridianIndexer(cwd, stateDir)
      try {
        writeFileSync(join(cwd, 'handler.ts'), 'export function health(_req: unknown, res: { send: (s: string) => void }) { res.send("ok") }\n')
        writeFileSync(join(cwd, 'app.ts'), `
import { health } from './handler.js'
const app = { get: () => {} }
app.get('/health', health)
`)
        await indexer.indexFile('app.ts')
        const routes = indexer['db'].getSymbolsForFile('app.ts').filter(s => s.kind === 'route')
        assert.equal(routes.length, 1, 'route symbol exists')
        const edges = indexer['db'].getEdgesFrom(routes[0]!.id)
        assert.ok(
          edges.some(e => e.kind === 'route_handles' && e.targetId.includes('handler.ts')),
          `cross-file route_handles edge expected, got ${JSON.stringify(edges.map(e => e.kind))}`,
        )
      } finally {
        indexer.close()
        rmSync(cwd, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }
    })

    it('jsx_children sourceId never points into an imported file (MEDIUM-1)', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { MeridianIndexer } = await import('../meridian-indexer.js')
      const cwd = mkdtempSync(join(tmpdir(), 'meridian-fw-jsxsrc-'))
      const stateDir = mkdtempSync(join(tmpdir(), 'meridian-fw-jsxsrc-state-'))
      const indexer = new MeridianIndexer(cwd, stateDir)
      try {
        // helper defines Panel at line 3 — closer to the tag line than app.tsx's
        // own Comp at line 1. A cross-file symbol must never become the
        // enclosing component (its line numbers live in another coordinate system).
        writeFileSync(join(cwd, 'helper.tsx'), '// pad\n// pad\nexport function Panel() { return <div/> }\n')
        writeFileSync(join(cwd, 'app.tsx'), `import { Panel } from './helper.js'\nfunction Comp() {}\n\n\nconst x = <Panel/>\n`)
        await indexer.indexFile('app.tsx')
        const jsxEdges = [
          ...indexer['db'].getSymbolsForFile('app.tsx').flatMap(s => indexer['db'].getEdgesFrom(s.id)),
          ...indexer['db'].getSymbolsForFile('helper.tsx').flatMap(s => indexer['db'].getEdgesFrom(s.id)),
        ].filter(e => e.kind === 'jsx_children')
        assert.ok(jsxEdges.length >= 1, 'jsx_children edge expected')
        for (const e of jsxEdges) {
          assert.ok(!e.sourceId.includes('helper.tsx'), `jsx_children sourceId must stay in current file, got ${e.sourceId}`)
        }
      } finally {
        indexer.close()
        rmSync(cwd, { recursive: true, force: true })
        rmSync(stateDir, { recursive: true, force: true })
      }
    })
  })
})
