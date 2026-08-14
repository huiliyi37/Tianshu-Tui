import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { loadConfig } from '../../config/manager.js'

const TOKEN = 'vision-route-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

let home = ''
let upstream: ReturnType<typeof createServer>
let baseUrl = ''
let completionCount = 0
let completionResponse = 'red square'
let requiredAuthorization: string | undefined

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'rivet-vision-onboarding-routes-'))
  process.env.RIVET_CONFIG_PATH = join(home, 'config.json')
  upstream = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json')
    if (requiredAuthorization && req.headers.authorization !== requiredAuthorization) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: 'Unauthorized upstream request' }))
      return
    }
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'custom-vision-1' }] }))
      return
    }
    completionCount += 1
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const payload = JSON.parse(body) as { messages: Array<{ content: Array<{ type: string }> }> }
    assert.ok(payload.messages[0]?.content.some(part => part.type === 'image_url'))
    res.end(JSON.stringify({ choices: [{ message: { content: completionResponse } }] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
  delete process.env.RIVET_CONFIG_PATH
  await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  rmSync(home, { recursive: true, force: true })
})

test('dedicated vision onboarding routes discover, validate once, and save without changing default', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const unauthorized = await router('POST', '/config/vision-model/discover', { baseUrl }, {})
  assert.equal(unauthorized.status, 401)

  const discovery = await router('POST', '/config/vision-model/discover', { baseUrl }, AUTH)
  assert.equal(discovery.status, 200)
  assert.deepEqual((discovery.body as { candidates: unknown }).candidates, [
    { id: 'custom-vision-1', knownVision: false },
  ])

  const defaultBefore = loadConfig().provider.default
  const onboard = await router('POST', '/config/vision-model/onboard', {
    providerName: 'vision-custom', baseUrl, modelId: 'custom-vision-1', apiKey: 'sk-test',
  }, AUTH)
  assert.equal(onboard.status, 200)
  assert.equal(completionCount, 1)
  const config = loadConfig()
  assert.equal(config.provider.default, defaultBefore)
  assert.deepEqual(config.agent.visionModel, { provider: 'vision-custom', model: 'custom-vision-1', maxTokens: 1024 })
})

test('vision onboarding resolves apiKeyEnv before discovery and image validation', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const envName = 'RIVET_VISION_ONBOARDING_TEST_KEY'
  process.env[envName] = 'env-only-key'
  requiredAuthorization = 'Bearer env-only-key'
  const completionsBefore = completionCount
  try {
    const discovery = await router('POST', '/config/vision-model/discover', {
      baseUrl, apiKeyEnv: envName,
    }, AUTH)
    assert.equal(discovery.status, 200)
    const response = await router('POST', '/config/vision-model/onboard', {
      providerName: 'vision-env', baseUrl, modelId: 'custom-vision-1', apiKeyEnv: envName,
    }, AUTH)

    assert.equal(response.status, 200)
    assert.equal(completionCount, completionsBefore + 1)
    assert.equal(loadConfig().provider.providers['vision-env']?.apiKeyEnv, envName)
  } finally {
    delete process.env[envName]
    requiredAuthorization = undefined
  }
})

test('vision onboarding rejects blank or unavailable credentials without mutation', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const before = JSON.stringify(loadConfig())
  for (const body of [
    { baseUrl, apiKey: '   ' },
    { baseUrl, apiKeyEnv: '   ' },
    { baseUrl, apiKeyEnv: 'NOT-A-VALID-NAME' },
    { baseUrl, apiKeyEnv: 'RIVET_MISSING_VISION_KEY' },
  ]) {
    const response = await router('POST', '/config/vision-model/discover', body, AUTH)
    assert.equal(response.status, 400)
  }
  assert.equal(JSON.stringify(loadConfig()), before)
})

test('vision onboarding cannot overwrite the default provider', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const before = loadConfig()
  const providerName = before.provider.default
  const providerBefore = JSON.stringify(before.provider.providers[providerName])
  const visionBefore = JSON.stringify(before.agent.visionModel)
  const response = await router('POST', '/config/vision-model/onboard', {
    providerName, baseUrl, modelId: 'custom-vision-1', apiKey: 'sk-test',
  }, AUTH)

  assert.equal(response.status, 400)
  const after = loadConfig()
  assert.equal(JSON.stringify(after.provider.providers[providerName]), providerBefore)
  assert.equal(JSON.stringify(after.agent.visionModel), visionBefore)
})

test('vision onboarding rejects unlisted model IDs before completion or config mutation', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const before = JSON.stringify(loadConfig())
  const completionsBefore = completionCount
  const response = await router('POST', '/config/vision-model/onboard', {
    providerName: 'vision-rejected', baseUrl, modelId: 'not-returned', apiKey: 'sk-test',
  }, AUTH)

  assert.equal(response.status, 400)
  assert.equal(completionCount, completionsBefore)
  assert.equal(JSON.stringify(loadConfig()), before)
})

test('vision onboarding keeps existing config when validation returns empty content', async () => {
  const router = createRouter(buildConfigRoutes(TOKEN))
  const before = JSON.stringify(loadConfig())
  const completionsBefore = completionCount
  completionResponse = ' '
  try {
    const response = await router('POST', '/config/vision-model/onboard', {
      providerName: 'vision-empty', baseUrl, modelId: 'custom-vision-1', apiKey: 'sk-test',
    }, AUTH)

    assert.equal(response.status, 400)
    assert.equal(completionCount, completionsBefore + 1)
    assert.equal(JSON.stringify(loadConfig()), before)
  } finally {
    completionResponse = 'red square'
  }
})
