import { useState } from 'react'
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
            项目引导配置
          </DialogTitle>
          <DialogDescription>
            当前项目缺少 AGENTS.md 和 .rivet.md。这两份文档用来告诉天枢如何在本项目工作：编码规范、安全纪律、技术栈、测试约定等。
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-text-strong">
                {preview === 'agents' ? 'AGENTS.md' : '.rivet.md'} 模板预览
              </span>
              <button
                className="text-xs text-accent hover:underline"
                onClick={() => setPreview(null)}
              >
                返回
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
                <p className="text-xs text-muted">Agent 行为纪律、安全边界、项目自定义规则。</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-accent">
                  <Eye size={12} />
                  预览模板
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
                <p className="text-xs text-muted">项目元数据：技术栈、构建命令、测试命令。</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs text-accent">
                  <Eye size={12} />
                  预览模板
                </span>
              </button>
            </div>
            <p className="text-xs text-muted">
              创建后你可以在项目目录中编辑它们，天枢会在每次会话启动时读取。
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
            跳过
          </Button>
          <Button
            onClick={() => handleApply('overwrite')}
            disabled={busy}
            className="gap-1"
          >
            <Check size={14} />
            {busy ? '创建中…' : '创建两份文档'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
