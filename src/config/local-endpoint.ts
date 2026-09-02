/**
 * 本机回环端点判定——自定义 provider 无密钥材料时区分 keyless 本地端点
 * （ollama 等）与忘配 key 的云端端点（必须 fail-closed）。
 *
 * http(s) 指向本机回环才视为 keyless；非法/缺失 URL 一律 fail-closed
 * （不豁免）。
 */
export function isLoopbackBaseUrl(baseUrl?: string): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0'
  } catch {
    return false
  }
}
