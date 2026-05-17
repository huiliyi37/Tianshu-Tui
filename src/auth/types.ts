export interface AuthProvider {
  /** Return HTTP headers needed for authentication */
  getHeaders(): Promise<Record<string, string>>
  /** Whether the provider currently has valid credentials */
  isAuthenticated(): boolean
  /** Trigger interactive authentication (OAuth browser flow / prompt for key) */
  authenticate(): Promise<void>
  /** Clean up resources (HTTP servers, timers, etc.) */
  dispose(): void
}
