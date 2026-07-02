/**
 * DeepSeek 余额查询客户端。
 *
 * 官方 API：GET https://api.deepseek.com/user/balance（Authorization: Bearer）
 * 返回 { is_available, balance_infos[]: { currency, total_balance } }。
 *
 * 仅 DeepSeek 官方端点支持此接口（其他 OpenAI 兼容 provider 无此 API）。
 * 非 DeepSeek provider 返回 null，调用方静默处理。
 */

export interface BalanceInfo {
  currency: string
  totalBalance: string
}

export interface BalanceResult {
  isAvailable: boolean
  balances: BalanceInfo[]
}

/** DeepSeek 官方 baseUrl 域名特征——用于判断 provider 是否为 DeepSeek 官方端点。 */
function isDeepSeekProvider(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  return /api\.deepseek\.com/i.test(baseUrl)
}

/**
 * 查询 DeepSeek 账户余额。非 DeepSeek provider 返回 null。
 * 10 秒超时；网络错误/API 错误返回 null（静默，不阻断 UI）。
 */
export async function queryDeepSeekBalance(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  signal?: AbortSignal,
): Promise<BalanceResult | null> {
  if (!apiKey || !isDeepSeekProvider(baseUrl)) return null
  const url = `${baseUrl!.replace(/\/$/, '')}/user/balance`
  try {
    const timeoutSignal = AbortSignal.timeout(10_000)
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: combinedSignal,
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      is_available?: boolean
      balance_infos?: Array<{ currency?: string; total_balance?: string }>
    }
    return {
      isAvailable: data.is_available ?? false,
      balances: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency ?? 'CNY',
        totalBalance: b.total_balance ?? '0',
      })),
    }
  } catch {
    return null
  }
}
