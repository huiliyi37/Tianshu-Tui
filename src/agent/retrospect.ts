/**
 * NTSB-inspired four-layer session retrospective.
 *
 * Generates a structured markdown report from:
 * - Sensorium telemetry (JSONL)
 * - Git commit log
 * - Tool execution events (from TraceStore)
 * - Evidence tracker summary
 * - Optional pheromone cross-reference
 *
 * Four analysis layers (HFACS model):
 *   L4 — System (prompt/tooling/model)
 *   L3 — Orchestration (task decomposition/guardrails)
 *   L2 — Context (freshness/pressure/working set)
 *   L1 — Execution (agent decisions/tool selection)
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface SensoriumEntry {
  ts: number
  turn: number
  phase: string
  momentum: number
  pressure: number
  confidence: number
  complexity: number
  freshness: number
  stability: number
  strategy: {
    reasoningEffort: string
    shouldEscalate: boolean
    thetaInterval: number
  }
  gitChangeRate?: number
}

export interface ToolEventSummary {
  turn: number
  name: string
  status: string
}

export interface EvidenceSummary {
  filesModified: number
  verifiedCount: number
}

export interface PheromoneSignalSummary {
  signal: string
  path: string
  strength: number
}

export interface RetrospectInput {
  sensoriumEntries: SensoriumEntry[]
  gitLog: string[]
  toolEvents: ToolEventSummary[]
  evidenceSummary: EvidenceSummary
  pheromoneSignals?: PheromoneSignalSummary[]
}

// ─── Parsing ────────────────────────────────────────────────────────

/**
 * Parse a raw sensorium.jsonl string into typed entries.
 * Invalid lines are silently skipped.
 */
export function parseSensoriumLog(raw: string): SensoriumEntry[] {
  const entries: SensoriumEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (
        typeof parsed.ts === 'number' &&
        typeof parsed.turn === 'number' &&
        typeof parsed.phase === 'string' &&
        typeof parsed.momentum === 'number' &&
        typeof parsed.pressure === 'number' &&
        typeof parsed.confidence === 'number' &&
        typeof parsed.complexity === 'number' &&
        typeof parsed.freshness === 'number' &&
        typeof parsed.stability === 'number' &&
        parsed.strategy &&
        typeof parsed.strategy.reasoningEffort === 'string'
      ) {
        entries.push({
          ts: parsed.ts,
          turn: parsed.turn,
          phase: parsed.phase,
          momentum: parsed.momentum,
          pressure: parsed.pressure,
          confidence: parsed.confidence,
          complexity: parsed.complexity,
          freshness: parsed.freshness,
          stability: parsed.stability,
          strategy: {
            reasoningEffort: parsed.strategy.reasoningEffort,
            shouldEscalate: Boolean(parsed.strategy.shouldEscalate),
            thetaInterval: Number(parsed.strategy.thetaInterval ?? 7),
          },
          gitChangeRate: typeof parsed.gitChangeRate === 'number' ? parsed.gitChangeRate : undefined,
        })
      }
    } catch {
      // Skip malformed lines
    }
  }
  return entries
}

// ─── Analysis helpers ───────────────────────────────────────────────

function maxOf(entries: SensoriumEntry[], key: keyof SensoriumEntry): number {
  return Math.max(0, ...entries.map(e => Number(e[key]) || 0))
}

function minOf(entries: SensoriumEntry[], key: keyof SensoriumEntry): number {
  return Math.min(1, ...entries.map(e => Number(e[key]) ?? 1))
}

function detectTrend(
  entries: SensoriumEntry[],
  key: keyof SensoriumEntry,
): 'rising' | 'falling' | 'stable' {
  if (entries.length < 2) return 'stable'
  const first = Number(entries[0]?.[key]) ?? 0
  const last = Number(entries[entries.length - 1]?.[key]) ?? 0
  if (last - first > 0.2) return 'rising'
  if (first - last > 0.2) return 'falling'
  return 'stable'
}

function phasesVisited(entries: SensoriumEntry[]): string[] {
  return [...new Set(entries.map(e => e.phase))]
}

function toolSuccessRate(events: ToolEventSummary[]): number {
  if (events.length === 0) return 1
  const passed = events.filter(e => e.status === 'passed').length
  return passed / events.length
}

// ─── Report generation ──────────────────────────────────────────────

export function generateRetrospect(input: RetrospectInput): string {
  const { sensoriumEntries, gitLog, toolEvents, evidenceSummary, pheromoneSignals } = input
  const lines: string[] = []

  // ── Header ──
  lines.push('# Session Retrospective\n')
  lines.push(`> 生成时间: ${new Date().toISOString()}\n`)

  // ── Section 1: Timeline ──
  lines.push('## 1. 事实时间线\n')

  if (sensoriumEntries.length === 0) {
    lines.push('数据不足：至少需要 1 个完整的 turn 才能生成时间线。\n')
  } else {
    const turns = sensoriumEntries.length
    const phases = phasesVisited(sensoriumEntries)
    const toolPassRate = toolSuccessRate(toolEvents)

    lines.push(`- **总轮次**: ${turns}`)
    lines.push(`- **经历阶段**: ${phases.join(' → ')}`)
    lines.push(`- **工具调用**: ${toolEvents.length} 次 (成功率 ${(toolPassRate * 100).toFixed(0)}%)`)
    lines.push(`- **文件修改**: ${evidenceSummary.filesModified} 个`)
    lines.push(`- **测试验证**: ${evidenceSummary.verifiedCount} 次通过`)
    lines.push(`- **最近提交**: ${gitLog.length > 0 ? gitLog.slice(0, 3).join(', ') : '无'}\n`)

    // Per-turn sensorium summary
    lines.push('| Turn | Phase | Momentum | Pressure | Confidence | Freshness | Stability |')
    lines.push('|------|-------|----------|----------|------------|-----------|-----------|')
    for (const e of sensoriumEntries) {
      lines.push(
        `| ${e.turn} | ${e.phase} | ${e.momentum.toFixed(2)} | ${e.pressure.toFixed(2)} | ${e.confidence.toFixed(2)} | ${e.freshness.toFixed(2)} | ${e.stability.toFixed(2)} |`,
      )
    }
    lines.push('')
  }

  // ── Section 2: Four-layer analysis ──
  lines.push('## 2. 四层分析\n')

  if (sensoriumEntries.length === 0) {
    lines.push('数据不足以进行四层分析。\n')
  } else {
    // L4 — System
    lines.push('### L4 系统层 (模型/工具/提示词)\n')
    const maxPressure = maxOf(sensoriumEntries, 'pressure')
    if (maxPressure > 0.7) {
      lines.push('- ⚠️ 上下文压力超过 70%，提示词模板或工具输出可能过于冗长')
    } else {
      lines.push('- 上下文压力保持在健康范围内')
    }

    const toolNames = [...new Set(toolEvents.map(e => e.name))]
    lines.push(`- 使用工具: ${toolNames.join(', ') || '无'}`)

    if (gitLog.length === 0) {
      lines.push('- 未检测到 git 提交历史，可能是新仓库或无 git 环境')
    }
    lines.push('')

    // L3 — Orchestration
    lines.push('### L3 编排层 (任务拆解/护栏)\n')
    const escalated = sensoriumEntries.some(e => e.strategy.shouldEscalate)
    if (escalated) {
      lines.push('- ⚠️ 触发了模型升级信号，任务复杂度可能超出当前模型能力')
    }

    const confidenceTrend = detectTrend(sensoriumEntries, 'confidence')
    if (confidenceTrend === 'falling') {
      lines.push('- ⚠️ 验证置信度持续下降，可能需要重新拆解任务或增加中间验证步骤')
    } else {
      lines.push('- 验证置信度趋势正常')
    }

    const complexityMax = maxOf(sensoriumEntries, 'complexity')
    if (complexityMax > 0.5) {
      lines.push(`- 工具复杂度达到 ${complexityMax.toFixed(2)}，涉及多种工具组合，拆解质量直接影响效率`)
    }
    lines.push('')

    // L2 — Context
    lines.push('### L2 上下文层 (freshness/pressure/工作集)\n')
    const freshnessMin = minOf(sensoriumEntries, 'freshness')
    const freshnessTrend = detectTrend(sensoriumEntries, 'freshness')
    if (freshnessMin < 0.3 || freshnessTrend === 'falling') {
      lines.push(`- ⚠️ 代码熟悉度最低 ${freshnessMin.toFixed(2)}，可能在新领域或陌生文件中操作`)
    } else {
      lines.push(`- 代码熟悉度保持在 ${freshnessMin.toFixed(2)} 以上，工作区域相对熟悉`)
    }

    if (maxPressure > 0.5) {
      lines.push(`- 上下文压力最高 ${maxPressure.toFixed(2)}，超过 50% 可能影响 long-context 推理准确性`)
    }

    const gitChangeEntries = sensoriumEntries.filter(e => e.gitChangeRate !== undefined)
    if (gitChangeEntries.length > 0) {
      const maxChange = maxOf(gitChangeEntries, 'gitChangeRate' as keyof SensoriumEntry)
      if (maxChange > 0.5) {
        lines.push(`- ⚠️ Git 变更率最高 ${maxChange.toFixed(2)}，代码库正在活跃变动中`)
      }
    }
    lines.push('')

    // L1 — Execution
    lines.push('### L1 执行层 (agent 决策/工具选择)\n')
    const momentumTrend = detectTrend(sensoriumEntries, 'momentum')
    if (momentumTrend === 'falling') {
      lines.push('- ⚠️ 预测动量下降，agent 的策略选择可能需要调整')
    }

    const stabilityMin = minOf(sensoriumEntries, 'stability')
    if (stabilityMin < 0.5) {
      lines.push(`- ⚠️ 稳定性最低 ${stabilityMin.toFixed(2)}，出现了重复操作或策略振荡`)
    }

    const failedTools = toolEvents.filter(e => e.status !== 'passed')
    if (failedTools.length > 0) {
      lines.push(`- 失败工具调用: ${failedTools.map(t => t.name).join(', ')}`)
    }

    const readCount = toolEvents.filter(e => e.name === 'read_file').length
    const writeCount = toolEvents.filter(e => e.name === 'edit_file' || e.name === 'write_file').length
    if (readCount > 0 || writeCount > 0) {
      lines.push(`- 读取 ${readCount} 次，写入 ${writeCount} 次`)
    }
    lines.push('')
  }

  // ── Section 3: Root cause ──
  lines.push('## 3. 根因判定\n')

  const confidenceDrop = detectTrend(sensoriumEntries, 'confidence') === 'falling'
  const stabilityDrop = detectTrend(sensoriumEntries, 'stability') === 'falling'
  const maxPressure2 = maxOf(sensoriumEntries, 'pressure')

  if (sensoriumEntries.length === 0) {
    lines.push('- **Probable Cause**: 数据不足，无法判定')
    lines.push('- **Contributing Factors**: 无足够遥测数据\n')
  } else if (confidenceDrop && stabilityDrop) {
    lines.push('- **Probable Cause**: 验证反馈不足 + 策略振荡组合')
    lines.push('- **Contributing Factors**: 上下文压力、任务拆解粒度、工具输出截断策略\n')
  } else if (stabilityDrop) {
    lines.push('- **Probable Cause**: 策略稳定性下降（重复操作或振荡）')
    lines.push('- **Contributing Factors**: doom loop 检测阈值、工具指纹哈希精度\n')
  } else if (confidenceDrop) {
    lines.push('- **Probable Cause**: 验证置信度下降（测试未覆盖修改范围）')
    lines.push('- **Contributing Factors**: 文件修改后未及时运行测试、测试覆盖率不足\n')
  } else if (maxPressure2 > 0.7) {
    lines.push('- **Probable Cause**: 上下文压力过高')
    lines.push('- **Contributing Factors**: compact 触发时机、工具输出长度、消息历史积累\n')
  } else {
    lines.push('- **Probable Cause**: 无明显故障模式')
    lines.push('- **Contributing Factors**: 本次会话表现良好\n')
  }

  // ── Section 4: Recommendations ──
  lines.push('## 4. 寻址建议\n')
  if (stabilityDrop) lines.push('- **致系统设计**: 检查 doom loop 检测阈值是否过于敏感')
  if (confidenceDrop) lines.push('- **致用户**: 考虑在关键修改后手动运行测试验证')
  if (maxPressure2 > 0.7) lines.push('- **致工具维护**: 检查 compact 策略是否及时触发')
  if (!stabilityDrop && !confidenceDrop && maxPressure2 <= 0.7) {
    lines.push('- 本次会话表现良好，无需特别调整')
  }
  lines.push('')

  // ── Section 5: Pattern recognition ──
  lines.push('## 5. 模式识别\n')
  if (sensoriumEntries.length < 3) {
    lines.push('数据不足以进行模式识别（需要至少 3 个 turn）。\n')
  } else {
    const uniquePhases = phasesVisited(sensoriumEntries).length
    lines.push(`- 经历 ${uniquePhases} 个不同阶段，覆盖 ${uniquePhases} / 8 星相`)
    if (uniquePhases <= 2) {
      lines.push('- 阶段覆盖较少，任务可能较简单或被过早终止')
    }
    lines.push('')
  }

  // ── Enhancement: Pheromone cross-reference ──
  if (pheromoneSignals && pheromoneSignals.length > 0) {
    lines.push('## 6. 信息素沉积\n')
    lines.push('| 信号 | 文件 | 强度 |')
    lines.push('|------|------|------|')
    for (const p of pheromoneSignals) {
      lines.push(`| ${p.signal} | ${p.path} | ${p.strength.toFixed(2)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
