import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { pickFolder } from '../lib/dialog'
import type { ApprovalMode } from '../runtime/types'
import { coerceLevel, levelToMode, type AutonomyLevel, LEVEL_META, AUTONOMY_LEVELS } from '../lib/autonomy'
import { loadDefaultAutonomy } from '../lib/persist'
import { listConfigProviders } from '../runtime/client'
import { STAR_DOMAINS } from '../../agent/star-domain'
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
  onCreate: (input: { cwd?: string; roots?: string[]; title?: string; prompt?: string; approvalMode?: ApprovalMode; isolatedWorktree?: boolean; model?: string; domain?: string }) => void
  onClose: () => void
}) {
  const { defaultCwd, initialPrompt, onCreate, onClose } = props
  const { t } = useTranslation('thread')
  const [title, setTitle] = useState('')
  // roots[0] is the primary cwd; additional entries are bound repos.
  const [roots, setRoots] = useState<string[]>(() => (defaultCwd ? [defaultCwd] : []))
  const [manualInput, setManualInput] = useState('')
  const [showManual, setShowManual] = useState(false)
  const [prompt, setPrompt] = useState(initialPrompt || '')
  const [level, setLevel] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))
  const [worktree, setWorktree] = useState(false)
  const [selectedModel, setSelectedModel] = useState('')
  const [selectedDomain, setSelectedDomain] = useState('')

  // Fetch configured providers + models for the model dropdown.
  const [providerModels, setProviderModels] = useState<{ value: string; label: string }[]>([])
  useEffect(() => {
    let cancelled = false
    listConfigProviders()
      .then((res) => {
        if (cancelled) return
        const opts: { value: string; label: string }[] = []
        for (const p of res.providers) {
          for (const m of p.models) {
            opts.push({ value: m.id, label: `${p.label}: ${m.alias || m.id}` })
          }
        }
        setProviderModels(opts)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const domainEntries = useMemo(() =>
    Object.values(STAR_DOMAINS).map((d) => ({ value: d.id, label: `${d.uiPersona.glyph} ${d.name}` })),
  [])

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
      model: selectedModel || undefined,
      domain: selectedDomain || undefined,
    })
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('titleNew')}</DialogTitle>
          <DialogDescription>{t('newSessionDesc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('titleLabel')}</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('titleOptional')}
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('cwdMulti')}</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {roots.map((root, i) => (
                <span
                  key={root}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 text-xs"
                  title={root}
                >
                  {i === 0 && <span className="text-[10px] font-semibold text-accent">{t('rootPrimary')}</span>}
                  <span className="max-w-[180px] truncate font-mono">{root.split(/[/\\]/).pop() || root}</span>
                  {roots.length > 1 && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeRoot(root)}
                      aria-label={t('removeRoot', { root })}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {roots.length === 0 && (
                <span className="text-xs text-muted-foreground">{t('cwdPlaceholder')}</span>
              )}
              <Button variant="outline" size="sm" onClick={browse}>
                {roots.length === 0 ? t('browse') : t('addRepo')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setShowManual((v) => !v)}>
                {t('manualEntry')}
              </Button>
              {showManual && (
                <Input
                  autoFocus
                  value={manualInput}
                  onChange={(e) => setManualInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitManual() } }}
                  onBlur={commitManual}
                  placeholder={t('manualPlaceholder')}
                  className="h-7 flex-1 font-mono text-xs"
                />
              )}
            </div>
            {roots.length > 1 && (
              <p className="text-[11px] text-muted-foreground">
                {t('multiRepoHint', { count: roots.length, primary: roots[0]?.split(/[/\\]/).pop() })}
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('firstTask')}</label>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('firstTaskPlaceholder')}
              className="min-h-[80px] resize-none"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('autonomyLevel')}</label>
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

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t('modelLabel')}</label>
              <select
                className="h-9 rounded-md border border-border bg-transparent px-2 text-sm"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                <option value="">{t('modelDefault')}</option>
                {providerModels.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t('domainLabel')}</label>
              <select
                className="h-9 rounded-md border border-border bg-transparent px-2 text-sm"
                value={selectedDomain}
                onChange={(e) => setSelectedDomain(e.target.value)}
              >
                <option value="">{t('domainDefault')}</option>
                {domainEntries.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={worktree}
              onChange={(e) => setWorktree(e.target.checked)}
              className="rounded border-border"
            />
            <span>{t('worktree')}</span>
            <span className="text-xs text-muted-foreground">{t('worktreeHint')}</span>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
          <Button onClick={submit}>{t('create')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
