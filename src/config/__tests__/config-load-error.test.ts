/**
 * Wave 4 — fail-closed config loading.
 *
 * A broken config file must surface at startup with the file path and exact
 * location; loadConfig is forbidden from silently falling back to defaults.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, ConfigLoadError } from '../manager.js'
import { formatZodPath, formatZodIssues } from '../format-zod-error.js'
import type { ZodIssue } from 'zod'

describe('fail-closed config loading', () => {
  let dir = ''
  let configPath = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-config-load-error-'))
    configPath = join(dir, 'config.json')
    process.env.RIVET_CONFIG_PATH = configPath
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('malformed JSON throws ConfigLoadError with path + line:col + bell, never falls back', () => {
    writeFileSync(configPath, '{\n  "provider": {,}\n}\n')
    assert.throws(
      () => loadConfig(),
      (e: unknown) => {
        assert.ok(e instanceof ConfigLoadError, `expected ConfigLoadError, got ${e}`)
        // Snapshot: bell + path + line:col + explicit refusal to fall back.
        assert.ok(e.message.startsWith(`\u0007配置文件 ${configPath} JSON 解析失败`), e.message)
        assert.match(e.message, /（第 \d+:\d+ 处）/)
        assert.ok(e.message.endsWith('——拒绝回退默认配置，请修正后重试。'), e.message)
        return true
      },
    )
  })

  it('top-level non-object (array) throws ConfigLoadError, never falls back', () => {
    writeFileSync(configPath, '[1, 2, 3]')
    assert.throws(
      () => loadConfig(),
      (e: unknown) => {
        assert.ok(e instanceof ConfigLoadError)
        assert.equal(
          e.message,
          `\u0007配置文件 ${configPath} 顶层必须是 JSON 对象——拒绝回退默认配置，请修正后重试。`,
        )
        return true
      },
    )
  })

  it('schema violation is reported with the formatted zod path, not a generic failure', () => {
    writeFileSync(configPath, JSON.stringify({ provider: { default: 123 } }))
    assert.throws(
      () => loadConfig(),
      (e: unknown) => {
        assert.ok(e instanceof ConfigLoadError)
        assert.ok(e.message.startsWith('rivet 配置校验失败：\n  provider.default: '), e.message)
        assert.ok(e.message.includes(`涉及的配置文件：${configPath}`), e.message)
        return true
      },
    )
  })

  it('a valid config still loads normally (fail-closed is not over-eager)', () => {
    writeFileSync(configPath, JSON.stringify({ provider: { default: 'kimi' } }))
    assert.equal(loadConfig().provider.default, 'kimi')
  })
})

describe('formatZodPath / formatZodIssues', () => {
  it('joins string segments with dots and numeric segments as [i]', () => {
    assert.equal(
      formatZodPath(['provider', 'providers', 'x', 'models', 0, 'contextWindow']),
      'provider.providers.x.models[0].contextWindow',
    )
  })

  it('empty path renders as (root)', () => {
    assert.equal(formatZodPath([]), '(root)')
  })

  it('caps the issue list at 8 and counts the rest', () => {
    const issues = Array.from({ length: 10 }, (_, i) => ({
      code: 'custom',
      path: ['field', i],
      message: `bad ${i}`,
    })) as unknown as ZodIssue[]
    const out = formatZodIssues(issues, 'rivet')
    assert.ok(out.includes('field[7]: bad 7'))
    assert.ok(!out.includes('field[8]'))
    assert.ok(out.endsWith('…（另有 2 处错误未列出）'))
  })
})
