export interface ApprovalResult {
  approved: boolean
  editedInput?: Record<string, unknown>
}

export function applyApprovalEdit(
  originalInput: Record<string, unknown>,
  result: ApprovalResult,
): Record<string, unknown> | null {
  if (!result.approved) return null
  return result.editedInput ?? originalInput
}
