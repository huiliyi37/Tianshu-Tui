/**
 * GET /cache/usage?days=&scope=&cwd= — 跨会话缓存用量聚合（桌面端缓存面板数据源）。
 *
 * 桌面端跑在 webview 里，读不到 `~/.rivet/sessions/**\/cache-log.jsonl`；这条路由
 * 把 [usage-aggregator](../cache/usage-aggregator.ts) 包一层给它。定价从当前配置的
 * provider 查（与 TUI 同源），因此成本/节省口径两端一致。
 *
 * scope=project（默认）只看指定 cwd 的项目 slug 目录；scope=all 扫全部项目。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { sessionsDir } from '../config/paths.js'
import { aggregateCacheUsage } from '../cache/usage-aggregator.js'
import { loadConfig } from '../config/manager.js'
import { findModelPricing } from '../utils/pricing.js'

const MAX_DAYS = 90

export interface CacheRoutesDeps {
  apiToken?: string
  /** 默认项目目录（scope=project 且未传 cwd 时使用） */
  defaultCwd: () => string
}

function parseDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return 30
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(MAX_DAYS, Math.ceil(n))
}

export function buildCacheRoutes(deps: CacheRoutesDeps): Record<string, RouteHandler> {
  return {
    'GET /cache/usage': async (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, deps.apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const days = parseDays(params?.days)
      if (days === null) return { status: 400, body: { error: 'days must be a positive number' } }

      const scope = params?.scope === 'all' ? 'all' : 'project'
      const cwd = typeof params?.cwd === 'string' && params.cwd ? params.cwd : deps.defaultCwd()
      const sessionsRoot = scope === 'all' ? sessionsDir() : sessionsDir(cwd)

      // 定价按「provider 配置里能查到的模型」解析——查不到的模型只报 token，
      // 不硬造成本数字（cost/savings 落 0），避免把未定价模型算成免费误导用户。
      const cfg = loadConfig()
      const providers = cfg.provider.providers
      const providerName = cfg.provider.default

      try {
        const aggregate = await aggregateCacheUsage({
          sessionsRoot,
          days,
          // 行级 provider（T3）优先——spark 与官方同 model 不同价时各按各价；
          // 旧行无 provider 回退默认 provider（原行为）。
          resolvePricing: (model, provider) => findModelPricing(providers, provider ?? providerName, model),
        })
        // 回看天数只由 aggregate.windowDays 表达——`days` 在 aggregate 里是按天
        // 明细数组，再加一个同名标量会被 spread 覆盖成数组，两种含义撞车。
        return { status: 200, body: { scope, sessionsRoot, ...aggregate } }
      } catch (err) {
        return { status: 500, body: { error: (err as Error).message } }
      }
    },
  }
}
