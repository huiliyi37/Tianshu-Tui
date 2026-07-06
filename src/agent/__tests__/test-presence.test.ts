import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateTestPresence,
  isSourceFilePath,
  isTestFilePath,
  testPresenceGateEnabled,
} from '../test-presence.js'

test('isTestFilePath: __tests__ 目录与 .test/.spec 后缀', () => {
  assert.equal(isTestFilePath('src/agent/__tests__/loop.test.ts'), true)
  assert.equal(isTestFilePath('src/agent/loop.test.ts'), true)
  assert.equal(isTestFilePath('src/agent/loop.spec.tsx'), true)
  assert.equal(isTestFilePath('plugins/office-pdf/index.test.js'), true)
  assert.equal(isTestFilePath('src\\agent\\__tests__\\loop.test.ts'), true)
  assert.equal(isTestFilePath('src/agent/loop.ts'), false)
  assert.equal(isTestFilePath('src/testing-utils.ts'), false)
})

test('isSourceFilePath: 代码扩展名，排除测试/docs/scripts/配置/声明文件', () => {
  assert.equal(isSourceFilePath('src/agent/loop.ts'), true)
  assert.equal(isSourceFilePath('plugins/office-pdf/index.js'), true)
  assert.equal(isSourceFilePath('desktop/src/App.tsx'), true)
  assert.equal(isSourceFilePath('src/agent/__tests__/loop.test.ts'), false)
  assert.equal(isSourceFilePath('docs/tasks/plan.md'), false)
  assert.equal(isSourceFilePath('docs/example.ts'), false)
  assert.equal(isSourceFilePath('scripts/build.ts'), false)
  assert.equal(isSourceFilePath('package.json'), false)
  assert.equal(isSourceFilePath('README.md'), false)
  assert.equal(isSourceFilePath('vitest.config.ts'), false)
  assert.equal(isSourceFilePath('src/types.d.ts'), false)
})

test('evaluateTestPresence: 源文件达阈值且零测试 → 违规并列出清单', () => {
  const res = evaluateTestPresence([
    'plugins/office-excel/index.js',
    'plugins/office-pdf/index.js',
    'plugins/office-ppt/index.js',
  ])
  assert.equal(res.ok, false)
  assert.equal(res.sourceFiles.length, 3)
  assert.equal(res.testFiles.length, 0)
  assert.ok(res.detail?.includes('plugins/office-excel/index.js'))
  assert.ok(res.detail?.includes('零测试'))
})

test('evaluateTestPresence: 有测试文件 → 放行', () => {
  const res = evaluateTestPresence([
    'src/agent/a.ts',
    'src/agent/b.ts',
    'src/agent/c.ts',
    'src/agent/__tests__/a.test.ts',
  ])
  assert.equal(res.ok, true)
  assert.equal(res.testFiles.length, 1)
})

test('evaluateTestPresence: 源文件低于阈值 → 放行', () => {
  const res = evaluateTestPresence(['src/agent/a.ts', 'src/agent/b.ts'])
  assert.equal(res.ok, true)
})

test('evaluateTestPresence: 纯文档/配置变更 → 放行', () => {
  const res = evaluateTestPresence(['docs/a.md', 'package.json', 'README.md', 'config.yaml'])
  assert.equal(res.ok, true)
  assert.equal(res.sourceFiles.length, 0)
})

test('evaluateTestPresence: 自定义阈值', () => {
  const files = ['src/a.ts', 'src/b.ts']
  assert.equal(evaluateTestPresence(files, 2).ok, false)
  assert.equal(evaluateTestPresence(files, 3).ok, true)
})

test('evaluateTestPresence: 超过 10 个源文件时清单截断', () => {
  const files = Array.from({ length: 12 }, (_, i) => `src/mod${i}.ts`)
  const res = evaluateTestPresence(files)
  assert.equal(res.ok, false)
  assert.ok(res.detail?.includes('(+2 more)'))
})

test('testPresenceGateEnabled: RIVET_TEST_PRESENCE_GATE=0 关闭', () => {
  const prev = process.env.RIVET_TEST_PRESENCE_GATE
  try {
    delete process.env.RIVET_TEST_PRESENCE_GATE
    assert.equal(testPresenceGateEnabled(), true)
    process.env.RIVET_TEST_PRESENCE_GATE = '0'
    assert.equal(testPresenceGateEnabled(), false)
    process.env.RIVET_TEST_PRESENCE_GATE = '1'
    assert.equal(testPresenceGateEnabled(), true)
  } finally {
    if (prev === undefined) delete process.env.RIVET_TEST_PRESENCE_GATE
    else process.env.RIVET_TEST_PRESENCE_GATE = prev
  }
})
