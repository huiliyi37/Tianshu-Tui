export interface CacheLogRecord {
  turn?: unknown
  hitRate?: unknown
  cacheRead?: unknown
  cacheCreate?: unknown
  ttftMs?: unknown
  outputRawBytes?: unknown
  outputTrimmedBytes?: unknown
  outputFilterIds?: unknown
  toolUiEvents?: unknown
}

export interface MetricSummary {
  average: number | null
  known: number
  unknown: number
}

export interface CacheLogGroupSummary {
  records: number
  hitRate: MetricSummary
  cacheCreate: MetricSummary
  ttftMs: MetricSummary
  outputRawBytes: MetricSummary
  outputTrimmedBytes: MetricSummary
  toolUiEvents: MetricSummary
  outputFilterIds: string[]
  outputFilterIdsCoverage: {
    known: number
    unknown: number
  }
}

export interface OfflineCacheSummary {
  turn0: CacheLogGroupSummary
  turn1Plus: CacheLogGroupSummary
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function parsePercentStrict(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined
  }
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value)) return undefined
  const parsed = Number(value.slice(0, -1))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined
}

function summarizeMetric(records: readonly CacheLogRecord[], read: (record: CacheLogRecord) => number | undefined): MetricSummary {
  const values = records.flatMap(record => {
    const value = read(record)
    return value === undefined ? [] : [value]
  })
  return {
    average: values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    known: values.length,
    unknown: records.length - values.length,
  }
}

function summarizeGroup(records: readonly CacheLogRecord[]): CacheLogGroupSummary {
  const weightedRows = records.flatMap(record => {
    const cacheRead = numberValue(record.cacheRead)
    const cacheCreate = numberValue(record.cacheCreate)
    if (cacheRead === undefined || cacheCreate === undefined || cacheRead < 0 || cacheCreate < 0) return []
    const total = cacheRead + cacheCreate
    return total > 0 ? [{ cacheRead, total }] : []
  })
  const weightedTotal = weightedRows.reduce((sum, row) => sum + row.total, 0)
  const filterIds = records.flatMap(record => (
    Array.isArray(record.outputFilterIds)
      ? record.outputFilterIds.filter((id): id is string => typeof id === 'string')
      : []
  ))
  const filterIdsKnown = records.filter(record => Array.isArray(record.outputFilterIds)).length
  return {
    records: records.length,
    hitRate: {
      average: weightedTotal > 0
        ? weightedRows.reduce((sum, row) => sum + row.cacheRead, 0) / weightedTotal * 100
        : null,
      known: weightedRows.length,
      unknown: records.length - weightedRows.length,
    },
    cacheCreate: summarizeMetric(records, record => numberValue(record.cacheCreate)),
    ttftMs: summarizeMetric(records, record => numberValue(record.ttftMs)),
    outputRawBytes: summarizeMetric(records, record => numberValue(record.outputRawBytes)),
    outputTrimmedBytes: summarizeMetric(records, record => numberValue(record.outputTrimmedBytes)),
    toolUiEvents: summarizeMetric(records, record => numberValue(record.toolUiEvents)),
    outputFilterIds: [...new Set(filterIds)],
    outputFilterIdsCoverage: {
      known: filterIdsKnown,
      unknown: records.length - filterIdsKnown,
    },
  }
}

export function summarizeCacheLog(records: readonly CacheLogRecord[]): OfflineCacheSummary {
  const turnRecords = records.filter(record => typeof record.turn === 'number')
  return {
    turn0: summarizeGroup(turnRecords.filter(record => record.turn === 0)),
    turn1Plus: summarizeGroup(turnRecords.filter(record => (record.turn as number) >= 1)),
  }
}

export function parseCacheLogJsonl(content: string): CacheLogRecord[] {
  return content.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
      const record = parsed as CacheLogRecord
      if (record.hitRate !== undefined && parsePercentStrict(record.hitRate) === undefined) {
        return [Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== 'hitRate'),
        ) as CacheLogRecord]
      }
      return [record]
    } catch {
      return []
    }
  })
}

function formatMetric(metric: MetricSummary, suffix = ''): string {
  const average = metric.average === null ? 'unknown' : `${metric.average.toFixed(1)}${suffix}`
  return metric.unknown > 0 ? `${average} (${metric.unknown} unknown)` : average
}

function formatOutputFilterIds(group: CacheLogGroupSummary): string {
  const base = group.outputFilterIds.length > 0
    ? group.outputFilterIds.join(', ')
    : group.outputFilterIdsCoverage.known > 0
      ? 'none'
      : 'unknown'
  return group.outputFilterIdsCoverage.known > 0 && group.outputFilterIdsCoverage.unknown > 0
    ? `${base} (partial; ${group.outputFilterIdsCoverage.unknown} unknown)`
    : base
}

function formatGroup(label: string, group: CacheLogGroupSummary): string[] {
  return [
    `${label} (${group.records} records)`,
    `  hitRate: ${formatMetric(group.hitRate, '%')}`,
    `  cacheCreate: ${formatMetric(group.cacheCreate)}`,
    `  TTFT: ${formatMetric(group.ttftMs, ' ms')}`,
    `  output raw bytes: ${formatMetric(group.outputRawBytes)}`,
    `  output trimmed bytes: ${formatMetric(group.outputTrimmedBytes)}`,
    `  output filters: ${formatOutputFilterIds(group)}`,
    `  tool UI events: ${formatMetric(group.toolUiEvents)}`,
  ]
}

export function formatOfflineCacheSummary(summary: OfflineCacheSummary): string {
  return [
    'Cache log offline summary',
    ...formatGroup('turn0', summary.turn0),
    ...formatGroup('turn1+', summary.turn1Plus),
  ].join('\n')
}

export function cacheRegressionAdvisory(summary: OfflineCacheSummary): string | null {
  const hitRate = summary.turn1Plus.hitRate.average
  if (hitRate === null || hitRate >= 90) return null
  return `ADVISORY: turn1+ cache hit rate is ${hitRate.toFixed(1)}% (<90%); investigate prefix stability. External-provider variance does not fail this check.`
}
