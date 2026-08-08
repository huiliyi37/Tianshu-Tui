import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  SEED_REGISTRY,
  PROJECT_REGISTRY_PATH,
  loadProjectRegistry,
  mergeRegistries,
  preflightCapability,
  checkProviderRequirements,
  createCapabilityTool,
  parseRegistry,
  type CapabilityRegistry,
  type Checkers,
} from '../capability-index.js'

const noop: Checkers = {
  binary: () => false,
  env: () => false,
  package: () => false,
}

function tmpCwd(): string {
  return mkdtempSync(join(tmpdir(), 'capability-index-'))
}

test('seed registry 覆盖 6 个常用 dev CLI', () => {
  const ids = SEED_REGISTRY.capabilities.map((c) => c.id)
  for (const want of ['media-transcode', 'image-processing', 'document-conversion', 'json-processing', 'github-ops', 'code-search']) {
    assert.ok(ids.includes(want), `missing seed capability: ${want}`)
  }
  assert.equal(SEED_REGISTRY.schemaVersion, '2')
})

test('preflight 命中：所有依赖可用 → available', () => {
  const all = { binary: () => true, env: () => true, package: () => true }
  const r = preflightCapability(SEED_REGISTRY, 'json-processing', all)!
  assert.ok(r)
  assert.equal(r.summary.providers, 1)
  assert.equal(r.summary.available, 1)
  assert.equal(r.summary.missing, 0)
  assert.equal(r.providers[0]!.available, true)
  assert.deepEqual(r.providers[0]!.missing, { binary: [], env: [], package: [] })
})

test('preflight 缺口：依赖缺失 → missing + installHint', () => {
  const r = preflightCapability(SEED_REGISTRY, 'document-conversion', noop)!
  assert.ok(r)
  assert.equal(r.summary.available, 0)
  assert.equal(r.summary.missing, 1)
  assert.equal(r.providers[0]!.available, false)
  assert.deepEqual(r.providers[0]!.missing, { binary: ['pandoc'], env: [], package: [] })
  assert.equal(r.providers[0]!.installHint, 'brew install pandoc')
})

test('preflight env 依赖：GITHUB_TOKEN 缺席计入 missing', () => {
  const r = preflightCapability(SEED_REGISTRY, 'github-ops', { binary: () => true, env: () => false })!
  assert.equal(r.providers[0]!.available, false)
  assert.deepEqual(r.providers[0]!.missing.env, ['GITHUB_TOKEN'])
  assert.deepEqual(r.providers[0]!.present.binary, ['gh'])
})

test('preflight 未找到 capability → null', () => {
  assert.equal(preflightCapability(SEED_REGISTRY, 'no-such-cap', noop), null)
})

test('checkProviderRequirements 逐类检查 binary/env/package', () => {
  const p = {
    kind: 'public-cli',
    name: 'multi',
    requires: { binary: ['a', 'b'], env: ['E1'], package: ['pkg-x'] },
    installHint: 'install multi',
  }
  const r = checkProviderRequirements(p, {
    binary: (n) => n === 'a',
    env: () => true,
    package: (n) => n === 'pkg-x',
  })
  assert.equal(r.available, false)
  assert.deepEqual(r.present.binary, ['a'])
  assert.deepEqual(r.missing.binary, ['b'])
  assert.equal(r.installHint, 'install multi')
})

test('registry 合并：项目级新增条目 + 覆盖同 id，种子不删', () => {
  const project = {
    schemaVersion: '2',
    capabilities: [
      { id: 'doc-convert', intent: '项目自定义能力', providers: [{ kind: 'public-cli', name: 'custom-tool', requires: { binary: ['custom-tool'] } }] },
      { id: 'json-processing', intent: '覆盖后的意图', providers: [{ kind: 'public-cli', name: 'jq', requires: { binary: ['jq'] } }] },
    ],
  }
  const merged = mergeRegistries(SEED_REGISTRY, project)
  assert.ok(merged.capabilities.find((c) => c.id === 'doc-convert'), '项目新增应保留')
  assert.ok(merged.capabilities.find((c) => c.id === 'media-transcode'), '种子条目不应被删除')
  const overridden = merged.capabilities.find((c) => c.id === 'json-processing')!
  assert.equal(overridden.intent, '覆盖后的意图')
})

test('项目级 .rivet/capabilities.json 可被加载并合并', () => {
  const cwd = tmpCwd()
  try {
    mkdirSync(join(cwd, '.rivet'), { recursive: true })
    writeFileSync(
      join(cwd, PROJECT_REGISTRY_PATH),
      JSON.stringify({
        capabilities: [
          { id: 'proj-cap', intent: '项目能力', providers: [{ kind: 'public-cli', name: 'proj', requires: { binary: ['proj'] }, installHint: 'install proj' }] },
        ],
      }),
    )
    const loaded = loadProjectRegistry(cwd)!
    assert.ok(loaded)
    assert.equal(loaded.capabilities[0]!.id, 'proj-cap')
    assert.equal(loaded.capabilities[0]!.providers[0]!.installHint, 'install proj')
    // mergeRegistries + loadProjectRegistry 组合（工具默认 loader 路径）
    const merged = mergeRegistries(SEED_REGISTRY, loaded)
    assert.equal(merged.capabilities.length, SEED_REGISTRY.capabilities.length + 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('缺失的项目级文件 → loadProjectRegistry 返回 null', () => {
  const cwd = tmpCwd()
  try {
    assert.equal(loadProjectRegistry(cwd), null)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('parseRegistry 容错：非法 provider 跳过、无 providers 的能力过滤', () => {
  const r = parseRegistry({
    capabilities: [
      { id: 'good', intent: '好', providers: [{ name: 'ok' }] },
      { id: 'bad', intent: '坏', providers: [{ kind: 'public-cli' }] }, // 无 name → 跳过
      { id: 'empty', intent: '空', providers: [] }, // 无 providers → 过滤
    ],
  })!
  assert.equal(r.capabilities.length, 1)
  assert.equal(r.capabilities[0]!.id, 'good')
})

test('工具：缺省列出全部能力（只读）', async () => {
  const tool = createCapabilityTool(() => SEED_REGISTRY)
  const result = await tool.execute({ input: {}, toolUseId: 't', cwd: '/' })
  assert.equal(result.isError, undefined)
  assert.ok(result.content.includes('media-transcode'))
  assert.ok(result.content.includes('code-search'))
})

test('工具：传 capabilityId 做 preflight', async () => {
  const tool = createCapabilityTool(() => SEED_REGISTRY)
  const result = await tool.execute({ input: { capabilityId: 'document-conversion' }, toolUseId: 't', cwd: '/' })
  assert.ok(result.content.includes('pandoc'))
  assert.ok(result.content.includes('brew install pandoc'))
})

test('工具：未知 capability → isError', async () => {
  const tool = createCapabilityTool(() => SEED_REGISTRY)
  const result = await tool.execute({ input: { capabilityId: 'nope' }, toolUseId: 't', cwd: '/' })
  assert.equal(result.isError, true)
})

test('registry 合并：覆盖同 id 时 providers 被整体替换而非合并', () => {
  const project = {
    capabilities: [
      {
        id: 'json-processing',
        intent: '项目覆盖',
        providers: [{ kind: 'public-cli', name: 'project-jq', requires: { binary: ['pjq'] } }],
      },
    ],
  }
  const merged = mergeRegistries(SEED_REGISTRY, project)
  const overridden = merged.capabilities.find((c) => c.id === 'json-processing')!
  assert.deepEqual(overridden.providers.map((p) => p.name), ['project-jq'])
  assert.equal(overridden.providers[0]!.installHint, undefined)
})

test('registry 合并：project 为 null → 原样返回 seed', () => {
  const merged = mergeRegistries(SEED_REGISTRY, null)
  assert.equal(merged.capabilities.length, SEED_REGISTRY.capabilities.length)
  assert.equal(merged.schemaVersion, SEED_REGISTRY.schemaVersion)
})

test('registry 合并：schemaVersion 取 project 优先、缺席回退 seed', () => {
  const withVersion = mergeRegistries(SEED_REGISTRY, { schemaVersion: '9', capabilities: [] })
  assert.equal(withVersion.schemaVersion, '9')
  const withoutVersion = mergeRegistries(SEED_REGISTRY, { capabilities: [] })
  assert.equal(withoutVersion.schemaVersion, SEED_REGISTRY.schemaVersion)
})

test('preflight 多 provider 能力：summary 按 provider 计数', () => {
  const registry: CapabilityRegistry = {
    schemaVersion: '2',
    capabilities: [
      {
        id: 'multi',
        intent: '多 provider 能力',
        providers: [
          { kind: 'public-cli', name: 'a', requires: { binary: ['a'] } },
          { kind: 'public-cli', name: 'b', requires: { binary: ['b'] } },
        ],
      },
    ],
  }
  const r = preflightCapability(registry, 'multi', { binary: (n) => n === 'a' })!
  assert.equal(r.summary.providers, 2)
  assert.equal(r.summary.available, 1)
  assert.equal(r.summary.missing, 1)
  assert.deepEqual(r.providers.map((p) => p.available), [true, false])
})
