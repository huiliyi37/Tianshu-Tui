export interface SplitInput {
  targetFiles: string[]
  estimatedTurns: number
  hasTests: boolean
}

export interface SplitWorker {
  files: string[]
  module: string
}

export interface SplitResult {
  split: boolean
  reason?: string
  workers: SplitWorker[]
}

function extractModule(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length >= 3 ? parts[1]! : parts[0]!
}

const MIN_TURNS_FOR_SPLIT = 5
const MIN_MODULES_FOR_SPLIT = 3

export function shouldSplit(input: SplitInput): SplitResult {
  if (input.estimatedTurns < MIN_TURNS_FOR_SPLIT) {
    return { split: false, workers: [] }
  }

  const moduleMap = new Map<string, string[]>()
  for (const f of input.targetFiles) {
    const mod = extractModule(f)
    const files = moduleMap.get(mod) ?? []
    files.push(f)
    moduleMap.set(mod, files)
  }

  if (moduleMap.size < MIN_MODULES_FOR_SPLIT) {
    return { split: false, workers: [] }
  }

  const workers: SplitWorker[] = [...moduleMap.entries()].map(([module, files]) => ({
    module,
    files,
  }))

  return {
    split: true,
    reason: `${moduleMap.size} independent modules detected`,
    workers,
  }
}
