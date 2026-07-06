import { relaunch } from '@tauri-apps/plugin-process'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StorageLocationPanel } from './StorageLocationPanel'

export function FirstRunStorageDialog({ open }: { open: boolean }) {
  const { t } = useTranslation('onboarding')
  const handleApplied = async (requiresRestart: boolean) => {
    if (requiresRestart) {
      try {
        await relaunch()
      } catch {
        window.location.reload()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => { /* first-run dialog cannot be dismissed */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('firstRunStorage.title')}</DialogTitle>
          <DialogDescription>
            {t('firstRunStorage.desc')}
          </DialogDescription>
        </DialogHeader>
        <StorageLocationPanel onApplied={handleApplied} />
      </DialogContent>
    </Dialog>
  )
}
