import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeBashOutput, summarizeFileContent, summarizeGrepResult } from '../summarize.js'

describe('summarizeFileContent', () => {
  it('extracts TypeScript exports and function signatures', () => {
    const content = `import { foo } from './foo'
import { bar } from './bar'

export function commitAction(params: CommitParams): void {
  // implementation
}

export const MAX_RETRIES = 3

function internalHelper() {
  return true
}

export default class GitTool {
  constructor(private cwd: string) {}
}`

    const result = summarizeFileContent(content, '/src/tools/git.ts')

    assert.ok(result.summary.includes('commitAction'))
    assert.ok(result.summary.includes('MAX_RETRIES'))
    assert.ok(result.summary.includes('GitTool'))
    assert.ok(result.summary.includes('internalHelper'))
    assert.ok(result.sections.some((section) => section.name === 'imports'))
    assert.ok(result.sections.some((section) => section.name === 'export:commitAction'))
  })

  it('handles short files without low-detail fallback', () => {
    const content = 'const x = 1\nexport { x }'
    const result = summarizeFileContent(content, '/src/short.ts')

    assert.ok(result.summary.includes('ts file, 2 lines'))
    assert.ok(result.summary.includes('x'))
    assert.ok(!result.summary.includes('low-detail summary'))
  })

  it('extracts Python classes and functions', () => {
    const content = `import os
from pathlib import Path

class ArtifactStore:
    def __init__(self, root):
        self.root = root

async def load_index(path):
    return path

def summarize_file(content):
    return content[:20]
`

    const result = summarizeFileContent(content, '/agent/artifact.py')

    assert.ok(result.summary.includes('ArtifactStore'))
    assert.ok(result.summary.includes('summarize_file'))
    assert.ok(result.summary.includes('load_index'))
    assert.ok(!result.summary.includes('low-detail summary'))
    assert.ok(result.sections.some((section) => section.name === 'class:ArtifactStore'))
    assert.ok(result.sections.some((section) => section.name === 'function:summarize_file'))
  })

  it('extracts Markdown headings', () => {
    const content = `# Append-Only Artifact Log

Intro

## Task 2
Define types.

## Task 3
Implement store.
`

    const result = summarizeFileContent(content, '/docs/plan.md')

    assert.ok(result.summary.includes('Append-Only Artifact Log'))
    assert.ok(result.summary.includes('Task 2'))
    assert.ok(result.summary.includes('Task 3'))
    assert.ok(!result.summary.includes('low-detail summary'))
    assert.ok(result.sections.some((section) => section.name === 'heading:Task 2'))
  })

  it('extracts JSON top-level keys and nested keys', () => {
    const content = JSON.stringify({
      scripts: { test: 'tsx --test' },
      dependencies: { ink: '^6.0.0' },
      files: ['dist/'],
    }, null, 2)

    const result = summarizeFileContent(content, '/package.json')

    assert.ok(result.summary.includes('scripts'))
    assert.ok(result.summary.includes('dependencies'))
    assert.ok(result.summary.includes('Nested: scripts, dependencies, files'))
    assert.ok(!result.summary.includes('low-detail summary'))
    assert.ok(result.sections.some((section) => section.name === 'key:scripts'))
  })

  it('marks unsupported languages as low-detail and points to read_section', () => {
    const content = `package main

func main() {
  println("hello")
}`

    const result = summarizeFileContent(content, '/cmd/main.go')

    assert.ok(result.summary.includes('go file, 5 lines'))
    assert.ok(result.summary.includes('low-detail summary'))
    assert.ok(result.summary.includes('consider read_section'))
  })
})

describe('summarizeGrepResult', () => {
  it('summarizes match and file counts', () => {
    const result = summarizeGrepResult(
      'src/a.ts:1:ArtifactStore\nsrc/b.ts:2:ArtifactStore\nsrc/a.ts:4:new ArtifactStore',
      'ArtifactStore',
    )

    assert.ok(result.summary.includes('3 matches'))
    assert.ok(result.summary.includes('2 files'))
    assert.ok(result.summary.includes('src/a.ts'))
    assert.ok(result.summary.includes('src/b.ts'))
  })

  it('keeps Windows drive-letter paths whole and tolerates CRLF', () => {
    const result = summarizeGrepResult(
      'C:\\proj\\a.ts:1:Foo\r\nC:\\proj\\b.ts:2:Foo\r\nC:\\proj\\a.ts-3-context',
      'Foo',
    )
    assert.ok(result.summary.includes('3 matches'))
    assert.ok(result.summary.includes('2 files'), `expected 2 files, got: ${result.summary}`)
    assert.ok(result.summary.includes('C:\\proj\\a.ts'))
    assert.ok(result.summary.includes('C:\\proj\\b.ts'))
    // The drive letter must not become its own "file" entry.
    assert.ok(!/Files:[^\n]*\bC\b(?!:)/.test(result.summary), 'drive letter must not be a separate file')
  })
})

describe('summarizeBashOutput', () => {
  it('summarizes successful commands', () => {
    const result = summarizeBashOutput('ok\n2 tests pass', 'npm test', 0)

    assert.ok(result.summary.includes('success'))
    assert.ok(result.summary.includes('2 lines'))
    assert.ok(result.summary.includes('2 tests pass'))
  })

  it('surfaces failure lines for failed commands', () => {
    const result = summarizeBashOutput('compile\nError: bad types\nfailed', 'npx tsc --noEmit', 2)

    assert.ok(result.summary.includes('failed (exit 2)'))
    assert.ok(result.summary.includes('Error: bad types'))
  })
})
