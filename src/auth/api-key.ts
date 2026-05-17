import type { AuthProvider } from './types.js'

export class ApiKeyAuth implements AuthProvider {
  constructor(private key: string) {}

  async getHeaders(): Promise<Record<string, string>> {
    return { 'Authorization': `Bearer ${this.key}` }
  }

  isAuthenticated(): boolean {
    return this.key.length > 0
  }

  async authenticate(): Promise<void> {}

  dispose(): void {}
}
