import type { Config } from '../../config/schema.js'
import type { WebFetchOptions } from './tool.js'

export function buildFetchOptions(config: Config): WebFetchOptions {
  return {
    timeoutMs: config.fetch.timeoutMs,
    maxResponseBytes: config.fetch.maxResponseBytes,
    maxRedirects: config.fetch.maxRedirects,
    userAgent: config.fetch.userAgent,
    extractMainContent: config.fetch.extractMainContent,
    proxy: {
      ...(config.network.proxy ? { proxyUrl: config.network.proxy } : {}),
      ...(config.network.noProxy ? { noProxy: config.network.noProxy } : {}),
    },
  }
}
