import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_PRESETS, findMcpPreset } from '../../mcp/presets.js'
import { buildMcpRoutes } from '../mcp-api.js'

test('MCP_PRESETS have unique ids', () => {
  const ids = MCP_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('each preset is a well-formed transport config', () => {
  for (const p of MCP_PRESETS) {
    if (p.transport === 'stdio') {
      assert.ok(p.command, `${p.id} stdio preset must have a command`)
      assert.ok(!p.url, `${p.id} stdio preset must not have a url`)
    } else {
      assert.ok(p.url, `${p.id} sse preset must have a url`)
      assert.ok(!p.command, `${p.id} sse preset must not have a command`)
    }
    for (const env of p.requiredEnv ?? []) {
      assert.ok(env.key && env.label, `${p.id} requiredEnv fields need key + label`)
    }
  }
})

test('findMcpPreset resolves by id', () => {
  assert.equal(findMcpPreset('github')?.name, 'GitHub')
  assert.equal(findMcpPreset('nope'), undefined)
})

test('GET /mcp/presets returns presets + configuredIds (auth-gated)', async () => {
  const routes = buildMcpRoutes(() => null, 'secret-token')
  const handler = routes['GET /mcp/presets']!

  const unauthorized = await handler({}, undefined, {}, undefined)
  assert.equal(unauthorized.status, 401)

  const res = await handler({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
  assert.equal(res.status, 200)
  const body = res.body as { presets: unknown[]; configuredIds: unknown }
  assert.ok(Array.isArray(body.presets))
  assert.equal(body.presets.length, MCP_PRESETS.length)
  assert.ok(Array.isArray(body.configuredIds))
})
