import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const ARTIFACT_MARKER_REGEX = /\[artifact:([A-Za-z0-9_-]+)]\s*$/

function buildBashStyleOutput(modelOutput: string, artifactId: string): string {
  return `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`
}

function buildGrepStyleOutput(truncated: string, summary: string, artifactId: string): string {
  return `${truncated}\n\n${summary}\nUse read_section(artifactId="${artifactId}", section="L1-L500") for the full match list.\n[artifact:${artifactId}]`
}

function buildReadFileStyleOutput(modelContent: string, summary: string, artifactId: string): string {
  return `${modelContent}\n\n── Structural outline ──\n${summary}\n[artifact:${artifactId}]`
}

describe('artifact marker format consistency', () => {
  it('bash-style output: [artifact:X] is at end and regex matches', () => {
    const output = buildBashStyleOutput('file content here', 'abc123')
    const match = output.match(ARTIFACT_MARKER_REGEX)
    assert.ok(match, 'regex must match')
    assert.equal(match[1], 'abc123', 'artifactId must be captured')
  })

  it('grep-style output: [artifact:X] is at end and regex matches', () => {
    const output = buildGrepStyleOutput('line1: match\nline2: match', '2 matches in file.ts', 'def456')
    const match = output.match(ARTIFACT_MARKER_REGEX)
    assert.ok(match, 'regex must match')
    assert.equal(match[1], 'def456', 'artifactId must be captured')
  })

  it('read_file-style output: [artifact:X] is at end and regex matches', () => {
    const output = buildReadFileStyleOutput('import { foo } from "./bar"', '1 import, 1 export', 'ghi789')
    const match = output.match(ARTIFACT_MARKER_REGEX)
    assert.ok(match, 'regex must match')
    assert.equal(match[1], 'ghi789', 'artifactId must be captured')
  })

  it('artifact marker after artifactId is NOT captured (no suffix allowed)', () => {
    // The old broken format — marker is NOT at end
    const broken = `content\n[artifact:abc123] use read_section(artifactId="abc123")`
    assert.equal(broken.match(ARTIFACT_MARKER_REGEX), null, 'broken format must not match')
  })
})
