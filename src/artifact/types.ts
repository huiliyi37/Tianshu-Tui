export interface ArtifactSection {
  /** e.g. "imports" | "exports" | "function:commitAction" | "lines:90-125" */
  name: string
  lineStart: number
  lineEnd: number
  charCount: number
}

export interface Artifact {
  /** Globally unique artifact id, usually `${tool}:${shortUuid}`. */
  id: string
  /** Tool that produced this artifact, e.g. read_file, grep, bash, run_tests. */
  tool: string
  /** File path, grep pattern, command, or other tool target. */
  target: string
  sessionId: string
  createdAt: number
  /** Heuristic summary injected into message history. */
  summary: string
  sections: ArtifactSection[]
  /** Absolute path to the persisted raw content. */
  rawPath: string
  charCount: number
  lineCount: number
  /** SHA-256 of the raw content at save time, used to detect artifact corruption. */
  sha256: string
}

export interface ArtifactRef {
  artifactId: string
  summary: string
  charCount: number
  lineCount: number
  /** Section names for quick reference. */
  sections: string[]
}

/** Generate the compact text injected into message history. */
export function formatArtifactRef(ref: ArtifactRef): string {
  const sectionList = ref.sections.length > 0
    ? ` Sections: ${ref.sections.join(', ')}.`
    : ''
  return `[${ref.charCount} chars, ${ref.lineCount} lines]${sectionList} ${ref.summary} (use read_section to expand)`
}
