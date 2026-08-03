import type { Tool, ToolCallParams } from '../types.js'
import { SSRFError } from '../net/ssrf.js'
import type { HttpFetchOptions } from '../net/http-fetch.js'
import { MIN_SUBSTANTIAL_LENGTH } from './extract.js'
import { fetchViaPlaywright, type RenderFetchResult } from './render-fetch.js'
import { parseRenderActions, type RenderAction } from './render-actions.js'
import { formatCacheAge } from './fetch-cache.js'
import { fetchMarkdown, type FetchCoreDeps } from './fetch-core.js'

export interface FetchDeps extends FetchCoreDeps {}
export interface WebFetchOptions extends HttpFetchOptions {
  extractMainContent?: boolean
  /** 本地 Playwright 渲染 SPA 降级层（默认关；需 chromium 可用，桌面端内置）。 */
  enablePlaywright?: boolean
  /** 渲染超时（默认 30s，独立于请求超时）。 */
  renderTimeoutMs?: number
  /** 渲染后额外等待（默认 0，SPA 水合用）。 */
  renderWaitMs?: number
  /** 缓存读取有效期（默认 2 天；0 = 禁读仍写）。 */
  cacheMaxAgeMs?: number
  /** Jina Reader 基础地址（默认 https://r.jina.ai；国内可填自建反代）。 */
  jinaBaseUrl?: string
}

/** actions 直达渲染路径的输出组装：动作摘要进 via，execute_js 返回与失败警告附尾部。 */
function formatRenderedOutput(rawUrl: string, rendered: RenderFetchResult): string {
  const results = rendered.actionResults ?? []
  const failedIdx = results.findIndex((r) => !r.ok)
  const note = results.length > 0
    ? `，${results.length} 个动作${failedIdx >= 0 ? `，第 ${failedIdx + 1} 步失败` : ''}`
    : ''
  let out = `URL：${rawUrl}\n状态：本地渲染\n内容长度：${rendered.markdown.length}（经 Playwright 渲染${note}）\n\n${rendered.markdown}`
  const jsResults = results.filter((r) => r.type === 'execute_js' && r.ok && r.detail)
  if (jsResults.length > 0) {
    out += `\n\n---\nexecute_js 返回：\n${jsResults.map((r, i) => `[${i + 1}] ${r.detail}`).join('\n')}`
  }
  if (failedIdx >= 0) {
    const failed = results[failedIdx]!
    out += `\n\n⚠ 动作第 ${failedIdx + 1} 步（${failed.type}）失败：${failed.detail}——以上为先前已渲染的页面内容`
  }
  return out
}

const defaultDeps: FetchDeps = {}

export function createWebFetchTool(deps: FetchDeps = defaultDeps, opts: WebFetchOptions = {}): Tool {
  const extractMainContentEnabled = opts.extractMainContent ?? true

  // actions 直达渲染用的闭包（带动作参数）；常规降级链由 fetch-core 内核驱动。
  const renderFetchWithActions =
    deps.renderFetch ??
    (opts.enablePlaywright
      ? (url: string, actions?: RenderAction[]) =>
          fetchViaPlaywright(url, {
            timeoutMs: opts.renderTimeoutMs,
            waitMs: opts.renderWaitMs,
            actions,
            lookup: deps.lookup,
            extractMainContent: extractMainContentEnabled,
          })
      : undefined)

  return {
    definition: {
      name: 'web_fetch',
      description: `抓取 URL 内容并以文本返回。适合阅读文档、API 参考或 issue 页面。
		返回转换为纯文本的页面内容（已剥离 HTML 标签）。内容截断至约 50K 字符。
		本地提取质量差时自动用本地浏览器渲染（SPA 页面）或 Jina Reader 兜底；重复抓取走缓存。
		可选 actions：在渲染页面中按序交互（点击/输入/滚动/等待/执行 JS），用于登录墙、无限滚动、Tab 内容——需启用 Playwright。
		因发起网络请求，需要用户审批。`,
      input_schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的 URL',
          },
          actions: {
            type: 'array',
            description: '渲染后按序执行的交互动作（≤50 步，wait 总时长 ≤60s）。仅 Playwright 渲染可用时生效。',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['wait', 'click', 'write', 'press', 'scroll', 'execute_js'] },
                ms: { type: 'number', description: 'wait：等待毫秒数' },
                selector: { type: 'string', description: '目标元素 CSS 选择器（wait/click/write/press/scroll）' },
                all: { type: 'boolean', description: 'click：点击所有匹配元素（默认 false 只点第一个）' },
                text: { type: 'string', description: 'write：要填入的文本' },
                key: { type: 'string', description: 'press：按键名（如 Enter/Tab/Escape）' },
                direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'scroll：滚动方向（默认 down）' },
                script: { type: 'string', description: 'execute_js：在页面上下文执行的 JS 表达式，返回值随结果返回' },
              },
              required: ['type'],
            },
          },
        },
        required: ['url'],
      },
    },

    async execute(params: ToolCallParams) {
      const rawUrl = params.input.url as string

      // actions 校验（≤50 步、wait 总长 ≤60s）——任何一步非法整体拒绝，不启动渲染
      let actions: RenderAction[] | undefined
      if (params.input.actions !== undefined) {
        const parsed = parseRenderActions(params.input.actions)
        if ('error' in parsed) {
          return { content: `actions 校验失败：${parsed.error}`, isError: true }
        }
        actions = parsed.actions
      }

      // 动作序列只能跑在渲染路径——跳过直连/turndown 层，直达渲染；禁读禁写缓存
      if (actions !== undefined) {
        if (!renderFetchWithActions) {
          return {
            content: `actions 需要启用 Playwright 渲染（config fetch.enablePlaywright，或桌面端内置 chromium）。`,
            isError: true,
          }
        }
        try {
          const rendered = await renderFetchWithActions(rawUrl, actions)
          if (!rendered || rendered.markdown.trim().length < MIN_SUBSTANTIAL_LENGTH) {
            return { content: `渲染失败或动作后内容过薄：${rawUrl}`, isError: true }
          }
          return { content: formatRenderedOutput(rawUrl, rendered) }
        } catch (err) {
          if (err instanceof SSRFError) {
            return { content: err.message, isError: true }
          }
          const message = err instanceof Error ? err.message : String(err)
          return { content: `渲染失败 ${rawUrl}：${message}`, isError: true }
        }
      }

      // 常规路径：共享内核（缓存 → 直连 → 渲染 → Jina）
      const outcome = await fetchMarkdown(rawUrl, deps, { ...opts, cwd: params.cwd })
      if (!outcome.ok) {
        return {
          content: outcome.error,
          isError: true,
          ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
        }
      }
      const header = outcome.fromCache
        ? `URL：${rawUrl}\n状态：${outcome.status}（缓存，${formatCacheAge(outcome.fetchedAt!)}前抓取${outcome.via}）\n内容长度：${outcome.markdown.length}`
        : `URL：${rawUrl}\n状态：${outcome.status}\n内容长度：${outcome.rawBytes}${outcome.via}`
      return { content: `${header}\n\n${outcome.markdown}` }
    },

    requiresApproval: () => true,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

export const WEB_FETCH_TOOL: Tool = createWebFetchTool()
