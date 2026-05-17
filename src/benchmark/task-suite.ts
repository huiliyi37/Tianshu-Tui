import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { taskDefinitionSchema } from './types.js'
import type { TaskDefinition } from './types.js'

const suiteFileSchema = z.object({
  tasks: z.array(taskDefinitionSchema),
})

export interface TaskSuite {
  tasks: TaskDefinition[]
}

/**
 * Load and validate a task suite from a JSON file.
 * Throws if the file cannot be read or the schema is invalid.
 */
export function loadTaskSuite(filePath: string): TaskSuite {
  const raw = readFileSync(filePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in task suite file: ${filePath}`)
  }

  const result = suiteFileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid task suite in ${filePath}:\n${issues}`)
  }

  return result.data
}
