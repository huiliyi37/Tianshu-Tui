import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface FailureSampleInput {
  slug: string
  task: string
  model: string
  transcript: string
  expected: string
  actual: string
  rootCause: string
  fix: string
}

function redactSecrets(text: string): string {
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-xxx')
}

function safeSlug(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'failure'
}

export async function createFailureSample(root: string, input: FailureSampleInput): Promise<{ path: string }> {
  const date = new Date().toISOString().slice(0, 10)
  const dir = join(root, `${date}-${safeSlug(input.slug)}`)
  await mkdir(dir, { recursive: true })

  await writeFile(join(dir, 'task.md'), `${input.task}\n`)
  await writeFile(join(dir, 'model.md'), `${input.model}\n`)
  await writeFile(join(dir, 'transcript.redacted.jsonl'), redactSecrets(input.transcript))
  await writeFile(join(dir, 'expected.md'), `${input.expected}\n`)
  await writeFile(join(dir, 'actual.md'), `${input.actual}\n`)
  await writeFile(join(dir, 'root-cause.md'), `${input.rootCause}\n`)
  await writeFile(join(dir, 'fix.md'), `${input.fix}\n`)

  return { path: dir }
}
