import { useEffect, useMemo, useState } from 'react'
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

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘/Ctrl + K', desc: '打开/关闭命令面板' },
  { keys: '⌘/Ctrl + 1-4', desc: '切换面板（工作台·自动化·需处理·设置）' },
  { keys: 'Enter', desc: '发送消息（运行中则为引导）' },
  { keys: 'Shift + Enter', desc: '换行' },
  { keys: 'Esc × 2', desc: '清空输入 → 打开 Rewind' },
]

// Cmd+K command palette (Q4). Built on shadcn/ui Command (cmdk) for robust
// filtering, keyboard navigation and accessibility. Supports chained sub-modes
// for switching models and opening files.
export function CommandPalette(props: { commands: Cmd[]; onClose: () => void }) {
  const { commands, onClose } = props
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
      const key = c.hint ?? '其他'
      const list = map.get(key) ?? []
      list.push(c)
      map.set(key, list)
    }
    return Array.from(map.entries())
  }, [results])

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
      title="命令面板"
      description="输入命令、面板或线程名称以快速跳转"
    >
      <Command shouldFilter={false} onKeyDown={handleKeyDown}>
        {mode === 'normal' && (
          <>
            <CommandInput
              placeholder="输入命令或线程…"
              value={q}
              onValueChange={setQ}
            />
            <CommandList>
              <CommandEmpty>无匹配</CommandEmpty>
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
                <CommandGroup heading="快捷键">
                  {SHORTCUTS.map((s) => (
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
              placeholder="搜索模型..."
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
                  <span>← 返回主菜单</span>
                </CommandItem>
              </CommandGroup>
              {loadingModels && <CommandEmpty>加载模型中...</CommandEmpty>}
              {!loadingModels && models.length === 0 && <CommandEmpty>未发现可用模型</CommandEmpty>}
              <CommandGroup heading="可用模型">
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
              placeholder="搜索项目文件..."
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
                  <span>← 返回主菜单</span>
                </CommandItem>
              </CommandGroup>
              {loadingFiles && <CommandEmpty>搜索文件中...</CommandEmpty>}
              {!loadingFiles && files.length === 0 && <CommandEmpty>未找到匹配文件</CommandEmpty>}
              <CommandGroup heading="项目文件">
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
