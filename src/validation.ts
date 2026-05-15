const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

export function assertValidSessionId(id: string): void {
  if (!isValidSessionId(id)) throw new Error(`Invalid sessionId: ${id}`)
}
