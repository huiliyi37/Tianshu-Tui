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
 * New thread in a project (P1). The folder typed/picked here becomes the session
 * cwd; the runtime's path-grants + self/world locus enforce the boundary at the
 * tool layer. cwd is prefilled with the active project so threads land in it.
 * The autonomy selector (S) sets the session's approval mode up front so an
 * unattended run can start without per-tool prompts.
 */
export function NewSessionDialog(props: {
  defaultCwd?: string | null
  onCreate: (input: { cwd?: string; title?: string; prompt?: string; approvalMode?: ApprovalMode; isolatedWorktree?: boolean }) => void
  onClose: () => void
}) {
  const { defaultCwd, onCreate, onClose } = props
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [prompt, setPrompt] = useState('')
  const [level, setLevel] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [worktree, setWorktree] = useState(false)

  const browse = async () => {
    const picked = await pickFolder()
    if (picked) setCwd(picked)
  }

  const submit = () => {
    onCreate({
      title: title.trim() || undefined,
      cwd: cwd.trim() || undefined,
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
            <label className="text-xs text-muted-foreground">项目目录 (cwd)</label>
            <div className="flex gap-2">
              <Input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="留空 = sidecar 启动目录"
                className="flex-1"
              />
              <Button variant="outline" onClick={browse}>选择…</Button>
            </div>
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
