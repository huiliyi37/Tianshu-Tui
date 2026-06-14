import { useState } from 'react'
import { pickFolder } from '../lib/dialog'
import type { ApprovalMode } from '../runtime/types'
import { AutonomyControl } from './AutonomyControl'
import { coerceLevel, levelToMode, type AutonomyLevel } from '../lib/autonomy'
import { loadDefaultAutonomy } from '../lib/persist'

/**
 * New thread in a project (P1). The folder typed/picked here becomes the session
 * cwd; the runtime's path-grants + self/world locus enforce the boundary at the
 * tool layer. cwd is prefilled with the active project so threads land in it.
 * The autonomy selector (S) sets the session's approval mode up front so an
 * unattended run can start without per-tool prompts.
 */
export function NewSessionDialog(props: {
  defaultCwd?: string | null
  onCreate: (input: { cwd?: string; title?: string; prompt?: string; approvalMode?: ApprovalMode }) => void
  onClose: () => void
}) {
  const { defaultCwd, onCreate, onClose } = props
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState(defaultCwd ?? '')
  const [prompt, setPrompt] = useState('')
  const [level, setLevel] = useState<AutonomyLevel>(() => coerceLevel(loadDefaultAutonomy()))

  const browse = async () => {
    const picked = await pickFolder()
    if (picked) setCwd(picked)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建线程</h3>
        <label className="meta">标题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可选" />
        <label className="meta">项目目录 (cwd)</label>
        <div className="field-row">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="留空 = sidecar 启动目录"
          />
          <button className="btn ghost sm" onClick={browse}>选择…</button>
        </div>
        <label className="meta">首条任务</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="可选，留空则先创建空闲线程"
        />
        <label className="meta">自治档位</label>
        <AutonomyControl value={level} onChange={setLevel} />
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn"
            onClick={() => onCreate({
              title: title.trim() || undefined,
              cwd: cwd.trim() || undefined,
              prompt: prompt.trim() || undefined,
              approvalMode: levelToMode(level),
            })}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
