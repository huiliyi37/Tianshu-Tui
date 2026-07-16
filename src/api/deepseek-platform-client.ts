/**
 * DeepSeek 平台 API 客户端 — 成本明细与用量趋势。
 *
 * 参考 DeepSeekDesktopAssistant 逆向的三条 platform.deepseek.com API：
 *   1. GET /api/v0/users/get_user_summary  — 当天/当月花费汇总
 *   2. GET /api/v0/usage/cost?month=&year= — 按模型按天的成本明细
 *   3. GET /api/v0/usage/amount?month=     — 余额明细（赠送/充值分项）
 *
 * 鉴权：API Key（Authorization: Bearer），与 balance-client 同源。非 DeepSeek
 * provider 返回 null，调用方静默处理。
 *
 * 注意：cost_in_cents 单位是**分**（不是元），展示时需 /100。
 */

// ── 响应类型（从 exe 逆向的 serde 结构） ──────────────────────────

/** DeepSeek 平台通用响应包装：{ biz_code, biz_data } 嵌套两层。 */
interface PlatformEnvelope<T> {
  biz_code?: number
  biz_data?: T
}

export interface DeepSeekUserSummary {
  is_account_available: boolean
  current_day_cost: number
  current_month_cost: number
  current_day_requests: number
  flash_usage: number
  pro_usage: number
  balance_info: {
    currency: string
    total_balance: number
    granted_balance?: number
    topped_up_balance?: number
  }
}

export interface DeepSeekCostEntry {
  total_tokens: number
  cost_in_cents: number
  input_cache_hit_tokens: number
  input_cache_miss_tokens: number
  output_tokens: number
  request_count: number
  /** ISO date string or day-of-month, populated by the caller from context. */
  date?: string
}

export interface DeepSeekModelCost {
  model: string
  usage: DeepSeekCostEntry[]
}

export interface DeepSeekCostReport {
  total: { cost_in_cents: number; total_tokens: number }
  /** 按 model 分组，每组内按天列出 usage。 */
  models: DeepSeekModelCost[]
}

export interface DeepSeekAmountDetail {
  total_balance: number
  granted_balance: number
  topped_up_balance: number
  currency: string
}

// ── 鉴权判断 ──────────────────────────────────────────────────────

function isDeepSeekProvider(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  return /api\.deepseek\.com/i.test(baseUrl)
}

/** 从 provider baseUrl 推导 platform.deepseek.com 基础 URL。 */
function platformBaseUrl(baseUrl: string | undefined): string {
  // api.deepseek.com → platform.deepseek.com（同域不同子域）
  return 'https://platform.deepseek.com'
}

// ── API 调用 ──────────────────────────────────────────────────────

async function platformFetch<T>(
  path: string,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<T | null> {
  if (!apiKey || !isDeepSeekProvider(baseUrl)) return null
  const url = `${platformBaseUrl(baseUrl)}${path}`
  try {
    const timeoutSignal = AbortSignal.timeout(10_000)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: combinedSignal,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** 解嵌 { biz_code, biz_data: { biz_code, biz_data: <payload> } } 两层包装。 */
function unwrap<T>(raw: unknown): T | null {
  if (!raw || typeof raw !== 'object') return null
  const outer = raw as PlatformEnvelope<PlatformEnvelope<unknown>>
  const inner = outer.biz_data
  if (!inner || typeof inner !== 'object') return null
  // 有些端点只有一层 biz_data（直接是 payload），有些有两层
  const payload = (inner as PlatformEnvelope<unknown>).biz_data ?? inner
  return payload as T
}

/**
 * 1. 用户摘要：当天/当月花费、余额、Flash/Pro 用量。
 * GET /api/v0/users/get_user_summary
 */
export async function getDeepSeekUserSummary(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<DeepSeekUserSummary | null> {
  const raw = await platformFetch('/api/v0/users/get_user_summary', apiKey, baseUrl, signal)
  return unwrap<DeepSeekUserSummary>(raw)
}

/**
 * 2. 成本明细：按模型按天的 token/cost 明细。
 * GET /api/v0/usage/cost?month=<M>&year=<Y>
 *
 * month 是 1-12（不是 YYYY-MM），year 是四位年。
 */
export async function getDeepSeekCostReport(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  month: number,
  year: number,
  signal?: AbortSignal,
): Promise<DeepSeekCostReport | null> {
  const raw = await platformFetch(
    `/api/v0/usage/cost?month=${month}&year=${year}`,
    apiKey,
    baseUrl,
    signal,
  )
  if (!raw) return null
  const data = unwrap<{ total: DeepSeekCostReport['total']; days?: DeepSeekModelCost[] }>(raw)
  if (!data) return null
  return {
    total: data.total ?? { cost_in_cents: 0, total_tokens: 0 },
    models: data.days ?? [],
  }
}

/**
 * 3. 余额明细：总额/赠送/充值分项。
 * GET /api/v0/usage/amount?month=<YYYY-MM>
 */
export async function getDeepSeekAmount(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  month: string, // YYYY-MM format
  signal?: AbortSignal,
): Promise<DeepSeekAmountDetail | null> {
  const raw = await platformFetch(
    `/api/v0/usage/amount?month=${month}`,
    apiKey,
    baseUrl,
    signal,
  )
  return unwrap<DeepSeekAmountDetail>(raw)
}
