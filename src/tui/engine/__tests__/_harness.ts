/**
 * 共享 TTY 测试夹具 —— T9 ANSI 引擎集成测试统一的 MockOut/MockIn。
 *
 * 历史上 18 个 engine/__tests__/*.test.ts 各自复制同一份 MockOut/MockIn，
 * 此处收敛为单一来源。各测试的 makeApp/stripAnsi 仍可本地保留（尺寸、
 * contextWindow、断言正则等领域差异不收敛进来），仅共享纯 mock 类。
 *
 * 注：非 node:test 文件，命名以 `_` 前缀避免被 `*.test.ts` 测试发现。
 */
import type { ReadStream, WriteStream } from 'node:tty'
import { TuiApp } from '../app.js'

export class MockOut {
  columns: number
  rows: number
  chunks: string[] = []
  constructor(columns = 80, rows = 24) {
    this.columns = columns
    this.rows = rows
  }
  write = (s: string): boolean => {
    this.chunks.push(s)
    return true
  }
  on(): this {
    return this
  }
  removeListener(): this {
    return this
  }
  clear(): void {
    this.chunks = []
  }
}

export class MockIn {
  isTTY = true
  dataHandler: ((d: string) => void) | null = null
  setRawMode(): this {
    return this
  }
  resume(): this {
    return this
  }
  setEncoding(): this {
    return this
  }
  on(ev: string, h: (d: string) => void): this {
    if (ev === 'data') this.dataHandler = h
    return this
  }
  removeAllListeners(): this {
    return this
  }
  pause(): this {
    return this
  }
}

/** 私有序列 `?` 亦纳入剥离（兼容 `[0-9;]` 与 `[0-9;?]` 两种历史写法的超集）。 */
export const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '')

export interface MakeAppOptions {
  cols?: number
  rows?: number
  modelName?: string
  contextWindow?: number
}

/**
 * 统一构造 TuiApp + mock TTY。MockOut 的 columns/rows 与传入 cols/rows 对齐，
 * 复刻历史各文件「类字段尺寸 == 构造尺寸」的约定。
 */
export function makeApp(opts: MakeAppOptions = {}): { app: TuiApp; out: MockOut; stdin: MockIn } {
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  const out = new MockOut(cols, rows)
  const stdin = new MockIn()
  const app = new TuiApp({
    stdout: out as unknown as WriteStream,
    stdin: stdin as unknown as ReadStream,
    cols,
    rows,
    modelName: opts.modelName ?? 'test',
    ...(opts.contextWindow != null ? { contextWindow: opts.contextWindow } : {}),
  })
  return { app, out, stdin }
}
