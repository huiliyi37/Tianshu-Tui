/**
 * Provider Registry — single source of truth for provider metadata.
 *
 * All well-known provider defaults live here. `provider.ts` retains
 * the `ProviderCapabilities` interface and `resolveCapabilities()`
 * function for backward compatibility.
 */

import { z } from 'zod'
import type { ProviderProfile } from './provider-profile.js'
import { getProviderProfile } from './provider-profile.js'
import type { ProviderCapabilities } from './provider.js'
import { WELL_KNOWN_DEFAULTS } from './provider.js'

// ─── Schema ──────────────────────────────────────────────────

export const providerEntrySchema = z.object({
  /** Provider key used in config (e.g. 'deepseek', 'openai') */
  key: z.string().min(1),
  /** Human-readable label */
  label: z.string().min(1),
  /** Provider capabilities */
  capabilities: z.object({
    supportsThinking: z.boolean(),
    thinkingFormat: z.enum(['anthropic', 'openai', 'none']),
    supportsCacheControl: z.boolean(),
    stripParams: z.array(z.string()),
    hasToolJsonInContentBug: z.boolean(),
    effortFormat: z.enum(['reasoning_effort', 'output_config', 'none']),
    prefixCacheStrategy: z.enum(['deepseek-native', 'anthropic-cache-control', 'none']),
  }),
  /** Cache profile (from provider-profile.ts) */
  cacheProfile: z.object({
    cacheType: z.enum(['exact-prefix', 'explicit-breakpoint', 'partial-prefix', 'block-kv', 'none']),
    persistent: z.boolean(),
    minCacheTokens: z.number().int().nonnegative(),
    cacheGranularity: z.number().int().positive().optional(),
    ttlSeconds: z.number().int().positive().optional(),
  }),
  /** Whether this provider has a usage mapping function */
  hasUsageMapping: z.boolean(),
  /** Known issues / notes */
  notes: z.array(z.string()).default([]),
})

export type ProviderEntry = z.infer<typeof providerEntrySchema>

// ─── Canonical Registry ──────────────────────────────────────

function buildEntry(
  key: string,
  label: string,
  caps: ProviderCapabilities,
  notes: string[] = [],
): ProviderEntry {
  const profile = getProviderProfile(key)
  return {
    key,
    label,
    capabilities: {
      supportsThinking: caps.supportsThinking,
      thinkingFormat: caps.thinkingFormat,
      supportsCacheControl: caps.supportsCacheControl,
      stripParams: [...caps.stripParams],
      hasToolJsonInContentBug: caps.hasToolJsonInContentBug,
      effortFormat: caps.effortFormat,
      prefixCacheStrategy: caps.prefixCacheStrategy,
    },
    cacheProfile: {
      cacheType: profile.cacheType,
      persistent: profile.persistent,
      minCacheTokens: profile.minCacheTokens,
      cacheGranularity: profile.cacheGranularity,
      ttlSeconds: profile.ttlSeconds,
    },
    hasUsageMapping: caps.mapUsage !== undefined,
    notes,
  }
}

/** Canonical provider registry. Add new providers here. */
export const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  deepseek: buildEntry('deepseek', 'DeepSeek', WELL_KNOWN_DEFAULTS['deepseek']!, [
    'Exact-prefix cache: first 2 messages must remain stable for 99% hit rate',
    'Anthropic-compatible thinking format',
  ]),
  kimi: buildEntry('kimi', 'Kimi (Moonshot)', WELL_KNOWN_DEFAULTS['kimi']!, [
    'Anthropic-compatible thinking format',
    'No prefix cache support',
  ]),
  glm: buildEntry('glm', 'GLM (Zhipu)', WELL_KNOWN_DEFAULTS['glm']!, [
    'OpenAI-compatible protocol via /api/paas/v4',
    'OpenAI-compatible thinking format',
  ]),
  minimax: buildEntry('minimax', 'MiniMax', WELL_KNOWN_DEFAULTS['minimax']!, [
    'MiniMax-M3: 1M context, multimodal (image/video)',
    'Uses max_completion_tokens instead of max_tokens',
    'reasoning_split for separated thinking output',
    'No prefix cache support',
  ]),
  mimo: buildEntry('mimo', 'Mimo', WELL_KNOWN_DEFAULTS['mimo']!, [
    'OpenAI-compatible thinking format',
    'No thinking effort control',
    'No cache support',
  ]),
  'opencode-go': buildEntry('opencode-go', 'OpenCode Go', WELL_KNOWN_DEFAULTS['opencode-go']!, [
    'OpenAI-compatible thinking format',
    'No thinking effort control',
    'No cache support',
  ]),
  openai: buildEntry('openai', 'OpenAI', WELL_KNOWN_DEFAULTS['openai']!, [
    'Partial-prefix cache with 128-token granularity',
    'Ephemeral cache (5 min TTL)',
  ]),
  codex: buildEntry('codex', 'Codex', WELL_KNOWN_DEFAULTS['codex']!, [
    'Uses Codex Responses API with OAuth authentication',
    'Partial-prefix cache profile is provided by provider-profile.ts',
  ]),
}

// ─── Lookup Functions ────────────────────────────────────────

export function getProviderEntry(key: string): ProviderEntry | undefined {
  return PROVIDER_REGISTRY[key]
}

export function listProviders(): ProviderEntry[] {
  return Object.values(PROVIDER_REGISTRY)
}

export function isKnownProvider(key: string): boolean {
  return key in PROVIDER_REGISTRY
}

export function addProviderEntry(
  key: string,
  label: string,
  capabilities: ProviderCapabilities,
  notes?: string[],
): ProviderEntry {
  const entry = buildEntry(key, label, capabilities, notes)
  // Mutate in place — registry is mutable to support runtime registration
  ;(PROVIDER_REGISTRY as Record<string, ProviderEntry>)[key] = entry
  return entry
}
