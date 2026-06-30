import { useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Info,
  FileText,
  ChevronDown,
  ChevronRight,
  FileCheck,
} from 'lucide-react'
import type { EvidenceSummary } from '../../../src/agent/evidence.js'

interface CompletionCurtainProps {
  summary: EvidenceSummary
}

function statusFromSummary(summary: EvidenceSummary): {
  kind: 'success' | 'warning' | 'error' | 'info'
  label: string
  icon: React.ReactNode
} {
  const gate = summary.gate.state
  if (gate === 'GREEN' || gate === 'ok' || summary.verificationStatus === 'verified') {
    return { kind: 'success', label: '已完成', icon: <CheckCircle2 size={18} /> }
  }
  if (gate === 'RED' || gate === 'error' || summary.verificationStatus === 'failed') {
    return { kind: 'error', label: '完成但有失败', icon: <XCircle size={18} /> }
  }
  if (gate === 'YELLOW' || gate === 'warn' || summary.verificationStatus === 'blocked') {
    return { kind: 'warning', label: '完成但有阻塞', icon: <AlertCircle size={18} /> }
  }
  return { kind: 'info', label: '已完成', icon: <Info size={18} /> }
}

function verificationLabel(summary: EvidenceSummary, t: (key: string, options?: Record<string, number>) => string): string {
  const last = summary.verifications[summary.verifications.length - 1]
  if (!last) {
    if (summary.filesModified.length === 0) return t('completionNoChanges')
    return t('completionTestsNotRun')
  }
  if (last.status === 'blocked') return t('completionTestsBlocked')
  if (last.status === 'failed') return t('completionTestsFailed', { passed: last.passed, failed: last.failed })
  return t('completionTestsPassed', { passed: last.passed, failed: last.failed })
}

function CompletionCurtainImpl({ summary }: CompletionCurtainProps) {
  const { t } = useTranslation('thread')
  const [filesOpen, setFilesOpen] = useState(false)
  const status = statusFromSummary(summary)

  return (
    <div className={`completion-curtain status-${status.kind}`} role="region" aria-label={t('completionTitle')}>
      <div className="cc-header">
        <span className="cc-icon" aria-hidden>{status.icon}</span>
        <div className="cc-title-stack">
          <span className="cc-title">{t('completionTitle')}</span>
          <span className={`cc-status-badge ${status.kind}`}>{status.label}</span>
        </div>
      </div>

      <div className="cc-metrics">
        <div className="cc-metric">
          <FileText size={14} />
          <span>{t('completionFilesRead', { count: summary.filesRead.length })}</span>
        </div>
        <div className="cc-metric">
          <FileCheck size={14} />
          <span>{t('completionFilesModified', { count: summary.filesModified.length })}</span>
        </div>
      </div>

      {summary.filesModified.length > 0 && (
        <div className="cc-section">
          <button
            className="cc-section-toggle"
            onClick={() => setFilesOpen((v) => !v)}
            aria-expanded={filesOpen}
          >
            {filesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{t('completionChangedFiles', { count: summary.filesModified.length })}</span>
          </button>
          {filesOpen && (
            <ul className="cc-file-list">
              {summary.filesModified.map((f) => (
                <li key={f} className="cc-file-item" title={f}>
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="cc-section">
        <div className="cc-section-title">{t('completionVerificationTitle')}</div>
        <div className="cc-verification-text">{verificationLabel(summary, t)}</div>
      </div>

      {summary.gate.nextAction && (
        <div className="cc-section">
          <div className="cc-section-title">{t('completionNextAction')}</div>
          <div className="cc-next-action">{summary.gate.nextAction}</div>
        </div>
      )}
    </div>
  )
}

export const CompletionCurtain = memo(CompletionCurtainImpl, (a, b) =>
  a.summary === b.summary
)
