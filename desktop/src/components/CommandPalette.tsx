import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CommandDialog,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command'
import { filterCommands, type Command as Cmd } from '../lib/commands'
import { useUiState } from '../state/store'
import { listModels, switchModel, listFiles, openFile } from '../runtime/client'

// Cmd+K command palette (Q4). Built on shadcn/ui Command (cmdk) for robust
// filtering, keyboard navigation and accessibility. Supports chained sub-modes
// for switching models and opening files.
export function CommandPalette(props: { commands: Cmd[]; onClose: () => void }) {
  const { commands, onClose } = props
  const { t } = useTranslation('commandPalette')
  const shortcuts: { keys: string; desc: string }[] = useMemo(() => [
    { keys: '⌘/Ctrl + K', desc: t('shortcutToggle') },
    { keys: '⌘/Ctrl + 1-4', desc: t('shortcutSwitchPanel') },
    { keys: 'Enter', desc: t('shortcutSend') },
    { keys: 'Shift + Enter', desc: t('shortcutNewline') },
    { keys: 'Esc × 2', desc: t('shortcutEscRewind') },
  ], [t])
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'normal' | 'switch-model' | 'open-file'>('normal')

  const ui = useUiState()
  const activeSessionId = ui.activeSessionId

  // Model switching state
  const [models, setModels] = useState<any[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  // File search state
  const [files, setFiles] = useState<string[]>([])
  const [loadingFiles, setLoadingFiles] = useState(false)

  useEffect(() => {
    if (mode === 'switch-model' && activeSessionId) {
      setLoadingModels(true)
      listModels(activeSessionId)
        .then(setModels)
        .catch((err) => console.error(err))
        .finally(() => setLoadingModels(false))
    }
  }, [mode, activeSessionId])

  useEffect(() => {
    if (mode === 'open-file' && activeSessionId) {
      setLoadingFiles(true)
      const timer = setTimeout(() => {
        listFiles(activeSessionId, q)
          .then(setFiles)
          .catch((err) => console.error(err))
          .finally(() => setLoadingFiles(false))
      }, 150) // Debounce file search slightly
      return () => clearTimeout(timer)
    } else {
      setFiles([])
    }
  }, [mode, activeSessionId, q])

  const results = useMemo(() => filterCommands(commands, q), [commands, q])

  const groups = useMemo(() => {
    const map = new Map<string, Cmd[]>()
    for (const c of results) {
      const key = c.hint ?? t('hintOther')
      const list = map.get(key) ?? []
      list.push(c)
      map.set(key, list)
    }
    return Array.from(map.entries())
  }, [results, t])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && q === '' && mode !== 'normal') {
      e.preventDefault()
      setMode('normal')
      setQ('')
    }
  }

  return (
    <CommandDialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose()
      }}
      title={t('title')}
      description={t('description')}
    >
      <Command shouldFilter={false} onKeyDown={handleKeyDown}>
        {mode === 'normal' && (
          <>
            <CommandInput
              placeholder={t('placeholder')}
              value={q}
              onValueChange={setQ}
            />
            <CommandList>
              <CommandEmpty>{t('noMatch')}</CommandEmpty>
              {groups.map(([heading, items]) => (
                <CommandGroup key={heading} heading={heading}>
                  {items.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={c.id}
                      onSelect={() => {
                        if (c.subMode) {
                          setMode(c.subMode)
                          setQ('')
                        } else {
                          c.run()
                          onClose()
                        }
                      }}
                    >
                      <span className="truncate">{c.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {q.trim() === '' && (
                <CommandGroup heading={t('shortcuts')}>
                  {shortcuts.map((s) => (
                    <CommandItem key={s.keys} value={s.desc} disabled>
                      <span>{s.desc}</span>
                      <CommandShortcut>{s.keys}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </>
        )}

        {mode === 'switch-model' && (
          <>
            <CommandInput
              placeholder={t('searchModels')}
              value={q}
              onValueChange={setQ}
            />
            <CommandList>
              <CommandGroup>
                <CommandItem
                  value="back-to-menu"
                  onSelect={() => {
                    setMode('normal')
                    setQ('')
                  }}
                  className="text-accent"
                >
                  <span>{t('backToMenu')}</span>
                </CommandItem>
              </CommandGroup>
              {loadingModels && <CommandEmpty>{t('loadingModels')}</CommandEmpty>}
              {!loadingModels && models.length === 0 && <CommandEmpty>{t('noModels')}</CommandEmpty>}
              <CommandGroup heading={t('availableModels')}>
                {models
                  .filter((m) => {
                    const name = m.alias || m.id
                    return name.toLowerCase().includes(q.toLowerCase())
                  })
                  .map((m) => (
                    <CommandItem
                      key={m.id}
                      value={m.id}
                      onSelect={async () => {
                        if (activeSessionId) {
                          try {
                            await switchModel(activeSessionId, m.id)
                            onClose()
                          } catch (err) {
                            console.error(err)
                          }
                        }
                      }}
                    >
                      <div className="flex flex-col">
                        <span className="font-medium">{m.alias || m.id}</span>
                        <span className="text-xs text-muted-foreground">{m.provider}</span>
                      </div>
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </>
        )}

        {mode === 'open-file' && (
          <>
            <CommandInput
              placeholder={t('searchFiles')}
              value={q}
              onValueChange={setQ}
            />
            <CommandList>
              <CommandGroup>
                <CommandItem
                  value="back-to-menu"
                  onSelect={() => {
                    setMode('normal')
                    setQ('')
                  }}
                  className="text-accent"
                >
                  <span>{t('backToMenu')}</span>
                </CommandItem>
              </CommandGroup>
              {loadingFiles && <CommandEmpty>{t('searchingFiles')}</CommandEmpty>}
              {!loadingFiles && files.length === 0 && <CommandEmpty>{t('noFiles')}</CommandEmpty>}
              <CommandGroup heading={t('projectFiles')}>
                {files.map((file) => (
                  <CommandItem
                    key={file}
                    value={file}
                    onSelect={async () => {
                      try {
                        await openFile(file)
                        onClose()
                      } catch (err) {
                        console.error(err)
                      }
                    }}
                  >
                    <span>{file}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </>
        )}
      </Command>
    </CommandDialog>
  )
}
