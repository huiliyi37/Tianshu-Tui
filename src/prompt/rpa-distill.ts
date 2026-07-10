/**
 * RPA 录制蒸馏 prompt —— 把桌面录制的 JSONL 事件流组装成一次性 agent 任务，
 * 产出「语义工作流文档」（回放时作为 scheduled task 的 prompt / 参考文档）。
 *
 * 设计立场：录制产物不是坐标脚本，是带元素证据的语义任务描述。回放者是
 * agent（computer_use 的 find/wait_for 定位），因此蒸馏文档必须描述**意图与
 * 证据**，不能只是「点 (640,410)」的死回放。
 *
 * schema 契约（与 desktop/src-tauri/src/recorder.rs 共享）：首行 header
 * `{"schema":"rivet-recording/1",...}`，其余每行 `{ts,type,app,data}`，
 * type ∈ click|text|key_combo|app_switch。版本不符时拒读，提示重录。
 */

export const RECORDING_SCHEMA_VERSION = 'rivet-recording/1'

export interface RecordingHeader {
  schema: string
  startedAt?: number
  platform?: string
  appVersion?: string
}

export interface RecordingEvent {
  ts: number
  type: 'click' | 'text' | 'key_combo' | 'app_switch'
  app: string
  data: Record<string, unknown>
}

export type ParsedRecording =
  | { ok: true; header: RecordingHeader; events: RecordingEvent[] }
  | { ok: false; error: string }

const EVENT_TYPES = new Set(['click', 'text', 'key_combo', 'app_switch'])

/** 解析并校验录制 JSONL。schema 版本不符 / header 缺失 → 拒读。 */
export function parseRecording(jsonl: string): ParsedRecording {
  const lines = jsonl.split('\n').filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { ok: false, error: 'empty_recording' }

  let header: RecordingHeader
  try {
    header = JSON.parse(lines[0]!) as RecordingHeader
  } catch {
    return { ok: false, error: 'invalid_header' }
  }
  if (header.schema !== RECORDING_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported_schema:${header.schema ?? 'missing'}` }
  }

  const events: RecordingEvent[] = []
  for (const line of lines.slice(1)) {
    let ev: RecordingEvent
    try {
      ev = JSON.parse(line) as RecordingEvent
    } catch {
      continue // 单行损坏不废整个录制
    }
    if (typeof ev.ts !== 'number' || !EVENT_TYPES.has(ev.type)) continue
    events.push(ev)
  }
  if (events.length === 0) return { ok: false, error: 'no_events' }
  return { ok: true, header, events }
}

/** 事件流 → 人类可读的时间线（喂给蒸馏 agent 的原料，非最终产物）。 */
export function renderEventTimeline(events: readonly RecordingEvent[]): string {
  const lines: string[] = []
  for (const ev of events) {
    const t = `[${(ev.ts / 1000).toFixed(1)}s]`
    switch (ev.type) {
      case 'app_switch': {
        const from = String(ev.data['from'] ?? '')
        lines.push(`${t} 切换到应用「${ev.app}」${from ? `（从「${from}」）` : ''}`)
        break
      }
      case 'click': {
        const el = ev.data['element'] as
          | { role?: string; title?: string; value?: string; ancestors?: Array<{ role?: string; title?: string }> }
          | null
          | undefined
        const btn = ev.data['button'] === 'right' ? '右键' : ev.data['count'] === 2 ? '双击' : '点击'
        if (el && (el.role || el.title)) {
          const anc = (el.ancestors ?? [])
            .map((a) => a.title)
            .filter(Boolean)
            .join(' > ')
          lines.push(
            `${t} 在「${ev.app}」${btn}元素 role=${el.role ?? '?'} title=「${el.title ?? ''}」` +
              `${el.value ? ` value=「${el.value}」` : ''}${anc ? `（位于 ${anc}）` : ''}` +
              ` @(${ev.data['x']},${ev.data['y']})`,
          )
        } else {
          lines.push(`${t} 在「${ev.app}」${btn}坐标 (${ev.data['x']},${ev.data['y']})（无元素证据——需按上下文推断意图）`)
        }
        break
      }
      case 'text': {
        if (ev.data['redacted'] === true) {
          lines.push(`${t} 在「${ev.app}」输入了敏感内容（已脱敏，不可回放原文——回放时应提示用户手动处理该步）`)
        } else {
          lines.push(`${t} 在「${ev.app}」输入文本「${String(ev.data['text'] ?? '')}」`)
        }
        break
      }
      case 'key_combo': {
        lines.push(`${t} 在「${ev.app}」按下 ${String(ev.data['combo'] ?? '')}`)
        break
      }
    }
  }
  return lines.join('\n')
}

export interface DistillPromptInput {
  recordingId: string
  jsonl: string
  /** 工作流文档的写入路径（相对 session cwd），如 `.rivet/recordings/<id>.workflow.md`。 */
  workflowPath: string
}

export type DistillPromptResult =
  | { ok: true; prompt: string; eventCount: number; apps: string[] }
  | { ok: false; error: string }

/** 录制 JSONL → 蒸馏任务 prompt。解析失败时返回错误（route 层转 400）。 */
export function buildDistillPrompt(input: DistillPromptInput): DistillPromptResult {
  const parsed = parseRecording(input.jsonl)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { events } = parsed
  const apps = [...new Set(events.map((e) => e.app).filter(Boolean))]
  const timeline = renderEventTimeline(events)

  const prompt = [
    `你收到一段用户在桌面上示范操作的录制（录制 ID：${input.recordingId}），任务是把它蒸馏成一份**语义工作流文档**，供 agent 之后用 computer_use 工具无人值守地回放。`,
    '',
    '## 录制事件时间线',
    '',
    '```',
    timeline,
    '```',
    '',
    '## 蒸馏要求',
    '',
    '写出的工作流文档必须包含以下四节（markdown）：',
    '',
    '1. **目标**：一句话概括这段操作在完成什么（从事件流推断用户意图，不要罗列动作）。',
    '2. **步骤**：按 app 分段的语义步骤。每步写清：目标应用、动作意图、元素证据（role + title，来自事件的 element 字段）、输入文本（如有）、以及该步的**等待条件**（回放时应先用 find/wait_for 确认什么元素出现再动手）。有元素证据的步骤必须引用证据描述目标（如「点击标题为『搜索』的文本框」），**禁止**用裸坐标描述——坐标只在事件完全没有元素证据时作为兜底线索，并注明「需 snapshot 确认」。',
    '3. **验证步骤**：操作完成后如何确认成功（如「发送后 wait_for 消息文本出现在会话区域」）。每个有副作用的动作（发送/提交/保存）都要有对应验证。',
    '4. **不确定点**：列出回放时可能变化的因素（搜索结果排序、窗口状态、登录态、脱敏输入等），每条给出回放时的应对建议。',
    '',
    '注意：',
    '- 录制中标注「已脱敏」的输入无法回放原文，工作流里要把该步标为「需人工介入或从配置读取」。',
    '- 键入的文本可能是输入法组合前的按键序列（如拼音），要按上下文还原用户意图的最终文本；不确定时在「不确定点」里说明。',
    '- 回放者只有 computer_use（snapshot/find/wait_for/click/type/key/paste 等），写步骤时用这些动作的语汇。',
    '',
    '## 交付',
    '',
    `1. 用写文件工具把完整工作流文档写到 \`${input.workflowPath}\`（覆盖已存在文件）。`,
    '2. 最后用一段话总结目标与步骤数，不要重复整份文档。',
  ].join('\n')

  return { ok: true, prompt, eventCount: events.length, apps }
}
