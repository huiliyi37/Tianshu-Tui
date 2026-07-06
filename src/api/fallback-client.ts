/**
 * FallbackStreamClient — wraps a primary StreamClient and tries fallback
 * providers when the primary exhausts all retries. Each fallback provider
 * is lazy-initialized on first use to avoid wasted allocations.
 */

import type { StreamClient, StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest } from './oai-types.js'
import { classifyApiError } from './error-classifier.js'

export interface FallbackEntry {
  name: string
  create: () => StreamClient
}

export class FallbackStreamClient implements StreamClient {
  private activeClient: StreamClient
  private activeName: string
  private readonly fallbacks: FallbackEntry[]
  private readonly onFallback?: (from: string, to: string, error: unknown) => void

  constructor(
    primary: StreamClient,
    primaryName: string,
    fallbacks: FallbackEntry[],
    onFallback?: (from: string, to: string, error: unknown) => void,
  ) {
    this.activeClient = primary
    this.activeName = primaryName
    this.fallbacks = fallbacks
    this.onFallback = onFallback
  }

  setReasoningEffort(effort: string): void {
    this.activeClient.setReasoningEffort?.(effort)
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.activeClient.setThinking?.(mode)
  }

  consumeWireDivergence(): import('./stream-client.js').WireDivergence | null {
    return this.activeClient.consumeWireDivergence?.() ?? null
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: unknown
    const tried = [this.activeName]

    try {
      await this.activeClient.stream(request, callbacks, signal)
      return
    } catch (err) {
      lastError = err
      if (signal?.aborted) throw err

      const classified = classifyApiError(err)
      if (!this.shouldFallback(classified.category)) throw err
    }

    for (const entry of this.fallbacks) {
      if (signal?.aborted) break
      tried.push(entry.name)

      try {
        const fallbackClient = entry.create()
        this.onFallback?.(this.activeName, entry.name, lastError)
        this.activeClient = fallbackClient
        this.activeName = entry.name
        await fallbackClient.stream(request, callbacks, signal)
        return
      } catch (err) {
        lastError = err
        if (signal?.aborted) throw err

        const classified = classifyApiError(err)
        if (!this.shouldFallback(classified.category)) throw err
      }
    }

    throw lastError
  }

  private shouldFallback(category: string): boolean {
    const fallbackCategories = new Set([
      'rate_limit', 'server_error', 'overloaded',
      'timeout', 'connection_error', 'stream_error',
    ])
    return fallbackCategories.has(category)
  }
}
