import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ForkOptions {
  sourceJsonlPath: string
  targetDir: string
  upToLine?: number
}

export interface ForkResult {
  newSessionId: string
  newJsonlPath: string
}

export function forkSession(options: ForkOptions): ForkResult {
  const newSessionId = randomUUID()
  const newJsonlPath = join(options.targetDir, `${newSessionId}.jsonl`)

  if (options.upToLine === undefined) {
    copyFileSync(options.sourceJsonlPath, newJsonlPath)
  } else {
    const lines = readFileSync(options.sourceJsonlPath, 'utf-8').trim().split('\n')
    writeFileSync(newJsonlPath, lines.slice(0, options.upToLine).join('\n') + '\n')
  }

  return { newSessionId, newJsonlPath }
}
