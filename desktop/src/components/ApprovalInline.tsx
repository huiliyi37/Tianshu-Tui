import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseMcpToolName, previewOf, editableKey, EDIT_TOOLS } from '../lib/approval-preview'
import { DiffView } from './DiffView'
import type { ApprovalRequest } from '../runtime/types'
import i18n from '../i18n'

// Shared inline approval card — rendered by the main workspace AND popped-out
// thread windows (PopoutThreadRoot). Extracted verbatim from WorkspaceSurface
// so a tool blocked on approval is answerable from whichever window the user
// is looking at.

function getApprovalIntent(toolName: string, input: Record<string, unknown>): { title: string; desc: string; icon: string } {
  const t = (key: string, opts?: Record<string, unknown>) => i18n.t(`approval:${key}`, opts) as string
  const mcp = parseMcpToolName(toolName)
  if (mcp) {
    return {
      title: t('intent.mcpTitle', { tool: mcp.toolName }),
      desc: t('intent.mcpDesc', { server: mcp.serverId }),
      icon: "🔌"
    }
  }
  
  const path = String(input.path ?? input.file_path ?? input.target ?? "")
  // Windows tool inputs may use backslashes — split on both separators.
  const base = path.split(/[\\/]/).pop()
  switch (toolName) {
    case 'write_file':
    case 'create_file':
      return {
        title: t('intent.writeTitle'),
        desc: path ? t('intent.writeDesc', { base, path }) : t('intent.writeDescNoPath'),
        icon: "📝"
      }
    case 'edit_file':
    case 'apply_patch':
    case 'hash_edit':
      return {
        title: t('intent.editTitle'),
        desc: path ? t('intent.editDesc', { base, path }) : t('intent.editDescNoPath'),
        icon: "⚡"
      }
    case 'read_file':
      return {
        title: t('intent.readTitle'),
        desc: path ? t('intent.readDesc', { base, path }) : t('intent.readDescNoPath'),
        icon: "🔍"
      }
    case 'execute_bash':
      return {
        title: t('intent.bashTitle'),
        desc: t('intent.bashDesc', { command: String(input.command ?? "") }),
        icon: "💻"
      }
    case 'computer_use': {
      const app = String(input.app ?? '')
      const action = String(input.action ?? '')
      const actionKeys = new Set([
        'list_apps', 'snapshot', 'find', 'wait_for', 'set_value', 'click',
        'double_click', 'right_click', 'scroll', 'drag', 'wait', 'type',
        'key', 'focus_app', 'launch_app', 'menu_select', 'paste_text',
        'navigate', 'read_page', 'js_eval', 'tabs', 'browser_adopt',
      ])
      const what = actionKeys.has(action) ? t(`computerAction.${action}`) : action
      const paren = (value: string) => t('target.paren', { value })
      let target = ''
      if (action === 'click' || action === 'double_click' || action === 'right_click') {
        target = typeof input.ref === 'number'
          ? t('target.element', { ref: input.ref })
          : t('target.coord', { x: String(input.x), y: String(input.y) })
      } else if (action === 'scroll') {
        const dir = String(input.direction)
        const dirLabel = ['up', 'down', 'left', 'right'].includes(dir) ? t(`direction.${dir}`) : dir
        target = input.direction ? paren(dirLabel) : ''
      } else if (action === 'drag') {
        const from = typeof input.from_ref === 'number' ? `#${input.from_ref}` : `(${String(input.from_x)}, ${String(input.from_y)})`
        const to = typeof input.to_ref === 'number' ? `#${input.to_ref}` : `(${String(input.to_x)}, ${String(input.to_y)})`
        target = paren(`${from} → ${to}`)
      } else if (action === 'type' || action === 'paste_text' || action === 'set_value') {
        const text = String(input.text ?? '')
        target = text ? paren(text.length > 24 ? `${text.slice(0, 24)}…` : text) : ''
      } else if (action === 'key') {
        target = input.combo ? paren(String(input.combo)) : ''
      } else if (action === 'menu_select') {
        target = input.menu_path ? paren(String(input.menu_path)) : ''
      } else if (action === 'find') {
        target = input.query ? paren(String(input.query)) : ''
      } else if (action === 'wait_for') {
        target = input.text ? paren(String(input.text)) : ''
      } else if (action === 'navigate') {
        target = input.url ? paren(String(input.url)) : ''
      } else if (action === 'js_eval') {
        const expr = String(input.expression ?? '')
        target = expr ? paren(expr.length > 48 ? `${expr.slice(0, 48)}…` : expr) : ''
      } else if (action === 'tabs') {
        const op = String(input.tab_op ?? 'list')
        target = paren(typeof input.tab === 'number' ? `${op} #${input.tab}` : input.url ? `${op} ${String(input.url)}` : op)
      } else if (action === 'browser_adopt') {
        target = input.endpoint ? paren(String(input.endpoint)) : ''
      }
      return {
        title: app ? t('intent.computerTitle', { app }) : t('intent.computerTitleNoApp'),
        desc: t('intent.computerDesc', { what, target }),
        icon: "🖥️"
      }
    }
    default:
      return {
        title: t('intent.defaultTitle', { tool: toolName }),
        desc: t('intent.defaultDesc'),
        icon: "⚙️"
      }
  }
}

interface ApprovalModalProps {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>, remember?: boolean) => void
}

/** Inline approval card — non-blocking, pinned above the composer.
 *  Replaces the old full-screen backdrop modal (Cursor-style inline diff gutter). */
export function ApprovalInline({ request, onDecision }: ApprovalModalProps) {
  const { t } = useTranslation('approval')
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [isDiffEditorOpen, setIsDiffEditorOpen] = useState(false)
  const [showDetail, setShowDetail] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )
  // Computer Use "always allow": approve+remember records a per-app grant so
  // future actions on this app skip the prompt (server writes the grant store).
  const computerUseApp = request.toolName === 'computer_use'
    ? String((request.input as Record<string, unknown>).app ?? '').trim()
    : ''
  const [rememberApp, setRememberApp] = useState(false)

  const isCodeTool = EDIT_TOOLS.has(request.toolName)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdEnter = (e.metaKey || e.ctrlKey) && e.key === 'Enter'
      if (isCmdEnter) {
        e.preventDefault()
        if (isDiffEditorOpen && editKey) {
          onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
          setIsDiffEditorOpen(false)
        } else if (editing && editKey) {
          onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
        } else {
          onDecision('approve', undefined, rememberApp)
        }
      } else if (e.key === 'Escape') {
        if (isDiffEditorOpen) {
          e.preventDefault()
          setIsDiffEditorOpen(false)
        } else if (!editing) {
          e.preventDefault()
          onDecision('reject')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, isDiffEditorOpen, draft, request, onDecision, editKey, rememberApp])

  const intent = getApprovalIntent(request.toolName, request.input as Record<string, unknown>)

  const approve = () => {
    if (editing && editKey) onDecision('approve', { ...request.input, [editKey]: draft }, rememberApp)
    else onDecision('approve', undefined, rememberApp)
  }

  const triggerEdit = () => {
    if (isCodeTool) {
      setIsDiffEditorOpen(true)
    } else {
      setEditing((v) => !v)
      if (!editing) setShowDetail(true)
    }
  }

  const originalContent = typeof (request.input as Record<string, unknown>).old_string === 'string'
    ? String((request.input as Record<string, unknown>).old_string)
    : ''

  return (
    <>
      <div className="approval-inline">
        <div className="approval-inline-header">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg shrink-0">{intent.icon}</span>
            <div className="min-w-0">
              <div className="approval-inline-title truncate">{intent.title}</div>
              <div className="approval-inline-subtitle truncate" title={intent.desc}>{intent.desc}</div>
            </div>
          </div>
          <span className="approval-inline-badge shrink-0">{t('badge')}</span>
        </div>

        {showDetail && !editing && (
          <div className="approval-inline-body">
            {preview.isDiff ? (
              <div className="approval-inline-diff overflow-auto max-h-[260px] border border-border rounded">
                <DiffView raw={preview.text} />
              </div>
            ) : (
              <pre className="approval-inline-pre font-mono overflow-auto max-h-[260px] border border-border rounded p-2 bg-panel-2 text-xs">
                {preview.text}
              </pre>
            )}
          </div>
        )}

        {showDetail && editing && editKey && !isCodeTool && (
          <div className="approval-inline-body">
            <textarea
              className="approval-inline-textarea font-mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
        )}

        <div className="approval-inline-footer">
          {editKey && (
            <button
              className="btn ghost sm"
              onClick={triggerEdit}
            >
              {isCodeTool ? t('editCode') : editing ? t('cancelEdit') : t('editConfig')}
            </button>
          )}
          {!editing && (
            <button
              className="btn ghost sm"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? t('hideDetail') : t('showDetail')}
            </button>
          )}
          {computerUseApp && (
            <label className="approval-remember flex items-center gap-1.5 text-xs cursor-pointer select-none" title={t('rememberTitle', { app: computerUseApp })}>
              <input
                type="checkbox"
                checked={rememberApp}
                onChange={(e) => setRememberApp(e.target.checked)}
              />
              <span>{t('rememberLabel', { app: computerUseApp })}</span>
            </label>
          )}
          <div className="flex items-center gap-2 ml-auto">
            <button
              className="btn ghost sm"
              onClick={() => onDecision('reject')}
            >
              {t('reject')}
            </button>
            <button
              className="btn sm"
              onClick={approve}
              autoFocus
            >
              {editing ? t('applyApprove') : t('approve')}
            </button>
          </div>
        </div>
      </div>

      {isDiffEditorOpen && (
        <div className="approval-diff-editor-overlay" role="dialog" aria-modal="true" onClick={() => setIsDiffEditorOpen(false)}>
          <div className="approval-diff-editor-modal" onClick={(e) => e.stopPropagation()}>
            <div className="adem-header">
              <div className="adem-title flex items-center gap-2">
                <span>📝</span>
                <span>{t('editModal.title', { path: String((request.input as Record<string, unknown>).path || (request.input as Record<string, unknown>).file_path || t('editModal.newFile')) })}</span>
              </div>
              <div className="adem-subtitle">{t('editModal.subtitle')}</div>
            </div>
            
            <div className="adem-body">
              <div className="adem-pane original-pane">
                <div className="adem-pane-title">{t('editModal.originalPane')}</div>
                <div className="adem-code-box">
                  {originalContent ? (
                    <pre className="font-mono">{originalContent}</pre>
                  ) : (
                    <div className="empty sm muted font-mono text-center pt-8">{t('editModal.emptyOriginal')}</div>
                  )}
                </div>
              </div>
              <div className="adem-pane proposed-pane">
                <div className="adem-pane-title">{t('editModal.proposedPane')}</div>
                <textarea
                  className="adem-textarea font-mono"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t('editModal.placeholder')}
                  autoFocus
                />
              </div>
            </div>

            <div className="adem-footer">
              <span className="text-xs text-muted">{t('editModal.hint')}</span>
              <div className="flex items-center gap-2 ml-auto">
                <button className="btn ghost" onClick={() => setIsDiffEditorOpen(false)}>{t('editModal.cancel')}</button>
                <button
                  className="btn"
                  onClick={() => {
                    if (editKey) onDecision('approve', { ...request.input, [editKey]: draft })
                    setIsDiffEditorOpen(false)
                  }}
                >
                  {t('editModal.applyApprove')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
