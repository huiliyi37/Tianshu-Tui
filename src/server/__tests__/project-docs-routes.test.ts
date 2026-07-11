import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildProjectDocsRoutes } from '../project-docs-routes.js'

const TOKEN = 'project-docs-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('/project-docs routes', () => {
  let cwd: string
  const prevHome = process.env.RIVET_HOME

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'rivet-project-docs-'))
    process.env.RIVET_HOME = cwd
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(cwd, { recursive: true, force: true })
  })

  it('GET returns empty docs when files do not exist', async () => {
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const res = await router('GET', `/project-docs?cwd=${encodeURIComponent(cwd)}`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { cwd: string; agentsMd: string; rivetMd: string; agentsExists: boolean; rivetExists: boolean }
    assert.equal(body.cwd, cwd)
    assert.equal(body.agentsMd, '')
    assert.equal(body.rivetMd, '')
    assert.equal(body.agentsExists, false)
    assert.equal(body.rivetExists, false)
  })

  it('GET reads existing AGENTS.md and .rivet.md', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# agent rules', 'utf-8')
    writeFileSync(join(cwd, '.rivet.md'), '# project', 'utf-8')
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const res = await router('GET', `/project-docs?cwd=${encodeURIComponent(cwd)}`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { agentsMd: string; rivetMd: string; agentsExists: boolean; rivetExists: boolean }
    assert.equal(body.agentsMd, '# agent rules')
    assert.equal(body.rivetMd, '# project')
    assert.equal(body.agentsExists, true)
    assert.equal(body.rivetExists, true)
  })

  it('PUT writes both files and returns the updated state', async () => {
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const res = await router('PUT', '/project-docs', {
      cwd,
      agentsMd: '## agent updates',
      rivetMd: '## project updates',
    }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { agentsMd: string; rivetMd: string; agentsExists: boolean; rivetExists: boolean }
    assert.equal(body.agentsMd, '## agent updates')
    assert.equal(body.rivetMd, '## project updates')
    assert.equal(body.agentsExists, true)
    assert.equal(body.rivetExists, true)
    assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8'), '## agent updates')
    assert.equal(readFileSync(join(cwd, '.rivet.md'), 'utf-8'), '## project updates')
  })

  it('PUT supports partial updates', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), 'keep', 'utf-8')
    writeFileSync(join(cwd, '.rivet.md'), 'keep', 'utf-8')
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const res = await router('PUT', '/project-docs', { cwd, rivetMd: 'only rivet' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { agentsMd: string; rivetMd: string }
    assert.equal(body.agentsMd, 'keep')
    assert.equal(body.rivetMd, 'only rivet')
    assert.equal(readFileSync(join(cwd, 'AGENTS.md'), 'utf-8'), 'keep')
    assert.equal(readFileSync(join(cwd, '.rivet.md'), 'utf-8'), 'only rivet')
  })

  it('rejects PUT without cwd or doc fields', async () => {
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const noCwd = await router('PUT', '/project-docs', { agentsMd: 'x' }, AUTH)
    assert.equal(noCwd.status, 400)
    const noField = await router('PUT', '/project-docs', { cwd }, AUTH)
    assert.equal(noField.status, 400)
  })

  it('returns 500 when cwd does not exist on PUT', async () => {
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const missing = join(cwd, 'missing-project')
    const res = await router('PUT', '/project-docs', { cwd: missing, agentsMd: 'x' }, AUTH)
    assert.equal(res.status, 500)
  })

  it('rejects unauthorized requests', async () => {
    const router = createRouter(buildProjectDocsRoutes(TOKEN))
    const getRes = await router('GET', `/project-docs?cwd=${encodeURIComponent(cwd)}`, {}, {})
    assert.equal(getRes.status, 401)
    const putRes = await router('PUT', '/project-docs', { cwd, agentsMd: 'x' }, {})
    assert.equal(putRes.status, 401)
  })
})
