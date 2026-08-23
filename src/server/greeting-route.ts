/**
 * GET /greeting — 桌面端欢迎页动态问候语（算法模板 + flash LLM 混合）。
 *
 * Auth-gated（和 /sessions 同级），返回一句贴合当前时段的中文问候语。
 * 算法模板即时返回；flash LLM 结果缓存当天，跨天自动失效。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { serverLogger } from './logger.js'

// ── 算法模板池（服务端兜底）───────────────────────────────────────────────

const TEMPLATES: Record<string, string[]> = {
  morning: [
    '上午好，准备开启什么新任务？',
    '早啊，代码在等你',
    '上午好，今天从哪开始？',
    '早安，一杯咖啡一行代码',
    '上午好，思路清晰的时候最适合开工',
    '早，今天有什么计划？',
    '上午好呀，新的一天新的代码',
    '早安，先跑个测试热热身',
  ],
  noon: [
    '中午好呀，要不要先休息一下',
    '午安，吃饱了才有力气 debug',
    '中午了，起来走动一下吧',
    '午休时间到，代码不会跑的',
    '中午好，眯一会儿下午更清醒',
  ],
  afternoon: [
    '下午好，今天想规划点什么？',
    '下午好，午后的效率最高',
    '下午了，继续冲刺吧',
    '下午好，要不要 review 一下上午的代码',
    '下午好，还有半天可以大干一场',
    '午后阳光正好，写代码正合适',
    '下午好，今天进度怎么样？',
  ],
  evening: [
    '晚上好，整理一下今天的代码库吧',
    '晚上了，总结一下今天的成果',
    '晚上好，夜深人静写代码最专注',
    '晚上好，要不要提交今天的改动',
    '入夜了，测试跑完了吗',
    '晚上好，这时候写代码最有感觉',
    '晚上好，今天的 commit 整理了吗',
    '夜色降临，最好的 debug 时间到了',
  ],
  night: [
    '夜深了，注意休息',
    '凌晨了，明天再战吧',
    '夜深了，代码不会跑，身体要紧',
    '这么晚了还在写代码，记得早点休息',
    '深夜了，保存一下明天继续',
    '夜深人静，但也该休息了',
    '凌晨好，你是夜猫子型开发者吗',
    '夜深了，该和代码说晚安了',
  ],
}

function timeSlot(hour: number): string {
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 14) return 'noon'
  if (hour >= 14 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

function weekdayName(date: Date, locale: string): string {
  const weekdays = locale === 'zh-CN'
    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return weekdays[date.getDay()]!
}

function pickTemplate(hour: number): string {
  const slot = timeSlot(hour)
  const pool = TEMPLATES[slot] ?? TEMPLATES.morning!
  return pool[Math.floor(Math.random() * pool.length)]!
}

// ── 内存缓存（sidecar 生命周期内有效，跨天自动失效）────────────────────

const llmCache = new Map<string, { greeting: string; date: string }>()

function cacheKey(hour: number, locale: string): string {
  const now = new Date()
  const beijingDate = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
  return `${beijingDate}:${timeSlot(hour)}:${locale}`
}

// ── LLM 调用 ─────────────────────────────────────────────────────────────

const GREETING_TIMEOUT_MS = 3_000

interface GreetingResponse {
  greeting: string
  source: 'algorithm' | 'llm'
  cached?: boolean
}

async function llmGreeting(
  hour: number,
  locale: string,
  baseUrl: string,
  apiKey: string,
  model: string,
): Promise<string | null> {
  const slot = timeSlot(hour)
  const slotLabel: Record<string, string> = {
    morning: '上午', noon: '中午', afternoon: '下午', evening: '晚上', night: '深夜',
  }
  const now = new Date()
  const wd = weekdayName(now, locale)

  const systemPrompt = `你是天枢桌面终端的欢迎助手。当前是${wd}${slotLabel[slot] ?? ''}${hour}点左右。请用中文生成一句温暖、有人文关怀的问候语送给开发者。不超过25字。不要加称呼（如"亲爱的"）、不要感叹号堆砌、不要emoji。`

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请给出一句问候语。' },
    ],
    max_tokens: 64,
    temperature: 0.9,
    stream: false,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GREETING_TIMEOUT_MS)

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content?.trim()
    return text && text.length > 0 && text.length <= 50 ? text : null
  } catch (err) {
    serverLogger.warn('greeting LLM fetch failed', { error: String(err) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ── Route builder ────────────────────────────────────────────────────────

export function buildGreetingRoute(
  baseUrl: string,
  apiKey: string,
  getConfig?: () => { enabled: boolean; model: string },
  apiToken?: string,
): Record<string, RouteHandler> {
  const DEFAULT_MODEL = 'deepseek-v4-flash'
  const greetingHandler: RouteHandler = async (_body, params, _headers): Promise<{ status: number; body: GreetingResponse }> => {
      const hour = Number(params?.hour)
      const locale = params?.locale ?? 'zh-CN'

      if (isNaN(hour) || hour < 0 || hour > 23) {
        return { status: 200, body: { greeting: pickTemplate(new Date().getHours()), source: 'algorithm' } }
      }

      const greetingConfig = getConfig?.() ?? { enabled: true, model: DEFAULT_MODEL }

      // 有 API key 且 greeting LLM 已启用才走 LLM 路径
      if (apiKey && greetingConfig.enabled) {
        const ck = cacheKey(hour, locale)
        const cached = llmCache.get(ck)
        if (cached) {
          return { status: 200, body: { greeting: cached.greeting, source: 'llm', cached: true } }
        }

        try {
          const llmResult = await llmGreeting(hour, locale, baseUrl, apiKey, greetingConfig.model)
          if (llmResult) {
            const now = new Date()
            const beijingDate = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
            llmCache.set(ck, { greeting: llmResult, date: beijingDate })
            return { status: 200, body: { greeting: llmResult, source: 'llm' } }
          }
        } catch (err) {
          serverLogger.warn('greeting LLM call failed, falling back to template', {
            error: String(err),
          })
        }
      }

      // fallback: 算法模板
      return { status: 200, body: { greeting: pickTemplate(hour), source: 'algorithm' } }
    }
  // 路由级鉴权（防御纵深，同 speech-routes）——未传 token 的直连消费方保持原行为。
  if (!apiToken) return { 'GET /greeting': greetingHandler }
  return {
    'GET /greeting': async (body, params, headers, res) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      return greetingHandler(body, params, headers, res)
    },
  }
}
