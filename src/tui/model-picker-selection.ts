export function isCurrentModelSelection(
  provider: string,
  modelId: string,
  activeProvider: string | undefined,
  activeModelId: string | undefined,
): boolean {
  return provider === activeProvider && modelId === activeModelId
}
