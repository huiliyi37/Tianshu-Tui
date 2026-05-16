export interface RingBuffer<T> {
  push(item: T): void
  items(): T[]
  clear(): void
  drain(n: number): T[]
  readonly size: number
}

export function createRingBuffer<T>(cap: number): RingBuffer<T> {
  const buf: T[] = []
  return {
    push(item: T) {
      if (buf.length >= cap) buf.shift()
      buf.push(item)
    },
    items() { return [...buf] },
    clear() { buf.length = 0 },
    drain(n: number): T[] {
      const count = Math.min(n, buf.length)
      return buf.splice(0, count)
    },
    get size() { return buf.length },
  }
}
