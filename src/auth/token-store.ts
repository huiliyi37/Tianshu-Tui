import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface TokenData {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  accountId?: string
}

export class TokenStore {
  private filePath: string

  constructor(private baseDir: string, private provider: string) {
    this.filePath = join(baseDir, `${provider}.json`)
  }

  load(): TokenData | null {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      return JSON.parse(raw) as TokenData
    } catch {
      return null
    }
  }

  save(data: TokenData): void {
    mkdirSync(this.baseDir, { recursive: true })
    const tmpPath = `${this.filePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(tmpPath, this.filePath)
  }

  clear(): void {
    try { unlinkSync(this.filePath) } catch {}
  }
}
