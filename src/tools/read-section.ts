import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { ArtifactCorruptionError } from '../artifact/store.js'

const MAX_SECTION_CHARS = 8000

/**
 * Parse section ID like "L100-L200" or "100-200" into [start, end] line numbers.
 * Returns null if not a line-range format.
 */
function parseLineRange(sectionId: string): { start: number; end: number } | null {
  const match = sectionId.match(/^L?(\d+)-L?(\d+)$/i)
  if (!match) return null
  const start = parseInt(match[1]!, 10)
  const end = parseInt(match[2]!, 10)
  if (start < 1 || end < start) return null
  return { start, end }
}

/**
 * Parse character range like "c0-c5000" into [start, end] offsets.
 * Returns null if not a char-range format.
 */
function parseCharRange(range: string): { start: number; end: number } | null {
  const match = range.match(/^c(\d+)-c(\d+)$/i)
  if (!match) return null
  const start = parseInt(match[1]!, 10)
  const end = parseInt(match[2]!, 10)
  if (start < 0 || end < start) return null
  return { start, end }
}

/**
 * Extract a section from raw content by line range or char range.
 */
function extractSection(rawContent: string, sectionId: string): string {
  const lineRange = parseLineRange(sectionId)
  if (lineRange) {
    const lines = rawContent.split('\n')
    const startIdx = lineRange.start - 1
    const endIdx = Math.min(lineRange.end, lines.length)
    if (startIdx >= lines.length) {
      return `[Section ${sectionId} out of range — file has ${lines.length} lines]`
    }
    return lines.slice(startIdx, endIdx).join('\n')
  }

  const charRange = parseCharRange(sectionId)
  if (charRange) {
    const start = Math.min(charRange.start, rawContent.length)
    const end = Math.min(charRange.end, rawContent.length)
    return rawContent.slice(start, end)
  }

  return `[Invalid section format: ${sectionId}. Use "L100-L200" for line range or "c0-c5000" for char range]`
}

export const READ_SECTION_TOOL: Tool = {
  definition: {
    name: 'read_section',
    description: `Read a specific section from a previously saved artifact.

### Usage
- Use this to load details from artifact output that was summarized in the message history
- Requires artifactId from a prior tool_result that used artifact storage
- Supports line ranges (L100-L200) and character ranges (c0-c5000)
- Use when the model needs to drill into specific parts of large output

### Examples
Good: read_section(artifactId="abc123", section="L1-L50")
Good: read_section(artifactId="abc123", section="c0-c8000")
Good: read_section(artifactId="abc123", section="L100-L200")`,
    input_schema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          description: 'The artifact ID from a prior tool_result',
        },
        section: {
          type: 'string',
          description: 'Section to read: "L100-L200" for lines 100-200, "c0-c5000" for char range',
        },
      },
      required: ['artifactId', 'section'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const { artifactId, section } = params.input as {
      artifactId: string
      section: string
    }

    if (!artifactId || !section) {
      return {
        content: 'Error: artifactId and section are required',
        isError: true,
      }
    }

    const artifactStore = params.artifactStore
    if (!artifactStore) {
      return {
        content: 'Error: artifactStore is not configured for this session',
        isError: true,
      }
    }

    const artifact = artifactStore.get(artifactId)
    if (!artifact) {
      return {
        content: `Error: Artifact ${artifactId} not found. Re-read the source.`,
        isError: true,
      }
    }

    const lineRange = parseLineRange(section)
    const charRange = parseCharRange(section)
    if (!lineRange && !charRange) {
      return {
        content: `Error: Invalid section format: ${section}. Use "L100-L200" for line range or "c0-c5000" for char range.`,
        isError: true,
      }
    }

    try {
      const rawContent = await artifactStore.readRaw(artifactId)
      if (rawContent === null) {
        return {
          content: `Error: Artifact ${artifactId} raw file missing on disk. Re-read the source.`,
          isError: true,
        }
      }
      const sectionContent = extractSection(rawContent, section)

      const truncated = sectionContent.length > MAX_SECTION_CHARS
        ? sectionContent.slice(0, MAX_SECTION_CHARS) + `\n... [truncated at ${MAX_SECTION_CHARS} chars]`
        : sectionContent

      return {
        content: truncated,
        rawPath: artifact.rawPath,
      }
    } catch (err) {
      if (err instanceof ArtifactCorruptionError) {
        return {
          content: `Error: Artifact ${artifactId} is corrupted on disk (SHA-256 mismatch). Re-read the source.`,
          isError: true,
        }
      }
      const message = err instanceof Error ? err.message : String(err)
      return {
        content: `Error reading artifact ${artifactId}: ${message}`,
        isError: true,
      }
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
