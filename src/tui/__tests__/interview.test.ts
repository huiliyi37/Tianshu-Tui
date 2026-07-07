import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const INTERVIEW_MARKER_RE = /<!-- interview:(\{[^}]+\}) -->/

function parseInterviewMarker(text: string): { state: InterviewState; cleanText: string } | null {
  const match = text.match(INTERVIEW_MARKER_RE)
  if (!match) return null
  try {
    const raw = JSON.parse(match[1]!)
    const clarity = Math.max(0, Math.min(1, typeof raw.clarity === 'number' ? raw.clarity : 0))
    const state: InterviewState = {
      intent: String(raw.intent ?? ''),
      clarity,
      round: Number(raw.round ?? 0),
      maxRounds: Number(raw.maxRounds ?? 5),
      tokensUsed: Number(raw.tokensUsed ?? 0),
      confirmed: clarity >= 0.8,
    }
    const cleanText = text.replace(INTERVIEW_MARKER_RE, '').trimEnd()
    return { state, cleanText }
  } catch {
    return null
  }
}

interface InterviewState {
  intent: string
  clarity: number
  round: number
  maxRounds: number
  tokensUsed: number
  confirmed: boolean
}

function clarityColor(clarity: number): string {
  if (clarity < 0.4) return 'red'
  if (clarity < 0.7) return 'yellow'
  return 'green'
}

function clarityTrend(history: number[]): string {
  if (history.length < 2) return '─'
  const prev = history[history.length - 2]!
  const curr = history[history.length - 1]!
  if (curr > prev + 0.05) return '▲'
  if (curr < prev - 0.05) return '▼'
  return '─'
}

function formatTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

describe('Interview marker parsing', () => {
  it('parses valid interview marker', () => {
    const text = 'Here is my question for you.<!-- interview:{"intent":"add notifications","clarity":0.5,"round":2,"maxRounds":5,"tokensUsed":1200} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.intent, 'add notifications')
    assert.equal(result.state.clarity, 0.5)
    assert.equal(result.state.round, 2)
    assert.equal(result.state.maxRounds, 5)
    assert.equal(result.state.tokensUsed, 1200)
    assert.equal(result.state.confirmed, false)
    assert.equal(result.cleanText, 'Here is my question for you.')
  })

  it('parses confirmed interview (clarity >= 0.8)', () => {
    const text = 'Summary here.<!-- interview:{"intent":"api endpoint","clarity":0.9,"round":4} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.confirmed, true)
  })

  it('returns null for text without marker', () => {
    const result = parseInterviewMarker('Just regular text')
    assert.equal(result, null)
  })

  it('returns null for malformed marker', () => {
    const result = parseInterviewMarker('<!-- interview:{bad json} -->')
    assert.equal(result, null)
  })

  it('clamps clarity to 0-1 range', () => {
    const text = '<!-- interview:{"intent":"test","clarity":1.5} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.clarity, 1)
  })

  it('clamps negative clarity to 0', () => {
    const text = '<!-- interview:{"intent":"test","clarity":-0.3} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.clarity, 0)
  })

  it('uses defaults for missing fields', () => {
    const text = '<!-- interview:{"intent":"test","clarity":0.3} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.round, 0)
    assert.equal(result.state.maxRounds, 5)
    assert.equal(result.state.tokensUsed, 0)
  })
})

describe('Interview clarity colors', () => {
  it('returns red for low clarity', () => {
    assert.equal(clarityColor(0.1), 'red')
    assert.equal(clarityColor(0.3), 'red')
  })

  it('returns yellow for medium clarity', () => {
    assert.equal(clarityColor(0.4), 'yellow')
    assert.equal(clarityColor(0.6), 'yellow')
  })

  it('returns green for high clarity', () => {
    assert.equal(clarityColor(0.7), 'green')
    assert.equal(clarityColor(0.9), 'green')
  })
})

describe('Interview clarity trend', () => {
  it('returns flat for single value', () => {
    assert.equal(clarityTrend([0.3]), '─')
  })

  it('returns up arrow for increasing clarity', () => {
    assert.equal(clarityTrend([0.3, 0.5]), '▲')
  })

  it('returns down arrow for decreasing clarity', () => {
    assert.equal(clarityTrend([0.7, 0.4]), '▼')
  })

  it('returns flat for small changes', () => {
    assert.equal(clarityTrend([0.5, 0.52]), '─')
  })
})

describe('Interview token formatting', () => {
  it('formats tokens under 1k as-is', () => {
    assert.equal(formatTok(500), '500')
  })

  it('formats tokens over 1k with k suffix', () => {
    assert.equal(formatTok(2100), '2.1k')
    assert.equal(formatTok(1000), '1.0k')
  })
})

describe('Interview confirmed detection', () => {
  it('confirmed is true at exactly 0.8', () => {
    const text = '<!-- interview:{"intent":"test","clarity":0.8} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.confirmed, true)
  })

  it('confirmed is false below 0.8', () => {
    const text = '<!-- interview:{"intent":"test","clarity":0.79} -->'
    const result = parseInterviewMarker(text)
    assert.ok(result)
    assert.equal(result.state.confirmed, false)
  })
})
