import type { Usage } from './types.js'
import type { ProviderCapabilitiesConfig } from '../config/schema.js'

/**
 * Describes what a provider supports and how to adapt requests/responses.
 * Each provider (DeepSeek, OpenAI, Anthropic, etc.) provides one of these
 * so the shared ApiClient can handle differences without hardcoded branching.
 */
export interface ProviderCapabilities {
  /** Whether thinking mode (extended reasoning) is supported */
  supportsThinking: boolean
  /** How to format the thinking parameter in requests */
  thinkingFormat: 'anthropic' | 'openai' | 'none'
  /** Whether cache_control blocks are respected by the provider */
  supportsCacheControl: boolean
  /** Top-level request parameters to strip before sending */
  stripParams: string[]
  /** Whether the provider has a known bug where tool JSON appears in text content */
  hasToolJsonInContentBug: boolean
  /** How to format effort / reasoning control in requests */
  effortFormat: 'reasoning_effort' | 'output_config' | 'none'
  /** Optional: normalise raw usage fields into the standard Usage shape */
  mapUsage?: (raw: Record<string, unknown>) => Partial<Usage>
  /**
   * Prefix cache strategy for this provider.
   * - 'deepseek-native': DeepSeek's transparent exact-prefix caching (no cache_control needed)
   * - 'anthropic-cache-control': Anthropic-style explicit cache_control breakpoints
   * - 'none': No prefix caching; skip cache fingerprinting
   */
  prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'
}

/**
 * Map DeepSeek usage fields (both native and Anthropic-compatible formats)
 * into the standard Usage shape.
 */
export function mapDeepSeekUsage(raw: Record<string, unknown>): Usage {
  return {
    // Support both DeepSeek native format and Anthropic compatibility format
    input_tokens: (raw.prompt_tokens ?? raw.input_tokens ?? 0) as number,
    output_tokens: (raw.completion_tokens ?? raw.output_tokens ?? 0) as number,
    cache_read_input_tokens: (raw.prompt_cache_hit_tokens ?? raw.cache_read_input_tokens ?? (raw.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0) as number,
    cache_creation_input_tokens: (raw.prompt_cache_miss_tokens ?? raw.cache_creation_input_tokens ?? 0) as number,
  }
}

export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: true,
  thinkingFormat: 'anthropic',
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: true,
  effortFormat: 'reasoning_effort',
  prefixCacheStrategy: 'deepseek-native',
  mapUsage: mapDeepSeekUsage,
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: false,
  thinkingFormat: 'none',
  supportsCacheControl: true,
  stripParams: [],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
  prefixCacheStrategy: 'none',
}

/**
 * Well-known provider defaults.
 * New providers can be added here without code changes elsewhere.
 * Config-level capabilities override these defaults.
 */
export const WELL_KNOWN_DEFAULTS: Record<string, ProviderCapabilities> = {
  deepseek: DEEPSEEK_CAPABILITIES,
  kimi: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  },
  glm: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
  },
  minimax: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
  },
  mimo: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
  },
  'opencode-go': {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
    hasToolJsonInContentBug: false,
    effortFormat: 'none',
    prefixCacheStrategy: 'none',
  },
  openai: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: true,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  },
  codex: {
    supportsThinking: true,
    thinkingFormat: 'openai',
    supportsCacheControl: true,
    stripParams: [],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  },
  claude: {
    supportsThinking: true,
    thinkingFormat: 'anthropic',
    supportsCacheControl: false,
    stripParams: ['top_k', 'metadata', 'service_tier'],
    hasToolJsonInContentBug: false,
    effortFormat: 'reasoning_effort',
    prefixCacheStrategy: 'none',
  },
}

/**
 * Resolve capabilities for a provider by name, merged with optional
 * config-level overrides. Well-known defaults provide the base;
 * explicit config capabilities take precedence.
 */
export function resolveCapabilities(
  providerName: string,
  configOverrides?: ProviderCapabilitiesConfig,
): ProviderCapabilities {
  const base = WELL_KNOWN_DEFAULTS[providerName]
    ?? structuredClone(DEFAULT_CAPABILITIES)

  if (!configOverrides) return base

  // Merge config overrides — config values win over well-known defaults
  if (configOverrides.cacheControl !== undefined) {
    base.supportsCacheControl = configOverrides.cacheControl
  }
  if (configOverrides.stripParams.length > 0) {
    base.stripParams = configOverrides.stripParams
  }
  if (configOverrides.toolJsonBug !== undefined) {
    base.hasToolJsonInContentBug = configOverrides.toolJsonBug
  }
  if (configOverrides.prefixCache !== 'none') {
    base.prefixCacheStrategy = configOverrides.prefixCache
  }

  return base
}
