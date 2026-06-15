import type { IntentPreview, IntentPreviewAction } from '../../agent/intent-preview.js'
import type { ApprovalResult } from '../../agent/approval-edit.js'

export interface PendingApproval {
  id: string
  name: string
  input: Record<string, unknown>
  resolve: (result: ApprovalResult | boolean) => void
}

export interface PendingIntent {
  intent: IntentPreview
  resolve: (action: IntentPreviewAction) => void
}

/**
 * Approval + intent state manager — holds the 4 approval/intent state fields
 * extracted from TuiApp (W-B4). Key handling, rendering, and resolution logic
 * stay in TuiApp; this class only manages the pending state objects.
 */
export class ApprovalIntentController {
  approvalPending: PendingApproval | null = null
  approvalEditMode = false
  approvalEditError = ''
  intentPending: PendingIntent | null = null
}
