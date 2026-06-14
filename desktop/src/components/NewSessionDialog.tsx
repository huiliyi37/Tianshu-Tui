import { useState } from 'react'

/**
 * M1 — Project entry. Antigravity 2.0 sessions belong to a "project" (one or
 * more folders with their own permission boundary) rather than a single repo.
 * The folder typed here becomes the session cwd; the runtime's path-grants +
 * self/world locus enforce the boundary at the tool layer. A native folder
 * picker (@tauri-apps/plugin-dialog) is a drop-in upgrade later.
 */
export function NewSessionDialog(props: {
  onCreate: (input: { cwd?: string; title?: string; prompt?: string }) => void
  onClose: () => void
}) {
  const { onCreate, onClose } = props
  const [title, setTitle] = useState('')
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        <label className="meta">标题</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可选" />
        <label className="meta">项目目录 (cwd)</label>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder="留空 = sidecar 启动目录"
        />
        <label className="meta">首条任务</label>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="可选，留空则先创建空闲会话" />
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn"
            onClick={() => onCreate({
              title: title.trim() || undefined,
              cwd: cwd.trim() || undefined,
              prompt: prompt.trim() || undefined,
            })}
          >
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
