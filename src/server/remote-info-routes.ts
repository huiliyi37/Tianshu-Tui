/**
 * GET /remote/info — 远程访问信息（P1 Mobile Remote）。
 *
 * 桌面「远程访问」设置区块的数据源 + 手机连通自检端点。返回监听模式
 * （loopback/lan）、监听地址、本机局域网 IPv4 列表。Bearer 门控。
 *
 * 设计取舍：不返回端口——调用方必知自身请求端口（桌面端另有
 * RuntimeInfo.port），测试注入 port 0 时回显 0 反而误导。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { networkInterfaces } from 'node:os'

export interface RemoteInfoOptions {
  /** 实际绑定地址（startServer opts.host 同源）。 */
  host: string
  /** Host allowlist（有配置时随响应返回，供 UI 显示收紧状态）。 */
  allowedHosts?: string[]
}

export function buildRemoteInfoRoutes(apiToken?: string, opts?: RemoteInfoOptions): Record<string, RouteHandler> {
  const host = opts?.host.trim().toLowerCase() ?? '127.0.0.1'
  const lanMode = !(host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '::')
  return {
    'GET /remote/info': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      const lanUrls: Array<{ name: string; address: string }> = []
      for (const [name, addrs] of Object.entries(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) {
            lanUrls.push({ name, address: a.address })
          }
        }
      }
      return {
        status: 200,
        body: {
          mode: lanMode ? 'lan' : 'loopback',
          listenHost: opts?.host ?? '127.0.0.1',
          lanUrls,
          ...(opts?.allowedHosts && opts.allowedHosts.length > 0 ? { allowedHosts: opts.allowedHosts } : {}),
        },
      }
    },
  }
}
