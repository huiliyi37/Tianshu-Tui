import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  OutputStreamBudget,
  type OutputStreamScheduler,
} from '../output-stream-budget.js'

class FakeScheduler implements OutputStreamScheduler {
  private nextId = 1
  private tasks = new Map<number, () => void>()

  setTimeout(callback: () => void, _ms: number): number {
    const id = this.nextId++
    this.tasks.set(id, callback)
    return id
  }

  clearTimeout(id: unknown): void {
    this.tasks.delete(id as number)
  }

  runAll(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) task()
  }

  get size(): number {
    return this.tasks.size
  }
}

function makeBudget(overrides: Partial<ConstructorParameters<typeof OutputStreamBudget>[0]> = {}) {
  const emitted: string[] = []
  const scheduler = new FakeScheduler()
  const budget = new OutputStreamBudget({
    emit: (text) => emitted.push(text),
    maxVisible: 64 * 1024,
    scheduler,
    ...overrides,
  })
  return { budget, emitted, scheduler }
}

describe('OutputStreamBudget', () => {
  it('emits the first non-empty chunk immediately and timer-coalesces later chunks', () => {
    const { budget, emitted, scheduler } = makeBudget()
    budget.push('')
    budget.push('a')
    budget.push('b')
    budget.push('c')
    assert.deepEqual(emitted, ['a'])
    scheduler.runAll()
    assert.deepEqual(emitted, ['a', 'bc'])
  })

  it('flushes synchronously when the buffered payload reaches 2KB', () => {
    const { budget, emitted } = makeBudget()
    budget.push('first')
    budget.push('x'.repeat(1024))
    budget.push('y'.repeat(1024))
    assert.deepEqual(emitted, ['first', 'x'.repeat(1024) + 'y'.repeat(1024)])
  })

  it('enforces a UTF-8 byte budget without splitting a code point and marks truncation once', () => {
    const { budget, emitted } = makeBudget({
      maxVisible: 5,
      truncationMarker: '[cut]',
    })
    budget.push('你a')
    budget.push('好b')
    budget.push('ignored')
    budget.flush()
    // Preserve a prefix: do not skip the over-budget 好 just to fill the final
    // byte with a later character, because that would reorder/corrupt output.
    assert.deepEqual(emitted, ['你a', '[cut]'])
    assert.equal(Buffer.byteLength(emitted.filter((x) => x !== '[cut]').join('')), 4)
  })

  it('supports character budgets for legacy run_tests parity', () => {
    const { budget, emitted } = makeBudget({
      maxVisible: 3,
      budgetUnit: 'characters',
      truncationMarker: '[cut]',
    })
    budget.push('你好')
    budget.push('世界')
    budget.flush()
    assert.deepEqual(emitted, ['你好', '世', '[cut]'])
  })

  it('counts UTF-16 units in character mode without splitting astral code points', () => {
    const { budget, emitted } = makeBudget({
      maxVisible: 3,
      budgetUnit: 'characters',
      truncationMarker: '[cut]',
    })
    budget.push('😀ab')
    assert.deepEqual(emitted, ['😀a', '[cut]'])
    assert.equal(emitted[0]!.length, 3)
  })

  it('terminal flush drains buffered output synchronously before the caller result', () => {
    const order: string[] = []
    const scheduler = new FakeScheduler()
    const budget = new OutputStreamBudget({
      emit: (text) => order.push(text),
      maxVisible: 100,
      scheduler,
    })
    budget.push('first')
    budget.push('tail')
    budget.flush()
    order.push('terminal')
    assert.deepEqual(order, ['first', 'tail', 'terminal'])
  })

  it('dispose cancels the timer and prevents buffered or future emissions', () => {
    const { budget, emitted, scheduler } = makeBudget()
    budget.push('first')
    budget.push('buffered')
    assert.equal(scheduler.size, 1)
    budget.dispose()
    assert.equal(scheduler.size, 0)
    scheduler.runAll()
    budget.push('late')
    assert.deepEqual(emitted, ['first'])
  })
})
