/**
 * 议事会 runtime kill switch（仿 star-soul-gate）。
 *
 * 默认开启。设 `COUNCIL=0` 或 `COUNCIL=false` 急停议事会工具（不再扇出席位）。
 * 这不是 A/B 实验开关 —— 是紧急熔断。
 */

const ENV_KEY = 'COUNCIL'

export function isCouncilEnabled(): boolean {
  const val = process.env[ENV_KEY]
  if (val === undefined) return true
  return val !== '0' && val.toLowerCase() !== 'false'
}
