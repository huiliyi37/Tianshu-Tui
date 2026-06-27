import { useState, useCallback, useEffect } from 'react'
import { ChevronRight, ChevronDown, FileText, Folder, FolderOpen, Loader2 } from 'lucide-react'
import { listDir, getFileContent } from '../runtime/client'
import { FileViewer } from './FileViewer'
import type { DirEntry, FileContent } from '../runtime/types'

/**
 * FileExplorer — read-only project file browser (Gap 1).
 *
 * Two-pane: lazy tree (left) + FileViewer (right).
 * Directories expand on click (lazy-loaded, one level at a time).
 * Files open in the right pane with syntax highlighting via FileViewer.
 *
 * This is deliberately READ-ONLY — no editing, no saving. Per the "no IDE"
 * positioning (ROADMAP.md), code changes go through the agent. This browser
 * exists so the user can READ and understand the codebase the agent works in.
 */
export function FileExplorer({ sessionId }: { sessionId: string | null }) {
  const [tree, setTree] = useState<Record<string, DirEntry[]>>({}) // path → entries
  const [expanded, setExpanded] = useState<Set<string>>(new Set([''])) // root expanded by default
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [loadingDir, setLoadingDir] = useState<string | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load root on mount / sessionId change
  const loadDir = useCallback(async (dirPath: string) => {
    if (!sessionId) return
    setLoadingDir(dirPath)
    try {
      const { entries } = await listDir(sessionId, dirPath)
      setTree(prev => ({ ...prev, [dirPath]: entries }))
    } catch {
      setError('读取目录失败')
    } finally {
      setLoadingDir(null)
    }
  }, [sessionId])

  useEffect(() => {
    if (sessionId) loadDir('')
  }, [sessionId, loadDir])

  const toggleDir = useCallback(async (dirPath: string) => {
    const next = new Set(expanded)
    if (next.has(dirPath)) {
      next.delete(dirPath)
    } else {
      next.add(dirPath)
      if (!tree[dirPath]) await loadDir(dirPath)
    }
    setExpanded(next)
  }, [expanded, tree, loadDir])

  const openFile = useCallback(async (filePath: string) => {
    if (!sessionId) return
    setSelectedFile(filePath)
    setLoadingFile(true)
    setError(null)
    try {
      const content = await getFileContent(sessionId, filePath)
      setFileContent(content)
    } catch {
      setError('读取文件失败')
      setFileContent(null)
    } finally {
      setLoadingFile(false)
    }
  }, [sessionId])

  if (!sessionId) {
    return <div className="empty sm">无活动会话</div>
  }

  return (
    <div className="file-explorer">
      <div className="fe-tree-panel">
        <div className="fe-tree-header">
          <span>文件浏览器</span>
          {loadingDir !== null && <Loader2 className="fe-spinner" size={14} />}
        </div>
        <TreeNode
          dirPath=""
          name={sessionId ? '项目根目录' : ''}
          tree={tree}
          expanded={expanded}
          loadingDir={loadingDir}
          selectedFile={selectedFile}
          onToggleDir={toggleDir}
          onOpenFile={openFile}
          depth={0}
          isRoot
        />
      </div>
      <div className="fe-viewer-panel">
        {error && <div className="empty sm fe-error">{error}</div>}
        {!selectedFile && !error && (
          <div className="empty sm">选择左侧文件查看内容</div>
        )}
        {selectedFile && loadingFile && <div className="empty sm">加载中…</div>}
        {selectedFile && !loadingFile && fileContent && (
          <>
            <div className="fe-file-path">{fileContent.path}</div>
            <FileViewer
              content={fileContent.content}
              language={fileContent.language}
              startLine={fileContent.startLine}
            />
          </>
        )}
      </div>
    </div>
  )
}

interface TreeNodeProps {
  dirPath: string
  name: string
  tree: Record<string, DirEntry[]>
  expanded: Set<string>
  loadingDir: string | null
  selectedFile: string | null
  onToggleDir: (path: string) => void
  onOpenFile: (path: string) => void
  depth: number
  isRoot?: boolean
}

function TreeNode({
  dirPath, name, tree, expanded, loadingDir, selectedFile, onToggleDir, onOpenFile, depth, isRoot,
}: TreeNodeProps) {
  const isOpen = expanded.has(dirPath)
  const entries = tree[dirPath]
  const isLoadingThis = loadingDir === dirPath

  return (
    <div className="fe-node-container">
      {depth === 0 && !isRoot && null}
      {isRoot ? (
        <div
          className={`fe-dir-row ${isOpen ? 'open' : ''}`}
          onClick={() => onToggleDir(dirPath)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {isOpen ? <FolderOpen size={14} className="fe-dir-icon" /> : <Folder size={14} className="fe-dir-icon" />}
          <span className="fe-dir-name">{name}</span>
        </div>
      ) : null}

      {isOpen && (
        <div className="fe-children">
          {isLoadingThis && !entries ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {entries?.map((entry) => {
            const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name
            if (entry.isDirectory) {
              return (
                <DirRow
                  key={childPath}
                  dirPath={childPath}
                  name={entry.name}
                  tree={tree}
                  expanded={expanded}
                  loadingDir={loadingDir}
                  selectedFile={selectedFile}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  depth={depth + 1}
                />
              )
            }
            return (
              <div
                key={childPath}
                className={`fe-file-row ${selectedFile === childPath ? 'selected' : ''}`}
                onClick={() => onOpenFile(childPath)}
                style={{ paddingLeft: `${8 + (depth + 1) * 14 + 16}px` }}
                title={childPath}
              >
                <FileText size={13} className="fe-file-icon" />
                <span className="fe-file-name">{entry.name}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DirRow(props: TreeNodeProps) {
  const { dirPath, name, tree, expanded, loadingDir, selectedFile, onToggleDir, onOpenFile, depth } = props
  const isOpen = expanded.has(dirPath)
  return (
    <>
      <div
        className={`fe-dir-row ${isOpen ? 'open' : ''}`}
        onClick={() => onToggleDir(dirPath)}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {isOpen ? <FolderOpen size={14} className="fe-dir-icon" /> : <Folder size={14} className="fe-dir-icon" />}
        <span className="fe-dir-name">{name}</span>
      </div>
      {isOpen && (
        <div className="fe-children">
          {loadingDir === dirPath && !tree[dirPath] ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {tree[dirPath]?.map((entry) => {
            const childPath = `${dirPath}/${entry.name}`
            if (entry.isDirectory) {
              return (
                <DirRow
                  key={childPath}
                  dirPath={childPath}
                  name={entry.name}
                  tree={tree}
                  expanded={expanded}
                  loadingDir={loadingDir}
                  selectedFile={selectedFile}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  depth={depth + 1}
                />
              )
            }
            return (
              <div
                key={childPath}
                className={`fe-file-row ${selectedFile === childPath ? 'selected' : ''}`}
                onClick={() => onOpenFile(childPath)}
                style={{ paddingLeft: `${8 + (depth + 1) * 14 + 16}px` }}
                title={childPath}
              >
                <FileText size={13} className="fe-file-icon" />
                <span className="fe-file-name">{entry.name}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
