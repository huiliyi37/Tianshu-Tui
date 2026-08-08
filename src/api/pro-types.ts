/**
 * Pro 扩展点共享类型（公开仓）。
 *
 * 独立成文件以避免循环依赖：pro-registry.ts 与 factory.ts 都引用此处的
 * ProClientFactory——factory 三参调用、注册表三参声明，契约单一来源。
 */

import type { StreamClient } from './stream-client.js'
import type { ProviderConfig } from '../config/schema.js'
import type { ProviderCapabilities } from './provider.js'
import type { RuntimeParams } from './factory.js'

/** pro 模块注册的自定义 client 工厂；签名与 createProviderClient 对齐 */
export type ProClientFactory = (
  provider: ProviderConfig,
  capabilities: ProviderCapabilities,
  params: RuntimeParams,
) => StreamClient
