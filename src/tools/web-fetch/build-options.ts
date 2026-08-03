import type { Config } from '../../config/schema.js'
import type { WebFetchOptions } from './tool.js'

export function buildFetchOptions(config: Config): WebFetchOptions {
  // 桌面端 sidecar 打包了 chromium，启动时设 RIVET_FETCH_PLAYWRIGHT=1 强制开启
  const playwrightEnv = process.env.RIVET_FETCH_PLAYWRIGHT
  return {
    timeoutMs: config.fetch.timeoutMs,
    maxResponseBytes: config.fetch.maxResponseBytes,
    maxRedirects: config.fetch.maxRedirects,
    userAgent: config.fetch.userAgent,
    extractMainContent: config.fetch.extractMainContent,
    enablePlaywright:
      config.fetch.enablePlaywright || playwrightEnv === '1' || playwrightEnv === 'true',
    renderTimeoutMs: config.fetch.renderTimeoutMs,
    // 选项联动集中在此层（firecrawl zod refine 链同款）：等待超过超时一半会
    // 挤压导航与内容提取预算，直接钳制而非报错
    renderWaitMs: Math.min(config.fetch.renderWaitMs, Math.floor(config.fetch.renderTimeoutMs / 2)),
    cacheMaxAgeMs: config.fetch.cacheMaxAgeMs,
    jinaBaseUrl: config.fetch.jinaBaseUrl,
    proxy: {
      ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
      ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
    },
  }
}
