import { useMemo, useState } from 'react'
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

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘/Ctrl + K', desc: '打开/关闭命令面板' },
  { keys: '⌘/Ctrl + 1-4', desc: '切换面板（工作台·自动化·需处理·设置）' },
  { keys: 'Enter', desc: '发送消息（运行中则为引导）' },
  { keys: 'Shift + Enter', desc: '换行' },
  { keys: 'Esc × 2', desc: '清空输入 → 打开 Rewind' },
]

// Cmd+K command palette (Q4). Built on shadcn/ui Command (cmdk) for robust
// filtering, keyboard navigation and accessibility.
export function CommandPalette(props: { commands: Cmd[]; onClose: () => void }) {
  const { commands, onClose } = props
  const [q, setQ] = useState('')

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

  return (
    <CommandDialog
      open
      onOpenChange={(open: boolean) => {
        if (!open) onClose()
      }}
      title="命令面板"
      description="输入命令、面板或线程名称以快速跳转"
    >
      <Command shouldFilter={false}>
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
                    c.run()
                    onClose()
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
      </Command>
    </CommandDialog>
  )
}
