export type SettingsApproval = 'manual' | 'auto-safe' | 'dangerously-skip-permissions'

export type ParseTurns = { ok: true; value: number } | { ok: false; error: string }
export type ParseModel = { ok: true; value: string } | { ok: false; error: string }
export type ParseDomain = { ok: true; value: string } | { ok: false; error: string }

/** 自动档检查点间隔：0 = 关。 */
export function parseCheckpointTurns(raw: string): ParseTurns {
  const t = raw.trim()
  if (!t) return { ok: false, error: '轮数不能为空' }
  if (!/^\d+$/.test(t)) return { ok: false, error: '轮数必须是非负整数（0 = 关）' }
  return { ok: true, value: Number(t) }
}

/** 默认模型：`provider:modelId`（modelId 可含 `/`）。 */
export function parseDefaultModel(raw: string): ParseModel {
  const t = raw.trim()
  if (!t) return { ok: false, error: '请选择默认模型' }
  const colon = t.indexOf(':')
  if (colon <= 0 || colon === t.length - 1) {
    return { ok: false, error: '默认模型须为 provider:modelId' }
  }
  return { ok: true, value: t }
}

/** 默认星域：`auto` 或已知域 id。knownIds 缺省时只拦空串。 */
export function parseDefaultDomain(raw: string, knownIds?: readonly string[]): ParseDomain {
  const t = raw.trim()
  if (!t) return { ok: false, error: '请选择默认星域' }
  if (t === 'auto') return { ok: true, value: 'auto' }
  if (knownIds && knownIds.length > 0 && !knownIds.includes(t)) {
    return { ok: false, error: `未知星域: ${t}` }
  }
  return { ok: true, value: t }
}

/** 对外三档。auto-accept 隐档显示为自动；suggest 等未知回退监督。 */
export function wireApproval(mode: string | undefined): SettingsApproval {
  switch (mode) {
    case 'manual':
      return 'manual'
    case 'dangerously-skip-permissions':
      return 'dangerously-skip-permissions'
    case 'auto-safe':
    case 'auto-accept':
    case '':
    case undefined:
      return 'auto-safe'
    default:
      return 'manual'
  }
}
