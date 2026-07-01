import { useState, useCallback, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  ExternalLink,
  FolderOpenIcon,
  Copy,
  Quote,
  RefreshCw,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { listDir, getFileContent, openFile as openFileInSystem } from '../runtime/client'
import { useUiDispatch } from '../state/store'
import { FileViewer } from './FileViewer'
import { Markdown } from './Markdown'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import type { DirEntry, FileContent } from '../runtime/types'

type ViewMode = 'preview' | 'source'

function joinPath(base: string, part: string): string {
  if (!base) return part
  const separator = base.includes('\\') ? '\\' : '/'
  return base.endsWith(separator) ? `${base}${part}` : `${base}${separator}${part}`
}

function parentDir(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const idx = path.lastIndexOf(separator)
  if (idx <= 0) return ''
  return path.slice(0, idx)
}

function toAbsolute(relativePath: string, cwd: string): string {
  if (!cwd) return relativePath
  const separator = cwd.includes('\\') ? '\\' : '/'
  return cwd.endsWith(separator) ? `${cwd}${relativePath}` : `${cwd}${separator}${relativePath}`
}

/**
 * FileExplorer — read-only project file browser (Gap 1).
 *
 * Two-pane: lazy tree (left) + FileViewer (right).
 * Directories expand on click (lazy-loaded, one level at a time).
 * Files open in the right pane with syntax highlighting via FileViewer.
 *
 * Adds Cursor/Codex-style context menus and multi-selection:
 * - Right-click a file to open it, reveal it in the OS file manager, copy its
 *   path, or add it as an @file mention.
 * - Ctrl/Cmd-click files to multi-select; Shift-click to range-select.
 * - Right-click a directory to open it in the file manager or copy its path.
 *
 * This is deliberately READ-ONLY — no editing, no saving. Per the "no IDE"
 * positioning (ROADMAP.md), code changes go through the agent.
 */
export function FileExplorer({ sessionId, cwd }: { sessionId: string | null; cwd?: string }) {
  const { t } = useTranslation('nav')
  const dispatch = useUiDispatch()
  const title = t('fileExplorer.title')
  const [tree, setTree] = useState<Record<string, DirEntry[]>>({}) // path → entries
  const [expanded, setExpanded] = useState<Set<string>>(new Set([''])) // root expanded by default
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [lastSelectedFile, setLastSelectedFile] = useState<string | null>(null)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<FileContent | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('source')
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
    if (sessionId) {
      loadDir('')
      setSelectedFiles(new Set())
      setLastSelectedFile(null)
      setPreviewFile(null)
      setFileContent(null)
    }
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

  const previewFileContent = useCallback(async (filePath: string) => {
    if (!sessionId) return
    setPreviewFile(filePath)
    setLoadingFile(true)
    setError(null)
    try {
      const content = await getFileContent(sessionId, filePath)
      setFileContent(content)
      setViewMode(content.language === 'markdown' ? 'preview' : 'source')
    } catch {
      setError('读取文件失败')
      setFileContent(null)
    } finally {
      setLoadingFile(false)
    }
  }, [sessionId])

  const getSiblingFiles = useCallback((path: string): string[] => {
    const parent = parentDir(path)
    const entries = tree[parent] ?? []
    return entries.filter(e => !e.isDirectory).map(e => joinPath(parent, e.name))
  }, [tree])

  const selectRange = useCallback((anchor: string, target: string) => {
    const siblings = getSiblingFiles(anchor)
    const anchorIndex = siblings.indexOf(anchor)
    const targetIndex = siblings.indexOf(target)
    if (anchorIndex === -1 || targetIndex === -1) {
      return new Set([target])
    }
    const start = Math.min(anchorIndex, targetIndex)
    const end = Math.max(anchorIndex, targetIndex)
    return new Set(siblings.slice(start, end + 1))
  }, [getSiblingFiles])

  const handleFileClick = useCallback((filePath: string, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setSelectedFiles(prev => {
        const next = new Set(prev)
        if (next.has(filePath)) next.delete(filePath)
        else next.add(filePath)
        return next
      })
      setLastSelectedFile(filePath)
    } else if (e.shiftKey && lastSelectedFile) {
      e.preventDefault()
      const range = selectRange(lastSelectedFile, filePath)
      setSelectedFiles(prev => {
        const next = new Set(prev)
        for (const p of range) next.add(p)
        return next
      })
      setLastSelectedFile(filePath)
    } else {
      setSelectedFiles(new Set([filePath]))
      setLastSelectedFile(filePath)
      void previewFileContent(filePath)
    }
  }, [lastSelectedFile, previewFileContent, selectRange])

  const handleFileContextMenu = useCallback((filePath: string) => {
    setSelectedFiles(prev => {
      if (prev.has(filePath)) return prev
      return new Set([filePath])
    })
    setLastSelectedFile(filePath)
  }, [])

  const openSelectedFile = useCallback((path: string) => {
    void openFileInSystem(path)
  }, [])

  const revealSelectedFile = useCallback((path: string) => {
    void openFileInSystem(path, true)
  }, [])

  const openDirectory = useCallback((dirPath: string) => {
    void openFileInSystem(dirPath || '.')
  }, [])

  const copyToClipboard = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
  }, [])

  const addToContext = useCallback((paths: string[]) => {
    dispatch({ type: 'addComposerAttachments', paths })
  }, [dispatch])

  const refreshDir = useCallback((dirPath: string) => {
    void loadDir(dirPath)
  }, [loadDir])

  if (!sessionId) {
    return <div className="empty sm">无活动会话</div>
  }

  return (
    <div className="file-explorer">
      <div className="fe-tree-panel">
        <div className="fe-tree-header">
          <span>{title}</span>
          {loadingDir !== null && <Loader2 className="fe-spinner" size={14} />}
        </div>
        <TreeNode
          dirPath=""
          name={sessionId ? '项目根目录' : ''}
          tree={tree}
          expanded={expanded}
          loadingDir={loadingDir}
          selectedFiles={selectedFiles}
          onToggleDir={toggleDir}
          onFileClick={handleFileClick}
          onFileContextMenu={handleFileContextMenu}
          onOpenDirectory={openDirectory}
          onRevealFile={revealSelectedFile}
          onOpenFile={openSelectedFile}
          onCopyPath={copyToClipboard}
          onAddToContext={addToContext}
          onRefreshDir={refreshDir}
          cwd={cwd}
          depth={0}
          isRoot
        />
      </div>
      <div className="fe-viewer-panel">
        {error && <div className="empty sm fe-error">{error}</div>}
        {!previewFile && !error && (
          <div className="empty sm">选择左侧文件查看内容</div>
        )}
        {previewFile && loadingFile && <div className="empty sm">加载中…</div>}
        {previewFile && !loadingFile && fileContent && (
          <>
            <div className="fe-viewer-toolbar">
              <Breadcrumb path={fileContent.path} />
              {fileContent.language === 'markdown' && (
                <div className="fe-segmented" role="tablist">
                  <button
                    className={`fe-seg-btn ${viewMode === 'preview' ? 'active' : ''}`}
                    onClick={() => setViewMode('preview')}
                    role="tab"
                    aria-selected={viewMode === 'preview'}
                  >
                    预览
                  </button>
                  <button
                    className={`fe-seg-btn ${viewMode === 'source' ? 'active' : ''}`}
                    onClick={() => setViewMode('source')}
                    role="tab"
                    aria-selected={viewMode === 'source'}
                  >
                    源码
                  </button>
                </div>
              )}
            </div>
            {viewMode === 'preview' && fileContent.language === 'markdown' ? (
              <div className="fe-doc">
                <Markdown source={fileContent.content} />
              </div>
            ) : (
              <FileViewer
                content={fileContent.content}
                language={fileContent.language}
                startLine={fileContent.startLine}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Cursor-style path breadcrumb: dir › dir › file, with the filename emphasized. */
function Breadcrumb({ path }: { path: string }) {
  const segments = path.split(/[/\\]/).filter(Boolean)
  return (
    <div className="fe-breadcrumb" title={path}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        return (
          <span key={i} className="fe-crumb-group">
            {i > 0 && <span className="fe-crumb-sep" aria-hidden>›</span>}
            <span className={`fe-crumb ${isLast ? 'current' : ''}`}>{seg}</span>
          </span>
        )
      })}
    </div>
  )
}

interface TreeNodeProps {
  dirPath: string
  name: string
  tree: Record<string, DirEntry[]>
  expanded: Set<string>
  loadingDir: string | null
  selectedFiles: Set<string>
  onToggleDir: (path: string) => void
  onFileClick: (path: string, e: React.MouseEvent) => void
  onFileContextMenu: (path: string) => void
  onOpenDirectory: (path: string) => void
  onRevealFile: (path: string) => void
  onOpenFile: (path: string) => void
  onCopyPath: (text: string) => void
  onAddToContext: (paths: string[]) => void
  onRefreshDir: (path: string) => void
  cwd?: string
  depth: number
  isRoot?: boolean
}

function TreeNode({
  dirPath, name, tree, expanded, loadingDir, selectedFiles, onToggleDir, onFileClick,
  onFileContextMenu, onOpenDirectory, onRevealFile, onOpenFile, onCopyPath, onAddToContext,
  onRefreshDir, cwd, depth, isRoot,
}: TreeNodeProps) {
  const { t } = useTranslation('nav')
  const isOpen = expanded.has(dirPath)
  const entries = tree[dirPath]
  const isLoadingThis = loadingDir === dirPath

  const dirMenu = (
    <ContextMenuContent align="start" side="right" sideOffset={4}>
      <ContextMenuItem onClick={() => onOpenDirectory(dirPath)}>
        <FolderOpenIcon size={14} />
        {t('fileExplorer.openFolder')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(dirPath, cwd) : dirPath || cwd || '.')}>
        <Copy size={14} />
        {t('fileExplorer.copyAbsolutePath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onRefreshDir(dirPath)}>
        <RefreshCw size={14} />
        {t('fileExplorer.refresh')}
      </ContextMenuItem>
    </ContextMenuContent>
  )

  return (
    <div className="fe-node-container">
      {isRoot ? (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div
                className={`fe-dir-row ${isOpen ? 'open' : ''}`}
                onClick={() => onToggleDir(dirPath)}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {isOpen ? <FolderOpen size={14} className="fe-dir-icon" /> : <Folder size={14} className="fe-dir-icon" />}
                <span className="fe-dir-name">{name}</span>
              </div>
            }
          />
          {dirMenu}
        </ContextMenu>
      ) : null}

      {isOpen && (
        <div className="fe-children">
          {isLoadingThis && !entries ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {entries?.map((entry) => {
            const childPath = joinPath(dirPath, entry.name)
            if (entry.isDirectory) {
              return (
                <DirRow
                  key={childPath}
                  dirPath={childPath}
                  name={entry.name}
                  tree={tree}
                  expanded={expanded}
                  loadingDir={loadingDir}
                  selectedFiles={selectedFiles}
                  onToggleDir={onToggleDir}
                  onFileClick={onFileClick}
                  onFileContextMenu={onFileContextMenu}
                  onOpenDirectory={onOpenDirectory}
                  onRevealFile={onRevealFile}
                  onOpenFile={onOpenFile}
                  onCopyPath={onCopyPath}
                  onAddToContext={onAddToContext}
                  onRefreshDir={onRefreshDir}
                  cwd={cwd}
                  depth={depth + 1}
                />
              )
            }
            const isSelected = selectedFiles.has(childPath)
            return (
              <ContextMenu key={childPath}>
                <ContextMenuTrigger
                  render={
                    <div
                      className={`fe-file-row ${isSelected ? 'selected' : ''}`}
                      onClick={(e) => onFileClick(childPath, e)}
                      onContextMenu={() => onFileContextMenu(childPath)}
                      style={{ paddingLeft: `${8 + (depth + 1) * 14 + 16}px` }}
                      title={childPath}
                    >
                      <FileText size={13} className="fe-file-icon" />
                      <span className="fe-file-name">{entry.name}</span>
                    </div>
                  }
                />
                <ContextMenuContent align="start" side="right" sideOffset={4}>
                  <ContextMenuItem onClick={() => onOpenFile(childPath)}>
                    <ExternalLink size={14} />
                    {t('fileExplorer.openFile')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onRevealFile(childPath)}>
                    <FolderOpenIcon size={14} />
                    {navigator.platform.startsWith('Win') ? t('fileExplorer.revealInExplorer') : t('fileExplorer.revealInFinder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onCopyPath(childPath)}>
                    <Copy size={14} />
                    {t('fileExplorer.copyRelativePath')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(childPath, cwd) : childPath)}>
                    <Copy size={14} />
                    {t('fileExplorer.copyAbsolutePath')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onAddToContext([...selectedFiles].length > 0 ? [...selectedFiles] : [childPath])}>
                    <Quote size={14} />
                    {selectedFiles.size > 1
                      ? t('fileExplorer.addNToContext', { count: selectedFiles.size })
                      : t('fileExplorer.addToContext')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DirRow(props: TreeNodeProps) {
  const {
    dirPath, name, tree, expanded, loadingDir, selectedFiles, onToggleDir, onFileClick,
    onFileContextMenu, onOpenDirectory, onRevealFile, onOpenFile, onCopyPath, onAddToContext,
    onRefreshDir, cwd, depth,
  } = props
  const { t } = useTranslation('nav')
  const isOpen = expanded.has(dirPath)
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
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
          </>
        }
      />
      <ContextMenuContent align="start" side="right" sideOffset={4}>
        <ContextMenuItem onClick={() => onOpenDirectory(dirPath)}>
          <FolderOpenIcon size={14} />
          {t('fileExplorer.openFolder')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(dirPath, cwd) : dirPath || cwd || '.')}>
          <Copy size={14} />
          {t('fileExplorer.copyAbsolutePath')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onRefreshDir(dirPath)}>
          <RefreshCw size={14} />
          {t('fileExplorer.refresh')}
        </ContextMenuItem>
      </ContextMenuContent>
      {isOpen && (
        <div className="fe-children">
          {loadingDir === dirPath && !tree[dirPath] ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {tree[dirPath]?.map((entry) => {
            const childPath = joinPath(dirPath, entry.name)
            if (entry.isDirectory) {
              return (
                <DirRow
                  key={childPath}
                  dirPath={childPath}
                  name={entry.name}
                  tree={tree}
                  expanded={expanded}
                  loadingDir={loadingDir}
                  selectedFiles={selectedFiles}
                  onToggleDir={onToggleDir}
                  onFileClick={onFileClick}
                  onFileContextMenu={onFileContextMenu}
                  onOpenDirectory={onOpenDirectory}
                  onRevealFile={onRevealFile}
                  onOpenFile={onOpenFile}
                  onCopyPath={onCopyPath}
                  onAddToContext={onAddToContext}
                  onRefreshDir={onRefreshDir}
                  cwd={cwd}
                  depth={depth + 1}
                />
              )
            }
            const isSelected = selectedFiles.has(childPath)
            return (
              <ContextMenu key={childPath}>
                <ContextMenuTrigger
                  render={
                    <div
                      className={`fe-file-row ${isSelected ? 'selected' : ''}`}
                      onClick={(e) => onFileClick(childPath, e)}
                      onContextMenu={() => onFileContextMenu(childPath)}
                      style={{ paddingLeft: `${8 + (depth + 1) * 14 + 16}px` }}
                      title={childPath}
                    >
                      <FileText size={13} className="fe-file-icon" />
                      <span className="fe-file-name">{entry.name}</span>
                    </div>
                  }
                />
                <ContextMenuContent align="start" side="right" sideOffset={4}>
                  <ContextMenuItem onClick={() => onOpenFile(childPath)}>
                    <ExternalLink size={14} />
                    {t('fileExplorer.openFile')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onRevealFile(childPath)}>
                    <FolderOpenIcon size={14} />
                    {navigator.platform.startsWith('Win') ? t('fileExplorer.revealInExplorer') : t('fileExplorer.revealInFinder')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onCopyPath(childPath)}>
                    <Copy size={14} />
                    {t('fileExplorer.copyRelativePath')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(childPath, cwd) : childPath)}>
                    <Copy size={14} />
                    {t('fileExplorer.copyAbsolutePath')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onAddToContext(selectedFiles.size > 0 ? [...selectedFiles] : [childPath])}>
                    <Quote size={14} />
                    {selectedFiles.size > 1
                      ? t('fileExplorer.addNToContext', { count: selectedFiles.size })
                      : t('fileExplorer.addToContext')}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            )
          })}
        </div>
      )}
    </ContextMenu>
  )
}
