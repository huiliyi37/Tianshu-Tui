import { useEffect, useState } from 'react'
import { delegateWorker, listDomains } from '../runtime/client'
import type { DomainEntry } from '../runtime/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// 派后台子代理：用户填任务 → 一键派单。子代理在隔离子会话后台跑,进度走
// delegation 面板;不阻塞主对话、不碰主历史(前缀缓存安全)。

const PROFILES: { value: string; label: string; hint: string }[] = [
  { value: 'code_scout', label: '调研', hint: '只读查代码 / 定位实现' },
  { value: 'doc_scout', label: '查文档', hint: '只读查文档 / 资料' },
  { value: 'planner', label: '规划', hint: '产出方案 / 拆解' },
  { value: 'reviewer', label: '审查', hint: '审查改动 / 找问题' },
  { value: 'verifier', label: '验证', hint: '跑测试 / 验证结果' },
  { value: 'patcher', label: '改代码', hint: '直接改文件(写入)' },
]

export function DelegateDialog(props: {
  sessionId: string
  onClose: () => void
  onDispatched: (workerId: string) => void
}) {
  const { sessionId, onClose, onDispatched } = props
  const [objective, setObjective] = useState('')
  const [profile, setProfile] = useState('code_scout')
  const [authority, setAuthority] = useState('')
  const [filesText, setFilesText] = useState('')
  const [domains, setDomains] = useState<DomainEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listDomains(sessionId)
      .then((entries) => setDomains(entries.filter((e) => e.key !== 'auto')))
      .catch(() => setDomains([]))
  }, [sessionId])

  const submit = async () => {
    const obj = objective.trim()
    if (!obj || busy) return
    setBusy(true)
    setError(null)
    try {
      const files = filesText
        .split(/[,，\n]/)
        .map((f) => f.trim())
        .filter(Boolean)
      const { workerId } = await delegateWorker(sessionId, {
        objective: obj,
        profile,
        ...(authority ? { authority } : {}),
        ...(files.length ? { files } : {}),
      })
      onDispatched(workerId)
      onClose()
    } catch (e) {
      setError((e as Error)?.message ?? '派单失败,请重试')
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>派后台子代理</DialogTitle>
          <DialogDescription>子代理在后台独立跑,不影响当前对话;完成后可在面板查看并汇入主会话。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">任务目标</label>
            <Textarea
              autoFocus
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }}
              placeholder="例如:排查登录页验证码偶发失败的根因"
              className="min-h-[88px] resize-none"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">角色</label>
            <div className="flex flex-wrap gap-1.5">
              {PROFILES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  title={p.hint}
                  onClick={() => setProfile(p.value)}
                  className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                    profile === p.value
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{PROFILES.find((p) => p.value === profile)?.hint}</p>
          </div>

          {domains.length > 0 && (
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">星域(可选)</label>
              <select
                value={authority}
                onChange={(e) => setAuthority(e.target.value)}
                className="h-8 rounded border border-border bg-transparent px-2 text-sm"
              >
                <option value="">不指定</option>
                {domains.map((d) => (
                  <option key={d.key} value={d.key}>{d.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">关注文件(可选,逗号分隔)</label>
            <Input
              value={filesText}
              onChange={(e) => setFilesText(e.target.value)}
              placeholder="src/auth/login.ts, src/api/sms.ts"
              className="font-mono text-xs"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>
          <Button onClick={() => void submit()} disabled={busy || !objective.trim()}>
            {busy ? '派单中…' : '派单'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
