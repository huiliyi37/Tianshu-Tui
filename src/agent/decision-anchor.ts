const DECISION_RE = /(?:I'll|I will|approach:|plan:|strategy:|方案是|我决定|决定采用|选择用)\s*([^.。]{15,100}?)(?=[.。]|$)/gi

export function extractDecisions(text: string): string[] {
  const decisions: string[] = []
  for (const match of text.matchAll(DECISION_RE)) {
    const decision = match[1]!.trim()
    if (decision.length >= 15) {
      decisions.push(decision)
      if (decisions.length >= 3) break
    }
  }
  return decisions
}
