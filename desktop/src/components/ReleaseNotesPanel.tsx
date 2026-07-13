import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Markdown } from './Markdown'
import { RELEASE_NOTES } from '../generated/release-notes'

export interface ReleaseNotesPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  highlightVersion?: string
}

export function ReleaseNotesPanel({ open, onOpenChange, highlightVersion }: ReleaseNotesPanelProps) {
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const sorted = useMemo(() => [...RELEASE_NOTES], [])

  useEffect(() => {
    if (!open) return
    const next = new Set<string>()
    if (highlightVersion) {
      next.add(highlightVersion)
    }
    setExpanded(next)
  }, [open, highlightVersion])

  useEffect(() => {
    if (!open || !highlightVersion) return
    const el = itemRefs.current[highlightVersion]
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [open, highlightVersion, expanded])

  const toggle = (version: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('releaseNotes.title')}</DialogTitle>
        </DialogHeader>
        {sorted.length === 0 ? (
          <div className="text-muted-foreground py-8 text-center">
            {t('releaseNotes.noNotes')}
          </div>
        ) : (
          <div className="overflow-y-auto pr-1 -mr-1 space-y-2">
            {sorted.map((note) => {
              const isExpanded = expanded.has(note.version)
              const isHighlighted = highlightVersion === note.version
              return (
                <div
                  key={note.version}
                  ref={(el) => { itemRefs.current[note.version] = el }}
                  className={`rounded-lg border transition-colors ${isHighlighted ? 'bg-accent/40 border-accent' : 'bg-panel-1 border-border'}`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(note.version)}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-medium">{note.title}</span>
                      <span className="text-xs text-muted-foreground shrink-0">v{note.version}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {note.date && <span className="text-xs text-muted-foreground">{note.date}</span>}
                      {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-4 pt-0">
                      <Markdown source={note.body} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
