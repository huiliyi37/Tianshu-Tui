import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createSession, sendPrompt, abortSession } from '../runtime/client'
import { useSessionEvents } from '../state/use-session-events'
import { useSessions } from '../state/queries'
import { Markdown } from './Markdown'
import { toast } from 'sonner'
import type { ConvoBlock } from '../state/event-reducer'

// P1-4 — Side Chat (旁路提问). A lightweight secondary session in a right-hand
// drawer, so the user can ask questions without polluting the main thread's
// history (and its prefix cache). The side session is a real session created
// lazily on first send; its first prompt is prefixed with a text snapshot of
// the main thread's recent exchange for context. It shows up in the sidebar
// with a「旁路」title prefix and can be archived like any other session.

const CONTEXT_BLOCKS = 6
const CONTEXT_BLOCK_CHARS = 600

/** Build a plain-text snapshot of the main thread's recent conversation. */
export function buildSideChatContext(blocks: ConvoBlock[]): string {
  const convo = blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant')
  const recent = convo.slice(-CONTEXT_BLOCKS)
  if (recent.length === 0) return ''
  const lines = recent.map((b) => {
    const who = b.kind === 'user' ? '用户' : '助手'
    const text = b.text.length > CONTEXT_BLOCK_CHARS ? `${b.text.slice(0, CONTEXT_BLOCK_CHARS)}…` : b.text
    return `[${who}] ${text}`
  })
  return `以下是主会话最近的对话摘录（只读参考，本会话是旁路提问，不要修改文件、不要执行主任务）：\n\n${lines.join('\n\n')}\n\n---\n\n`
}

export function SideChat(props: {
  open: boolean
  onClose: () => void
  /** Main thread — used for the side session's cwd/title and context snapshot. */
  mainTitle: string
  cwd: string
  mainBlocks: ConvoBlock[]
}) {
  const { open, onClose, mainTitle, cwd, mainBlocks } = props
  const [sideId, setSideId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [creating, setCreating] = useState(false)
  const view = useSessionEvents(sideId)
  const sessions = useSessions()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Run state from the polled session list (same source the sidebar uses).
  const busy = sessions.data?.find((s) => s.id === sideId)?.status === 'running'

  const messages = useMemo(
    () => view.blocks.filter((b) => b.kind === 'user' || b.kind === 'assistant'),
    [view.blocks],
  )

  // Pin to bottom while the reply streams in.
  const lastLen = messages[messages.length - 1]?.text.length ?? 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, lastLen])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    try {
      if (!sideId) {
        setCreating(true)
        const rec = await createSession({
          cwd,
          title: `旁路 · ${mainTitle.slice(0, 24)}`,
        })
        setSideId(rec.id)
        await sendPrompt(rec.id, `${buildSideChatContext(mainBlocks)}${text}`)
      } else {
        await sendPrompt(sideId, text)
      }
    } catch (err) {
      toast.error(`旁路提问失败: ${(err as Error).message}`)
      setInput(text)
    } finally {
      setCreating(false)
    }
  }, [input, busy, sideId, cwd, mainTitle, mainBlocks])

  if (!open) return null

  return (
    <div className="sidechat-drawer" role="complementary" aria-label="旁路提问">
      <div className="sidechat-head">
        <span className="sidechat-title">旁路提问</span>
        <button className="icon-btn" onClick={onClose} aria-label="关闭旁路提问">✕</button>
      </div>
      <div className="sidechat-note" role="note">
        此对话不影响主任务——独立轻会话，携带主会话最近对话摘录作为上下文。
      </div>
      <div className="sidechat-messages" ref={scrollRef}>
        {messages.length === 0 && !creating && (
          <div className="sidechat-empty">
            问点什么…比如「这个报错是什么意思」「刚才那段 diff 有风险吗」
          </div>
        )}
        {messages.map((b) => (
          <div key={b.key} className={`sidechat-msg ${b.kind}`}>
            {b.kind === 'assistant' ? <Markdown source={b.text} /> : <span>{b.text}</span>}
          </div>
        ))}
        {(creating || busy) && <div className="sidechat-typing">思考中…</div>}
      </div>
      <div className="sidechat-input-row">
        <textarea
          value={input}
          placeholder="旁路问题（Enter 发送）"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy && sideId ? (
          <button className="btn ghost danger sm" onClick={() => void abortSession(sideId)}>停止</button>
        ) : (
          <button className="btn sm" disabled={!input.trim() || creating} onClick={() => void send()}>发送</button>
        )}
      </div>
    </div>
  )
}
