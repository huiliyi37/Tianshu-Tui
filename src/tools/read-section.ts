import { stat, readFile } from 'node:fs/promises'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { ArtifactCorruptionError, MAX_RANGE_LINES } from '../artifact/store.js'
import { COMPACT_HISTORY_TOOL, buildRecallMarker } from '../compact/recall-marker.js'
import { computeModelReadCap } from './model-read-cap.js'
import { validatePath } from './path-validate.js'
import { getFileReadMtime } from './read-file.js'

/** Maximum raw artifact file size to read into memory (2MB).
 *  Larger files cause memory pressure and stall on repeated read_section
 *  attempts — the model should use grep or targeted bash commands instead. */
const MAX_RAW_BYTES = 2 * 1024 * 1024

/**
 * Hard floor on read_section output. Matches the legacy default before
 * window-aware sizing — small (<200K) windows still get this.
 *
 * Background: read_section was written when read_file capped at 8 K, so 8 K
 * here was symmetric. Now read_file scales to ~200 K on a 1 M window, but
 * read_section was still hardcoded to 8 K — so when prune redirected the
 * model to "use read_section to recover", it could only recover 8 K of a 60 K
 * file, leaving the model visibly stuck (model self-reported "results are
 * being truncated to 8030 chars max").
 *
 * read_section now uses the same window-aware budget as read_file/grep.
 */
const LEGACY_MAX_SECTION_CHARS = 8000

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
    description: `Read a specific section from a previously saved artifact or a live file on disk.

### Usage
- Use this to load details from artifact output that was summarized in the message history
- Or use with file_path to recover content from a file that was read earlier in the session (e.g. after a read-ref reference)
- Requires artifactId or file_path — at least one must be provided
- Supports line ranges (L100-L200) and character ranges (c0-c5000)

### Examples
Good: read_section(artifactId="abc123", section="L1-L500")
Good: read_section(artifactId="abc123", section="c0-c50000")
Good: read_section(file_path="src/tools/bash.ts", section="L100-L200")`,
    input_schema: {
      type: 'object',
      properties: {
        artifactId: {
          type: 'string',
          description: 'The artifact ID from a prior tool_result',
        },
        file_path: {
          type: 'string',
          description: 'Path to a live file on disk. Use when recovering content after a read-ref reference. Path is validated against the project directory.',
        },
        section: {
          type: 'string',
          description: 'Section to read: "L100-L200" for lines 100-200, "c0-c5000" for char range',
        },
      },
      required: ['section'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const { artifactId, file_path, section } = params.input as {
      artifactId?: string
      file_path?: string
      section: string
    }

    if (!section) {
      return {
        content: 'Error: section is required',
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

    // ── file_path branch: read from live file (B3) ──
    if (file_path && !artifactId) {
      try {
        const canonical = validatePath(params.cwd, file_path)

        // Staleness check: warn if file mtime differs from last read_file
        const lastMtime = getFileReadMtime(canonical, params.sessionId)
        let stalenessNote = ''
        if (lastMtime !== null) {
          try {
            const currentMtime = (await stat(canonical)).mtimeMs
            if (currentMtime !== lastMtime) {
              stalenessNote = `\n⚠ 文件自上次 read_file 后已变更（mtime 不匹配）。以下内容为当前磁盘版本，可能与上文不一致。\n`
            }
          } catch { /* file may not exist — handled below */ }
        }

        // Guard against multi-MB files
        let _rawSize = 0
        try { _rawSize = (await stat(canonical)).size } catch { /* handled below */ }
        if (_rawSize > MAX_RAW_BYTES) {
          return {
            content: `Error: File ${canonical} is too large (${(_rawSize / 1024 / 1024).toFixed(1)}MB > ${MAX_RAW_BYTES / 1024 / 1024}MB limit). Use grep or bash with head/tail to inspect the file directly.`,
            isError: true,
          }
        }

        const rawContent = await readFile(canonical, 'utf-8')
        const sectionContent = extractSection(rawContent, section)

        const cap = computeModelReadCap({
          contextWindow: params.contextWindow,
          providerProfile: params.providerProfile,
        })
        const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)
        const truncated = sectionContent.length > maxChars
          ? sectionContent.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`
          : sectionContent

        return {
          content: stalenessNote ? stalenessNote + truncated : truncated,
          rawPath: canonical,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: `Error reading file: ${message}`,
          isError: true,
        }
      }
    }

    // ── artifactId branch: existing behavior ──
    if (!artifactId) {
      return {
        content: 'Error: artifactId or file_path is required',
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
        content: `Error: Artifact ${artifactId} not found — it may have been pruned or never created. Use the original tool (bash/read_file/grep) to regenerate the output.`,
        isError: true,
      }
    }

    // Compact-history recall fast path: long-thread archives routinely exceed the
    // 2MB in-memory ceiling below, which would make their own catalog entries
    // un-recallable. For a line range, stream just the requested lines (no whole
    // file in memory, no 2MB gate). char ranges + normal artifacts fall through.
    if (artifact.tool === COMPACT_HISTORY_TOOL && lineRange) {
      try {
        const ranged = await artifactStore.readLineRange(artifactId, lineRange.start, lineRange.end)
        if (ranged === null) {
          return {
            content: `Error: Artifact ${artifactId} not found.`,
            isError: true,
          }
        }
        if (ranged.content.length === 0 && lineRange.start > ranged.totalLines) {
          return {
            content: `[Section ${section} out of range — artifact has ${ranged.totalLines} lines]`,
            isError: false,
          }
        }
        const cap = computeModelReadCap({
          contextWindow: params.contextWindow,
          providerProfile: params.providerProfile,
        })
        const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)
        let body = ranged.content.length > maxChars
          ? ranged.content.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`
          : ranged.content
        if (ranged.capped) {
          body += `\n... [range capped at ${MAX_RANGE_LINES} lines — request a narrower range to page]`
        }
        return {
          content: `${buildRecallMarker(artifactId, section)}\n${body}`,
          rawPath: artifact.rawPath,
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: `Error reading artifact ${artifactId}: ${message}`,
          isError: true,
        }
      }
    }

    try {
      // Guard against reading multi-MB raw files into memory.
      let _rawSize = 0
      try { _rawSize = (await stat(artifact.rawPath)).size } catch { /* file may not exist */ }
      if (_rawSize > MAX_RAW_BYTES) {
        return {
          content: `Error: Artifact ${artifactId} raw file is too large (${(_rawSize / 1024 / 1024).toFixed(1)}MB > 2MB limit). Use grep on the original output, or bash with head/tail to inspect the file directly.`,
          isError: true,
        }
      }

      const rawContent = await artifactStore.readRaw(artifactId)
      if (rawContent === null) {
        return {
          content: `Error: Artifact ${artifactId} raw file missing on disk (${artifact.rawPath}). It may have been cleaned up. Use the original tool to regenerate the output.`,
          isError: true,
        }
      }
      const sectionContent = extractSection(rawContent, section)

      // Window-aware cap: 1M window allows ~200K, 64K window stays at 8K.
      // Without this, prune-then-recover paths gave the model only 8K back —
      // see LEGACY_MAX_SECTION_CHARS comment.
      const cap = computeModelReadCap({
        contextWindow: params.contextWindow,
        providerProfile: params.providerProfile,
      })
      const maxChars = Math.max(cap.maxChars, LEGACY_MAX_SECTION_CHARS)

      const truncated = sectionContent.length > maxChars
        ? sectionContent.slice(0, maxChars) + `\n... [truncated at ${maxChars} chars]`
        : sectionContent

      // Tag recalls of compacted-history blocks so the NEXT compaction can
      // collapse this recalled content back to a pointer (recall-eviction)
      // instead of re-archiving it verbatim and accumulating storage.
      const content = artifact.tool === COMPACT_HISTORY_TOOL
        ? `${buildRecallMarker(artifactId, section)}\n${truncated}`
        : truncated

      return {
        content,
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
