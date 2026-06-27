import { useEffect, useState } from 'react'
import { getGitGraph } from '../runtime/client'

export function GitSurface() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getGitGraph(200)
      setLines(res.graph)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="surface-scroll">
      <div className="git-surface">
        <header className="git-header">
          <h3>Git 分支图</h3>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </header>

        {error && <div className="meta warn">加载失败：{error}</div>}

        {lines.length > 0 ? (
          <pre className="git-graph">{lines.join('\n')}</pre>
        ) : (
          !loading && !error && <div className="meta">暂无提交历史</div>
        )}
      </div>
    </div>
  )
}
