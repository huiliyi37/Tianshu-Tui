export interface RingBuffer<T> {
  push(item: T): void
  items(): T[]
  clear(): void
  drain(n: number): T[]
  readonly size: number
}

export function createRingBuffer<T>(cap: number): RingBuffer<T> {
  const buf: T[] = new Array(cap)
  let head = 0
  let count = 0

  return {
    push(item: T) {
      buf[(head + count) % cap] = item
      if (count < cap) count++
      else head = (head + 1) % cap
    },
    items() {
      const result: T[] = new Array(count)
      for (let i = 0; i < count; i++) {
        result[i] = buf[(head + i) % cap]!
      }
      return result
    },
    clear() {
      head = 0
      count = 0
    },
    drain(n: number): T[] {
      const drained = Math.min(n, count)
      const result: T[] = new Array(drained)
      for (let i = 0; i < drained; i++) {
        result[i] = buf[(head + i) % cap]!
      }
      head = (head + drained) % cap
      count -= drained
      return result
    },
    get size() { return count },
  }
}
