export interface SearchCandidate {
  file: string
  score: number
}

const TEST_QUERY = /(?:test|spec|assert|coverage|fixture|mock|测试|验证|断言|覆盖)/i
const DOC_QUERY = /(?:doc|readme|design|specification|文档|设计|规范)/i
const LOW_SIGNAL_SEGMENTS = new Set(['__tests__', 'fixtures', 'fixture', 'examples', 'example', 'mocks', 'mock'])
const GENERATED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', 'target', 'vendor'])

function pathSegments(file: string): string[] {
  return file.replaceAll('\\', '/').toLowerCase().split('/').filter(Boolean)
}

/** Return a deterministic multiplier that favors implementation over noise. */
export function searchPathSalience(file: string, query = ''): number {
  const lower = file.replaceAll('\\', '/').toLowerCase()
  const segments = pathSegments(lower)
  if (segments.some(segment => GENERATED_SEGMENTS.has(segment))) return 0

  const testFocused = TEST_QUERY.test(query)
  const docFocused = DOC_QUERY.test(query)
  const isTest = segments.includes('__tests__') || /\.(?:test|spec)\.[^.]+$/.test(lower)
  const isDoc = /(?:^|\/)(?:docs?|design|specs?)(?:\/|$)/.test(lower) || /(?:readme|design|changelog)\.[^.]+$/.test(lower)
  const isFixture = segments.some(segment => LOW_SIGNAL_SEGMENTS.has(segment))

  let multiplier = lower.startsWith('src/') ? 1.08 : 1
  if (isTest && !testFocused) multiplier *= 0.62
  if (isDoc && !docFocused) multiplier *= 0.72
  if (isFixture && !testFocused) multiplier *= 0.55
  return multiplier
}

/**
 * Re-rank search results for information density.
 *
 * Search indexes contain overlapping definition chunks. Returning ten chunks
 * from one test fixture is technically correct but poor evidence for an agent.
 * This pass keeps a small per-file quota and applies transparent path salience
 * without changing the underlying lexical or embedding scores.
 */
export function rankSearchCandidates<T extends SearchCandidate>(
  candidates: readonly T[],
  query: string,
  limit: number,
  maxPerFile = 2,
): T[] {
  const boundedLimit = Math.max(1, Math.floor(limit))
  const boundedPerFile = Math.max(1, Math.floor(maxPerFile))
  const ranked = candidates
    .map((candidate, index) => ({
      candidate,
      index,
      salience: searchPathSalience(candidate.file, query),
      score: candidate.score * searchPathSalience(candidate.file, query),
    }))
    .filter(entry => entry.salience > 0)
    .sort((a, b) => b.score - a.score || b.salience - a.salience || a.index - b.index)

  const selected: T[] = []
  const perFile = new Map<string, number>()
  const selectedIndexes = new Set<number>()
  const primary = ranked.filter(entry => entry.salience >= 0.9)
  const secondary = ranked.filter(entry => entry.salience < 0.9)

  // Fill implementation evidence first, then admit lower-salience tests/docs
  // when the result set would otherwise be sparse. This keeps one noisy file
  // from displacing a second implementation file.
  for (const pool of [primary, secondary]) {
    for (let pass = 0; pass < boundedPerFile && selected.length < boundedLimit; pass++) {
      for (const entry of pool) {
        if (selected.length >= boundedLimit) break
        if (selectedIndexes.has(entry.index)) continue
        const count = perFile.get(entry.candidate.file) ?? 0
        if (count !== pass) continue
        selected.push(entry.candidate)
        selectedIndexes.add(entry.index)
        perFile.set(entry.candidate.file, count + 1)
      }
    }
  }
  return selected
}
