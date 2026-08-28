/**
 * Provider key probe — 用一个轻量 GET 请求验证 API key 有效 + 端点连通。
 *
 * 选 OpenAI 兼容的 `/models` 端点：所有 OpenAI 兼容 provider 都支持、零 token
 * 消耗（不触发 completion 计费）、仅验证鉴权与连通性。被桌面端 ConnectWizard
 * 在保存 key 前调用，避免无效 key 写入配置直到用户真正发消息时才 401。
 */
import { fetchWithTimeout } from './fetch-timeout.js'

export interface KeyProbeResult {
  /** true = key 有效且端点可达；false = 鉴权失败 / 网络错误 / 超时。 */
  ok: boolean
  /** ok=false 时的可读原因（已 i18n-ready，直接透给前端展示）。 */
  error?: string
  /** HTTP 状态码（网络错误时缺省）。 */
  status?: number
  /** 200 响应里 data[].id 的模型 id 列表（端点顺序、trim、去重、截断 200）——
   *  桌面端「从接口拉取」批量导入的数据源。响应没有 data 数组时缺省，不影响探测结论。 */
  models?: string[]
}

/** 聚合端点（OpenRouter 等）可能返回上千条——截断防护。 */
const MAX_PROBE_MODELS = 200

function parseModelIds(payload: unknown): string[] | undefined {
  if (payload == null || typeof payload !== 'object') return undefined
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  const ids: string[] = []
  for (const entry of data) {
    if (entry == null || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || !id.trim()) continue
    const trimmed = id.trim()
    if (!ids.includes(trimmed)) ids.push(trimmed)
    if (ids.length >= MAX_PROBE_MODELS) break
  }
  return ids
}

/**
 * 向 provider 的 `/models` 端点发 GET 验证 key。
 *
 * @param apiKey 待验证的 key（明文，仅在 sidecar 进程内使用，不落盘不外发）
 * @param baseUrl provider 的 OpenAI 兼容 baseUrl（如 `https://api.deepseek.com/v1`）
 */
export async function probeProviderKey(
  apiKey: string,
  baseUrl: string,
): Promise<KeyProbeResult> {
  const key = apiKey.trim()
  if (!key) return { ok: false, error: 'API key is empty' }
  const url = `${baseUrl.replace(/\/+$/, '')}/models`
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    }, 12_000)
    if (res.ok) {
      // 顺手把 /models 列表带回来——探测本来就在拉这个端点，丢弃列表是浪费。
      // body 非 JSON / 形状不对都不影响 ok 结论。
      let models: string[] | undefined
      try {
        models = parseModelIds(await res.json())
      } catch {
        models = undefined
      }
      return models ? { ok: true, status: res.status, models } : { ok: true, status: res.status }
    }
    // 401/403 = key 无效；其余（5xx/429）可能是服务端临时问题——区分告诉用户。
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'auth-failed' }
    }
    return { ok: false, status: res.status, error: `http-${res.status}` }
  } catch (e) {
    const msg = (e as Error)?.message ?? ''
    // fetch-timeout 抛 AbortError / "timed out" → 归类超时；其余归网络错误。
    if (/timeout|abort/i.test(msg)) return { ok: false, error: 'timeout' }
    return { ok: false, error: 'network-error' }
  }
}
