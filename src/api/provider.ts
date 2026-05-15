import type { Usage } from './types.js'

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
}

export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: true,
  thinkingFormat: 'anthropic',
  supportsCacheControl: false,
  stripParams: ['top_k', 'metadata', 'service_tier', 'cache_control'],
  hasToolJsonInContentBug: true,
  effortFormat: 'none',
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsThinking: false,
  thinkingFormat: 'none',
  supportsCacheControl: true,
  stripParams: [],
  hasToolJsonInContentBug: false,
  effortFormat: 'none',
}
