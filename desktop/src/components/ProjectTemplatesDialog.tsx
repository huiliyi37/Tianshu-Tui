import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Shield, Check, X, Eye } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { ProjectTemplatesStatus } from '../runtime/types'

interface ProjectTemplatesDialogProps {
  status: ProjectTemplatesStatus | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onApply: (agentsMode: 'overwrite' | 'append' | 'skip') => Promise<void>
}

export function ProjectTemplatesDialog(props: ProjectTemplatesDialogProps) {
  const { status, open, onOpenChange, onApply } = props
  const { t } = useTranslation('onboarding')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<'agents' | 'rivet' | null>(null)

  const handleApply = async (mode: 'overwrite' | 'append' | 'skip') => {
    setBusy(true)
    try {
      await onApply(mode)
    } finally {
      setBusy(false)
      onOpenChange(false)
      setPreview(null)
    }
  }

  const templateText = preview === 'agents'
    ? status?.agentsTemplate
    : preview === 'rivet'
      ? status?.rivetTemplate
      : ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield size={18} className="text-accent" />
            {t('templates.title')}
          </DialogTitle>
          <DialogDescription>
            {t('templates.desc')}
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-strong">
                {t('templates.previewTitle', { name: preview === 'agents' ? 'AGENTS.md' : '.rivet.md' })}
              </span>
              <button
                className="text-xs text-accent hover:underline"
                onClick={() => setPreview(null)}
              >
                {t('templates.back')}
              </button>
            </div>
            <pre className="max-h-[320px] max-w-full overflow-y-auto whitespace-pre-wrap break-words rounded-lg border bg-panel-2 p-3 text-xs font-mono text-text">
              {templateText}
            </pre>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <button
                className="flex flex-col gap-2 rounded-lg border bg-panel p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
                onClick={() => setPreview('agents')}
              >
                <div className="flex items-center gap-2 text-text-strong">
                  <Shield size={16} className="text-accent" />
                  <span className="font-medium">AGENTS.md</span>
                </div>
                <p className="text-xs text-muted">{t('templates.agentsDesc')}</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-accent">
                  <Eye size={12} />
                  {t('templates.previewTemplate')}
                </span>
              </button>
              <button
                className="flex flex-col gap-2 rounded-lg border bg-panel p-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
                onClick={() => setPreview('rivet')}
              >
                <div className="flex items-center gap-2 text-text-strong">
                  <FileText size={16} className="text-accent" />
                  <span className="font-medium">.rivet.md</span>
                </div>
                <p className="text-xs text-muted">{t('templates.rivetDesc')}</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-accent">
                  <Eye size={12} />
                  {t('templates.previewTemplate')}
                </span>
              </button>
            </div>
            <p className="text-xs text-muted">
              {t('templates.editNote')}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleApply('skip')}
            disabled={busy}
            className="gap-1"
          >
            <X size={14} />
            {t('templates.skip')}
          </Button>
          <Button
            onClick={() => handleApply('overwrite')}
            disabled={busy}
            className="gap-1"
          >
            <Check size={14} />
            {busy ? t('templates.creating') : t('templates.createBoth')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
