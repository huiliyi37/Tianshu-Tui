export type AlchemyStage = 'nigredo' | 'albedo' | 'citrinitas' | 'rubedo'

export function alchemyStage(confidence: number): AlchemyStage {
  if (confidence >= 0.8) return 'rubedo'
  if (confidence >= 0.5) return 'citrinitas'
  if (confidence >= 0.3) return 'albedo'
  return 'nigredo'
}

export const ALCHEMY_COLORS: Record<AlchemyStage, string> = {
  nigredo: 'gray',
  albedo: 'white',
  citrinitas: 'yellow',
  rubedo: 'red',
}

export function alchemyBar(confidence: number): string {
  const stage = alchemyStage(confidence)
  switch (stage) {
    case 'nigredo': return '░░░░'
    case 'albedo': return '▓░░░'
    case 'citrinitas': return '██▓░'
    case 'rubedo': return '████'
  }
}
