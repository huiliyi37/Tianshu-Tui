import { useEffect, useMemo, useState } from 'react'
import { getGitGraph } from '../runtime/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200]
const DEFAULT_PAGE_SIZE = 50
const FETCH_COUNT = 500

export function GitSurface() {
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await getGitGraph(FETCH_COUNT)
      setLines(res.graph)
      setPage(0)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize))
  const safePage = Math.min(page, totalPages - 1)
  const start = safePage * pageSize
  const end = start + pageSize
  const pageLines = useMemo(() => lines.slice(start, end), [lines, start, end])

  const goPage = (next: number) => {
    setPage(Math.max(0, Math.min(next, totalPages - 1)))
  }

  const handlePageSizeChange = (value: string) => {
    const size = Number(value)
    setPageSize(size)
    setPage(0)
  }

  return (
    <div className="surface-scroll">
      <div className="git-surface">
        <header className="git-header">
          <div>
            <h3>Git 分支图</h3>
            {lines.length > 0 && (
              <div className="git-meta">
                共 {lines.length} 行，第 {safePage + 1} / {totalPages} 页
              </div>
            )}
          </div>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </header>

        {error && <div className="meta warn">加载失败：{error}</div>}

        {loading && lines.length === 0 && (
          <div className="git-empty">加载中…</div>
        )}

        {!loading && lines.length === 0 && !error && (
          <div className="git-empty">暂无提交历史</div>
        )}

        {lines.length > 0 && (
          <>
            <pre className="git-graph">{pageLines.join('\n')}</pre>

            <div className="git-pagination">
              <div className="git-page-range">
                {start + 1} – {Math.min(end, lines.length)} / {lines.length}
              </div>

              <div className="git-page-controls">
                <button
                  className="btn sm ghost"
                  onClick={() => goPage(0)}
                  disabled={safePage === 0}
                >
                  首页
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => goPage(safePage - 1)}
                  disabled={safePage === 0}
                >
                  上一页
                </button>

                <span className="git-page-info">
                  {safePage + 1} / {totalPages}
                </span>

                <button
                  className="btn sm ghost"
                  onClick={() => goPage(safePage + 1)}
                  disabled={safePage >= totalPages - 1}
                >
                  下一页
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => goPage(totalPages - 1)}
                  disabled={safePage >= totalPages - 1}
                >
                  末页
                </button>
              </div>

              <div className="git-page-size">
                <span>每页</span>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => v && handlePageSizeChange(v)}
                >
                  <SelectTrigger className="w-[72px]">
                    <SelectValue placeholder="每页" />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZE_OPTIONS.map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span>行</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
