/**
 * 证据防火墙 Phase 2 开关。
 *
 * 开启方式（env 优先于 config）：
 *   - 环境变量：RIVET_SCOUT_FIREWALL=1（同时接受 true/on/yes）；=0/false/off/no 强制关
 *   - config.json：agent.scoutEvidenceFirewall = true
 * 默认关闭：关闭时 deliver 报告轮仍有警示行 + hook 软提醒兜底，只是不 isError 硬拦。
 *
 * 双通道动机（同 security-guidance-config）：env 适合终端用户和 CI 临时覆盖；
 * config 是桌面端唯一可行的通道——GUI 启动的 sidecar 继承不到 shell 环境变量。
 */

/**
 * 证据防火墙是否启用。
 *
 * @param configValue config.json 的 `agent.scoutEvidenceFirewall`。undefined =
 *   调用方没有 config 上下文（如独立装配的测试），按默认关处理。
 */
export function isScoutFirewallEnabled(configValue?: boolean): boolean {
  const env = process.env.RIVET_SCOUT_FIREWALL
  if (env !== undefined) {
    if (env === '1' || env === 'true' || env === 'on' || env === 'yes') return true
    if (env === '0' || env === 'false' || env === 'off' || env === 'no') return false
  }
  return configValue ?? false
}
