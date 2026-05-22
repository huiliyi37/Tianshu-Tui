import type { OaiChatRequest } from './oai-types.js'
import type { StreamCallbacks } from './client.js'

/** Canonical streaming interface shared by all provider clients */
export interface StreamClient {
  stream(request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<void>
  /** Update reasoning effort at runtime (optional — not all providers support this) */
  setReasoningEffort?(effort: string): void
}
