/**
 * Sidecar CORS 白名单——只反射已知 webview 来源。
 *
 * 通配 `*` 在 Bearer token 泄入网页可达上下文时会移除最后一道跨源刹车；
 * 未知 Origin 不发 CORS 头（浏览器默认拒绝跨源读）。非浏览器调用方
 * （Rust 桌面壳 / Node CLI）无 Origin 头，同样无 CORS 头。
 */

export const ALLOWED_CORS_ORIGINS: ReadonlySet<string> = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'http://localhost:5273',
])

/** 请求 Origin 在白名单内则返回原值（反射），否则 undefined（不下发 CORS 头）。 */
export function allowedCorsOrigin(reqHeaders: Record<string, string>): string | undefined {
  const origin = reqHeaders['origin']
  return origin && ALLOWED_CORS_ORIGINS.has(origin) ? origin : undefined
}
