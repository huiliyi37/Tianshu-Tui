import type { ApprovalResult } from '../../agent/approval-edit.js'

export interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (result: ApprovalResult | boolean) => void
}

/**
 * Approval state manager — holds the approval state fields extracted from
 * TuiApp (W-B4). Key handling, rendering, and resolution logic stay in TuiApp;
 * this class only manages the pending state objects. (Intent is now a
 * non-blocking timeline note with no pending state.)
 */
export class ApprovalIntentController {
  approvalPending: PendingApproval | null = null
  approvalEditMode = false
  approvalEditError = ''
}
