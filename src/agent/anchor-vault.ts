import { sanitizeForIntentClassification } from './intent-sanitizer.js'

export interface SealedAnchor {
  phrases: string[]
  original: string
  sealedAt: number
}

// Stopwords to exclude from anchor extraction
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'are', 'was',
  'will', 'can', 'not', 'but', 'all', 'been', 'would', 'could', 'should',
  '的', '了', '是', '在', '和', '要', '我', '你', '他', '她', '它',
  '们', '这', '那', '有', '也', '就', '都', '把', '被', '让', '给',
  '帮我', '帮', '请', '能', '会', '到', '个', '上', '下',
])

export class AnchorVault {
  seal(userMessage: string): SealedAnchor {
    const { sanitized } = sanitizeForIntentClassification(userMessage)
    const identifiers = sanitized.match(/[a-zA-Z_][a-zA-Z0-9_]{2,}/g) ?? []
    const cjkTerms = sanitized.match(/[一-鿿]{2,6}/g) ?? []
    const all = [...identifiers, ...cjkTerms]
      .filter(t => !STOPWORDS.has(t.toLowerCase()))
    const phrases = [...new Set(all)]
    return { phrases, original: userMessage, sealedAt: Date.now() }
  }

  strip(context: string, sealed: SealedAnchor): string {
    let result = context
    for (const phrase of sealed.phrases) {
      result = result.replaceAll(phrase, '')
    }
    return result.replace(/ {2,}/g, ' ').trim()
  }

  unseal(sealed: SealedAnchor): string[] {
    return sealed.phrases
  }
}
