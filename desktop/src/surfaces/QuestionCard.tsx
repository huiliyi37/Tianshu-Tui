import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PendingQuestion } from '../runtime/types'

/**
 * 结构化提问卡片（Cursor 3.0 风格）— 渲染 ask_user_question 的 user_question SSE。
 *
 * 交互：右上「n of N」分页 + 折叠；字母序号选项（点击选中）；每题末尾固定
 * 「Other…」自由输入；底部 Skip / Next（末题为 Submit）。提交时把答案组装成
 * 「问题 → 所选项」文本作为普通用户消息回传 —— 与 TUI 用户直接打字回答同一条链路。
 */

interface QuestionCardProps {
  question: PendingQuestion
  onSubmit: (text: string) => void
  disabled?: boolean
}

const OTHER_KEY = '__other__'

interface DraftAnswer {
  /** 选中的选项下标（单选恒 ≤1 个；allowMultiple 时可多个）。 */
  selected: number[]
  /** 「Other…」被选中。 */
  otherSelected: boolean
  otherText: string
  skipped: boolean
}

const emptyDraft = (): DraftAnswer => ({ selected: [], otherSelected: false, otherText: '', skipped: false })

function draftToAnswer(draft: DraftAnswer, options: string[]): string | null {
  if (draft.skipped) return null
  const parts = draft.selected.map((i) => options[i]).filter((o): o is string => !!o)
  if (draft.otherSelected && draft.otherText.trim()) parts.push(draft.otherText.trim())
  if (parts.length === 0) return null
  return parts.join('；')
}

export function QuestionCard({ question, onSubmit, disabled }: QuestionCardProps) {
  const { t } = useTranslation('approval')
  const { questions } = question
  const [index, setIndex] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(() => emptyDraft()))

  const current = questions[index]
  const isLast = index === questions.length - 1
  const draft = drafts[index] ?? emptyDraft()

  const setDraft = useCallback((updater: (d: DraftAnswer) => DraftAnswer) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? updater(d) : d)))
  }, [index])

  const toggleOption = useCallback((optIdx: number, allowMultiple: boolean) => {
    setDraft((d) => {
      const has = d.selected.includes(optIdx)
      const selected = allowMultiple
        ? (has ? d.selected.filter((i) => i !== optIdx) : [...d.selected, optIdx])
        : (has ? [] : [optIdx])
      return { ...d, selected, skipped: false, otherSelected: allowMultiple ? d.otherSelected : false }
    })
  }, [setDraft])

  const toggleOther = useCallback((allowMultiple: boolean) => {
    setDraft((d) => ({
      ...d,
      otherSelected: !d.otherSelected,
      skipped: false,
      selected: allowMultiple ? d.selected : [],
    }))
  }, [setDraft])

  const submitAll = useCallback((finalDrafts: DraftAnswer[]) => {
    const lines: string[] = []
    questions.forEach((q, i) => {
      const d = finalDrafts[i] ?? emptyDraft()
      const answer = draftToAnswer(d, q.options)
      if (answer) lines.push(questions.length > 1 ? `${q.prompt} → ${answer}` : answer)
    })
    if (lines.length === 0) {
      onSubmit(t('question.skippedAll'))
    } else {
      onSubmit(lines.join('\n'))
    }
  }, [questions, onSubmit, t])

  const advance = useCallback((markSkipped: boolean) => {
    const updated = drafts.map((d, i) => (i === index && markSkipped ? { ...d, skipped: true, selected: [], otherSelected: false } : d))
    setDrafts(updated)
    if (isLast) submitAll(updated)
    else setIndex(index + 1)
  }, [drafts, index, isLast, submitAll])

  const answered = draftToAnswer(draft, current?.options ?? []) !== null

  const letters = useMemo(() => 'ABCDEFGHIJ'.split(''), [])

  if (!current) return null

  return (
    <div className="question-card" role="form" aria-label={t('question.aria')}>
      <div className="question-card-header">
        <span className="question-card-title">Questions</span>
        <div className="question-card-header-right">
          {questions.length > 1 && (
            <span className="question-card-pager">{index + 1} of {questions.length}</span>
          )}
          <button
            className="question-card-collapse"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t('question.expand') : t('question.collapse')}
            title={collapsed ? t('question.expand') : t('question.collapse')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
              style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className="question-card-body">
            <div className="question-card-prompt">{current.prompt}</div>
            {current.allowMultiple && (
              <div className="question-card-hint">{t('question.multiHint')}</div>
            )}
            <div className="question-card-options" role={current.allowMultiple ? 'group' : 'radiogroup'}>
              {current.options.map((opt, i) => {
                const active = draft.selected.includes(i)
                return (
                  <button
                    key={`${current.id}-${i}`}
                    className={`question-card-option${active ? ' selected' : ''}`}
                    onClick={() => toggleOption(i, current.allowMultiple)}
                    disabled={disabled}
                    role={current.allowMultiple ? 'checkbox' : 'radio'}
                    aria-checked={active}
                  >
                    <span className="question-card-option-letter">{letters[i] ?? i + 1}</span>
                    <span className="question-card-option-label">{opt}</span>
                  </button>
                )
              })}
              <button
                key={`${current.id}-${OTHER_KEY}`}
                className={`question-card-option other${draft.otherSelected ? ' selected' : ''}`}
                onClick={() => toggleOther(current.allowMultiple)}
                disabled={disabled}
                role={current.allowMultiple ? 'checkbox' : 'radio'}
                aria-checked={draft.otherSelected}
              >
                <span className="question-card-option-letter">{letters[current.options.length] ?? '+'}</span>
                <span className="question-card-option-label">Other…</span>
              </button>
              {draft.otherSelected && (
                <input
                  className="question-card-other-input"
                  type="text"
                  autoFocus
                  placeholder={t('question.otherPlaceholder')}
                  value={draft.otherText}
                  disabled={disabled}
                  onChange={(e) => setDraft((d) => ({ ...d, otherText: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draftToAnswer({ ...draft, otherText: (e.target as HTMLInputElement).value }, current.options)) {
                      advance(false)
                    }
                  }}
                />
              )}
            </div>
          </div>

          <div className="question-card-footer">
            <button
              className="question-card-btn ghost"
              onClick={() => advance(true)}
              disabled={disabled}
            >
              Skip
            </button>
            <button
              className="question-card-btn primary"
              onClick={() => advance(false)}
              disabled={disabled || !answered}
            >
              {isLast ? 'Submit' : 'Next'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
