import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerPrompt } from '../worker-prompts.js'
import { createReadOnlyWorkOrder, createWriteWorkOrder } from '../work-order.js'
import { starDomainRegistry } from '../star-domain-registry.js'

function readOnlyOrder(overrides?: { authority?: string }) {
  return createReadOnlyWorkOrder({
    parentTurnId: 'test-turn',
    kind: 'code_search',
    profile: 'code_scout',
    objective: 'search the codebase',
    scope: {},
    authority: overrides?.authority,
  })
}

function writeOrder(overrides?: { authority?: string }) {
  return createWriteWorkOrder({
    parentTurnId: 'test-turn',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: 'edit the file',
    scope: {},
    authority: overrides?.authority,
  })
}

describe('V3 Component A — authority injection', () => {
  test('buildWorkerPrompt injects domain suffix when order has authority', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order)
    // tianquan's systemPromptSuffix contains '天权'
    assert.match(prompt, /天权/)
    assert.match(prompt, /权域指令/)
  })

  test('buildWorkerPrompt works without authority (backward compat)', () => {
    const order = readOnlyOrder()
    const prompt = buildWorkerPrompt(order)
    assert.doesNotMatch(prompt, /权域指令/)
    assert.doesNotMatch(prompt, /## 你是谁/)
  })

  test('buildWorkerPrompt injects volatileBlock persona ("你是谁") before methodology', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order)
    assert.match(prompt, /## 你是谁/)
    const def = starDomainRegistry.get('tianquan')!
    // The persona text (a slice of volatileBlock) is present
    assert.ok(prompt.includes(def.volatileBlock.slice(0, 20)))
    // Persona ("你是谁") comes before methodology ("权域指令")
    assert.ok(prompt.indexOf('你是谁') < prompt.indexOf('权域指令'))
  })

  test('buildWorkerPrompt explicit authoritySuffix suppresses persona block', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order, 'CUSTOM SUFFIX OVERRIDE')
    assert.doesNotMatch(prompt, /## 你是谁/)
  })

  test('buildWorkerPrompt explicit authoritySuffix overrides order.authority', () => {
    const order = readOnlyOrder({ authority: 'tianquan' })
    const prompt = buildWorkerPrompt(order, 'CUSTOM SUFFIX OVERRIDE')
    assert.match(prompt, /CUSTOM SUFFIX OVERRIDE/)
    // Should NOT contain tianquan's suffix when explicit suffix provided
    assert.doesNotMatch(prompt, /审查者/)
  })

  test('authority on write order injects domain suffix', () => {
    const order = writeOrder({ authority: 'pojun' })
    const prompt = buildWorkerPrompt(order)
    assert.match(prompt, /破军/)
  })

  test('WorkOrder schema preserves authority field', () => {
    const order = readOnlyOrder({ authority: 'tianfu' })
    assert.equal(order.authority, 'tianfu')
  })

  test('WorkOrder without authority has undefined authority', () => {
    const order = readOnlyOrder()
    assert.equal(order.authority, undefined)
  })

  test('toolWhitelist intersection: tianfu read-only keeps read tools', () => {
    const order = readOnlyOrder({ authority: 'tianfu' })
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('grep'))
    assert.ok(order.allowedTools.includes('glob'))
  })

  test('toolWhitelist intersection: pojun read-only keeps exploration tools', () => {
    const order = readOnlyOrder({ authority: 'pojun' })
    // pojun allows read_file, write_file, edit_file, bash, grep, glob, etc.
    assert.ok(order.allowedTools.includes('read_file'))
    assert.ok(order.allowedTools.includes('grep'))
    assert.ok(order.allowedTools.includes('glob'))
  })

  test('toolWhitelist intersection: pojun write keeps write tools', () => {
    const order = writeOrder({ authority: 'pojun' })
    // pojun allows write_file, edit_file, bash
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('bash'))
  })

  test('toolWhitelist intersection: tianfu write keeps write tools (full access)', () => {
    const order = writeOrder({ authority: 'tianfu' })
    assert.ok(order.allowedTools.includes('write_file'))
    assert.ok(order.allowedTools.includes('edit_file'))
    assert.ok(order.allowedTools.includes('bash'))
  })

  test('unknown authority fails closed: no injection and no allowed tools', () => {
    const readOrder = readOnlyOrder({ authority: 'nonexistent_domain' })
    const prompt = buildWorkerPrompt(readOrder)
    assert.doesNotMatch(prompt, /权域指令/)
    assert.deepEqual(readOrder.allowedTools, [])

    const patchOrder = writeOrder({ authority: 'nonexistent_domain' })
    assert.deepEqual(patchOrder.allowedTools, [])
  })

  test('unknown authority logs warning (fail-loud signal)', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    try {
      readOnlyOrder({ authority: 'misspelled_domain' })
      const matched = warnings.some(w => w.includes('Unknown authority "misspelled_domain"'))
      assert.ok(matched, `expected warning about unknown authority, got: ${warnings.join('; ')}`)
    } finally {
      console.warn = origWarn
    }
  })
})
