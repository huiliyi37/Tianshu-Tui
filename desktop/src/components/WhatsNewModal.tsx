import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Markdown } from './Markdown'
import {
  hasUnreadReleaseNotes,
  getCurrentVersion,
  saveLastSeenVersion,
  getCurrentNote,
  type ReleaseNote,
} from '../lib/release-notes'

export function WhatsNewModal() {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<ReleaseNote | undefined>()

  useEffect(() => {
    let mounted = true
    void (async () => {
      const unread = await hasUnreadReleaseNotes()
      if (!mounted || !unread) return
      const current = await getCurrentNote()
      if (current) {
        setNote(current)
        setOpen(true)
      }
    })()
    return () => { mounted = false }
  }, [])

  const handleDismiss = async () => {
    const version = note?.version ?? await getCurrentVersion()
    saveLastSeenVersion(version)
    setOpen(false)
  }

  if (!note) return null

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) void handleDismiss() }}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('releaseNotes.whatsNew', { version: note.version })}</DialogTitle>
          {note.date && (
            <DialogDescription>{note.date}</DialogDescription>
          )}
        </DialogHeader>
        <div className="overflow-y-auto pr-1 -mr-1">
          <h3 className="text-base font-medium mb-2">{note.title}</h3>
          <Markdown source={note.body} />
        </div>
        <div className="flex justify-end pt-3 border-t">
          <Button onClick={handleDismiss}>{t('releaseNotes.dismiss')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
