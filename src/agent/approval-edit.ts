export interface ApprovalResult {
  approved: boolean
  editedInput?: Record<string, unknown>
  /**
   * The user asked to remember this decision beyond the session. Only meaningful
   * for out-of-workspace path approvals, where it persists the resulting
   * directory grant to the per-workspace store instead of keeping it in-process.
   */
  remember?: boolean
}

export function applyApprovalEdit(
  originalInput: Record<string, unknown>,
  result: ApprovalResult,
): Record<string, unknown> | null {
  if (!result.approved) return null
  return result.editedInput ?? originalInput
}
