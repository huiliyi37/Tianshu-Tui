export interface RingBuffer<T> {
  push(item: T): void
  items(): T[]
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
    get size() { return buf.length },
  }
}
