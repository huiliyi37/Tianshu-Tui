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

  test('toolWhitelist intersection: tianfu read-only has no write tools', () => {
    const order = readOnlyOrder({ authority: 'tianfu' })
    // tianfu's toolWhitelist is read-only: no write_file, edit_file, bash
    assert.ok(!order.allowedTools.includes('write_file'))
    assert.ok(!order.allowedTools.includes('edit_file'))
    assert.ok(!order.allowedTools.includes('bash'))
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

  test('toolWhitelist intersection: tianfu write gets empty tools (strict)', () => {
    const order = writeOrder({ authority: 'tianfu' })
    // tianfu's whitelist has no write tools → intersection is empty
    // This is correct: tianfu shouldn't be doing writes
    assert.ok(!order.allowedTools.includes('write_file'))
    assert.ok(!order.allowedTools.includes('bash'))
  })

  test('unknown authority fails closed: no injection and no allowed tools', () => {
    const readOrder = readOnlyOrder({ authority: 'nonexistent_domain' })
    const prompt = buildWorkerPrompt(readOrder)
    assert.doesNotMatch(prompt, /权域指令/)
    assert.deepEqual(readOrder.allowedTools, [])

    const patchOrder = writeOrder({ authority: 'nonexistent_domain' })
    assert.deepEqual(patchOrder.allowedTools, [])
  })
})
