import { useState } from 'react'
import { pickFolder } from '../lib/dialog'
import type { ApprovalMode } from '../runtime/types'
import { coerceLevel, levelToMode, type AutonomyLevel, LEVEL_META, AUTONOMY_LEVELS } from '../lib/autonomy'
import { loadDefaultAutonomy } from '../lib/persist'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * New thread in a project (P1). The folder(s) typed/picked here become the
 * session roots; the first is the primary cwd the runtime runs in, additional
 * roots are bound repos shown by the project sidebar (multi-repo workspace,
 * matching Antigravity's multi-folder project). The runtime's path-grants +
 * self/world locus enforce the boundary at the tool layer. cwd is prefilled
 * with the active project so threads land in it.
 * The autonomy selector (S) sets the session's approval mode up front so an
 * unattended run can start without per-tool prompts.
 */
export function NewSessionDialog(props: {
  defaultCwd?: string | null
  initialPrompt?: string | null
  onCreate: (input: { cwd?: string; roots?: string[]; title?: string; prompt?: string; approvalMode?: ApprovalMode; isolatedWorktree?: boolean }) => void
  onClose: () => void
}) {
  const { defaultCwd, initialPrompt, onCreate, onClose } = props
  const [title, setTitle] = useState('')
  // roots[0] is the primary cwd; additional entries are bound repos.
  const [roots, setRoots] = useState<string[]>(() => (defaultCwd ? [defaultCwd] : []))
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [prompt, setPrompt] = useState(initialPrompt || '')
  const [level, setLevel] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [worktree, setWorktree] = useState(false)

  const browse = async () => {
    const picked = await pickFolder()
    if (!picked) return
    setRoots((prev) => (prev.includes(picked) ? prev : [...prev, picked]))
  }

  const removeRoot = (root: string) => {
    setRoots((prev) => prev.filter((r) => r !== root))
  }

  const commitManual = () => {
    const v = manualInput.trim()
    if (!v) return
    setRoots((prev) => (prev.includes(v) ? prev : [...prev, v]))
    setManualInput('')
    setShowManual(false)
  }

  const submit = () => {
    const primary = roots[0]?.trim()
    onCreate({
      title: title.trim() || undefined,
      cwd: primary || undefined,
      roots: roots.map((r) => r.trim()).filter(Boolean),
      prompt: prompt.trim() || undefined,
      approvalMode: levelToMode(level),
      isolatedWorktree: worktree || undefined,
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建线程</DialogTitle>
          <DialogDescription>在当前项目下创建一个新的对话线程。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">标题</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="可选"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">项目目录（首个为主 cwd）</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {roots.map((root, i) => (
                <span
                  key={root}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-xs"
                  title={root}
                >
                  {i === 0 && <span className="text-[10px] font-semibold text-accent">主</span>}
                  <span className="max-w-[180px] truncate font-mono">{root.split(/[/\\]/).pop() || root}</span>
                  {roots.length > 1 && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeRoot(root)}
                      aria-label={`移除 ${root}`}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {roots.length === 0 && (
                <span className="text-xs text-muted-foreground">留空 = sidecar 启动目录</span>
              )}
              <Button variant="outline" size="sm" onClick={browse}>
                {roots.length === 0 ? '选择…' : '+ 添加 repo'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowManual((v) => !v)}>
                手输
              </Button>
              {showManual && (
                <Input
                  autoFocus
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitManual() } }}
                  onBlur={commitManual}
                  placeholder="输入绝对路径后回车"
                  className="h-7 flex-1 font-mono text-xs"
                />
              )}
            </div>
            {roots.length > 1 && (
              <p className="text-[11px] text-muted-foreground">
                已绑定 {roots.length} 个仓库，主 cwd 为 {roots[0]?.split(/[/\\]/).pop()}。后端多 repo 编排即将支持，当前仅主 cwd 生效。
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">首条任务</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="可选，留空则先创建空闲线程"
              className="min-h-[80px] resize-none"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">自治档位</label>
            <ToggleGroup
              value={[level]}
              onValueChange={(v: string[]) => { setLevel((v[0] ?? level) as AutonomyLevel) }}
            >
              {AUTONOMY_LEVELS.map((lvl) => {
                const meta = LEVEL_META[lvl]
                return (
                  <ToggleGroupItem key={lvl} value={lvl} title={meta.hint} className="gap-1.5">
                    <span aria-hidden>{meta.glyph}</span>
                    {meta.label}
                  </ToggleGroupItem>
                )
              })}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">{LEVEL_META[level].hint}</p>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              className="rounded border-border"
            />
            <span>隔离 Worktree</span>
            <span className="text-xs text-muted-foreground">独立 Git 分支，并行工作互不冲突</span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={submit}>创建</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
