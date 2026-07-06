import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { openExternal } from '../lib/open-external'
import { qk } from '../state/queries'

const GIT_WIN_DOWNLOAD = 'https://git-scm.com/download/win'

/**
 * First-run Git install gate. On Windows the bash tool prefers Git Bash for
 * reliable command execution, so a missing Git degrades command execution to
 * PowerShell/cmd. This blocking dialog guides the user to install Git, then
 * re-checks the environment. "稍后" lets them proceed this session (escape hatch
 * so a false-negative detection never traps the user).
 */
export function FirstRunGitDialog({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const { t } = useTranslation('onboarding')
  const queryClient = useQueryClient()
  const [opening, setOpening] = useState(false)
  const [rechecking, setRechecking] = useState(false)

  const handleOpenDownload = () => {
    setOpening(true)
    // openExternal is fire-and-forget (plugin-opener with a window.open
    // fallback baked in); flip the button back once dispatched.
    openExternal(GIT_WIN_DOWNLOAD)
    setTimeout(() => setOpening(false), 400)
  }

  const handleRecheck = async () => {
    setRechecking(true)
    try {
      await queryClient.invalidateQueries({ queryKey: qk.environment })
    } finally {
      setRechecking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { /* gated dialog: dismiss only via explicit buttons */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('firstRunGit.title')}</DialogTitle>
          <DialogDescription>
            {t('firstRunGit.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="git-install-panel">
          <ol className="git-install-steps">
            <li>{t('firstRunGit.step1')}</li>
            <li>{t('firstRunGit.step2')}</li>
            <li>{t('firstRunGit.step3')}</li>
          </ol>
          <div className="git-install-actions">
            <Button onClick={handleOpenDownload} disabled={opening}>
              {opening ? t('firstRunGit.opening') : t('firstRunGit.openDownload')}
            </Button>
            <Button variant="outline" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? t('firstRunGit.rechecking') : t('firstRunGit.recheck')}
            </Button>
            <Button variant="ghost" onClick={onDismiss}>
              {t('firstRunGit.later')}
            </Button>
          </div>
          <p className="git-install-hint">
            {t('firstRunGit.hint')}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
