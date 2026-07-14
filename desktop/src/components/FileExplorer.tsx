import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
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
import { toast } from 'sonner'
import { listDir, getFileContent, openFile as openFileInSystem } from '../runtime/client'
import { useFileDiff } from '../state/queries'
import { useUiDispatch, useUiState } from '../state/store'
import type { ComposerAttachment } from '../state/store'
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

/** 从 cwd 或已有路径中检测平台分隔符——Windows 用 \，其他用 /。 */
function detectSep(cwdOrPath: string): string {
  return cwdOrPath.includes('\\') ? '\\' : '/'
}

function joinPath(base: string, part: string): string {
  if (!base) return part
  const separator = detectSep(base)
  return base.endsWith(separator) ? `${base}${part}` : `${base}${separator}${part}`
}

function parentDir(path: string): string {
  const separator = detectSep(path)
  const idx = path.lastIndexOf(separator)
  if (idx <= 0) return ''
  return path.slice(0, idx)
}

/** 拼接绝对路径，并将 relativePath 中的分隔符归一化为 cwd 的分隔符。
 *  避免 Windows 上出现 D:\project\src/index.ts 这类混合分隔符，
 *  导致 explorer 或 Start-Process 静默失败。 */
function toAbsolute(relativePath: string, cwd: string): string {
  if (!cwd) return relativePath
  const separator = detectSep(cwd)
  // 归一化：把相对路径中的 / 和 \ 统一为 cwd 的分隔符
  const normalizedRel = relativePath.replace(/[/\\]/g, separator)
  return cwd.endsWith(separator) ? `${cwd}${normalizedRel}` : `${cwd}${separator}${normalizedRel}`
}

/** Codex 对标（Wave 4）：从 unified diff 提取新文件计数下的新增/修改行号，
 *  供 FileViewer 渲染 diff 底色。 */
function addedLinesFromUnifiedDiff(diff: string): number[] {
  const added: number[] = []
  let newLine = 0
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      added.push(newLine)
      newLine++
    } else if (!line.startsWith('-') && newLine > 0) {
      newLine++
    }
  }
  return added
}

/** Convert an absolute or ./-prefixed path into a path relative to cwd,
 *  normalizing separators to cwd's platform separator.
 *  Falls back to the original path if it does not live under cwd. */
function toRelative(path: string, cwd: string): string {
  if (!cwd) return path.replace(/^\.\//, '')
  const separator = detectSep(cwd)
  const normalized = path.replace(/[/\\]/g, separator).replace(/^\.\//, '')
  const prefix = cwd.endsWith(separator) ? cwd : `${cwd}${separator}`
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  return normalized
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
 * - Right-click a directory to open it, copy its path, or add it as an @folder
 *   mention (the agent resolves @folder: refs).
 * - Ctrl/Cmd-click files to multi-select; Shift-click to range-select.
 * - Cmd/Ctrl+C copies selected paths; Enter opens the last-selected file.
 * - The viewer toolbar can copy the open file's path, @-reference it, or reveal
 *   it in the OS; breadcrumb segments copy their cumulative path.
 * - Tree header can refresh all expanded dirs or collapse the whole tree.
 *
 * This is deliberately READ-ONLY — no editing, no saving. Per the "no IDE"
 * positioning (ROADMAP.md), code changes go through the agent.
 */
export function FileExplorer({ sessionId, cwd }: { sessionId: string | null; cwd?: string }) {
  const { t } = useTranslation('nav')
  const dispatch = useUiDispatch()
  const ui = useUiState()
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
  const treePanelRef = useRef<HTMLDivElement>(null)

  // Codex 对标（Wave 4）：预览文件时顺带取其相对基线的 unified diff，
  // 命中的新增/修改行在查看器里加绿色底色（只读，不做编辑）。
  const fileDiff = useFileDiff(previewFile, sessionId)
  const diffAddedLines = useMemo(
    () => (fileDiff.data?.diff ? addedLinesFromUnifiedDiff(fileDiff.data.diff) : []),
    [fileDiff.data],
  )

  // Load root on mount / sessionId change
  const loadDir = useCallback(async (dirPath: string) => {
    if (!sessionId) return
    setLoadingDir(dirPath)
    try {
      const { entries } = await listDir(sessionId, dirPath)
      setTree(prev => ({ ...prev, [dirPath]: entries }))
    } catch {
      setError(t('fileExplorer.readDirFailed'))
    } finally {
      setLoadingDir(null)
    }
  }, [sessionId, t])

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
      setError(t('fileExplorer.readFileFailed'))
      setFileContent(null)
    } finally {
      setLoadingFile(false)
    }
  }, [sessionId, t])

  // Reveal a file requested from elsewhere (e.g. double-clicking a FilePath in
  // the thread). Expand parent dirs, select the row, and preview the file.
  const revealFile = useCallback(async (rawPath: string) => {
    if (!sessionId) return
    const rel = cwd ? toRelative(rawPath, cwd) : rawPath.replace(/^\.\//, '')
    if (!rel) return
    const sep = detectSep(cwd ?? rel)
    const normalized = rel.replace(/[/\\]/g, sep)
    const segments = normalized.split(sep).filter(Boolean)
    if (segments.length === 0) return

    // Build and expand every parent directory along the path.
    const dirs: string[] = ['']
    let built = ''
    for (let i = 0; i < segments.length - 1; i++) {
      built = built ? `${built}${sep}${segments[i]}` : segments[i]
      dirs.push(built)
    }
    setExpanded(prev => new Set([...prev, ...dirs]))
    for (const dir of dirs) {
      if (!tree[dir]) await loadDir(dir)
    }

    const filePath = segments.join(sep)
    setSelectedFiles(new Set([filePath]))
    setLastSelectedFile(filePath)
    treePanelRef.current?.focus()
    await previewFileContent(filePath)
  }, [sessionId, cwd, tree, loadDir, previewFileContent])

  useEffect(() => {
    const req = ui.revealFileRequest
    if (!req?.path || !sessionId) return
    void revealFile(req.path)
  }, [ui.revealFileRequest, sessionId, revealFile])

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
    treePanelRef.current?.focus()
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
    treePanelRef.current?.focus()
    setSelectedFiles(prev => {
      if (prev.has(filePath)) return prev
      return new Set([filePath])
    })
    setLastSelectedFile(filePath)
  }, [])

  const openSelectedFile = useCallback((path: string) => {
    // 用 cwd 拼绝对路径——避免相对路径在服务端 path.resolve 时
    // 依赖 process.cwd()（桌面端 sidecar 的 cwd 不一定是项目根）。
    const absPath = cwd ? toAbsolute(path, cwd) : path
    openFileInSystem(absPath).catch((e) => toast.error(t('fileExplorer.openFailed', { message: (e as Error).message })))
  }, [cwd, t])

  const revealSelectedFile = useCallback((path: string) => {
    openFileInSystem(path, true).catch((e) => toast.error(t('fileExplorer.revealFailed', { message: (e as Error).message })))
  }, [t])

  const openDirectory = useCallback((dirPath: string) => {
    // 传绝对路径——后端 resolve 依赖 cwd，sidecar cwd 不一定是项目根。
    const abs = cwd ? toAbsolute(dirPath || '.', cwd) : (dirPath || '.')
    openFileInSystem(abs).catch((e) => toast.error(t('fileExplorer.openFolderFailed', { message: (e as Error).message })))
  }, [cwd, t])

  const copyToClipboard = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(t('fileExplorer.copied')),
      () => toast.error(t('fileExplorer.copyFailed')),
    )
  }, [t])

  const addToContext = useCallback((items: ComposerAttachment[]) => {
    if (items.length === 0) return
    dispatch({ type: 'addComposerAttachments', items })
    toast.success(t('fileExplorer.addedToContext'))
  }, [dispatch, t])

  const refreshDir = useCallback((dirPath: string) => {
    void loadDir(dirPath)
  }, [loadDir])

  const refreshAll = useCallback(() => {
    for (const dirPath of expanded) void loadDir(dirPath)
  }, [expanded, loadDir])

  const collapseAll = useCallback(() => {
    setExpanded(new Set(['']))
  }, [])

  // Keyboard shortcuts scoped to the tree panel (avoids hijacking viewer text copy):
  // Cmd/Ctrl+C copies the selected files' relative paths; Enter opens the last one.
  const handleTreeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      if (selectedFiles.size > 0) {
        e.preventDefault()
        copyToClipboard([...selectedFiles].join('\n'))
      }
    } else if (e.key === 'Enter' && lastSelectedFile) {
      e.preventDefault()
      void previewFileContent(lastSelectedFile)
    }
  }, [selectedFiles, lastSelectedFile, copyToClipboard, previewFileContent])

  if (!sessionId) {
    return <div className="empty sm">{t('fileExplorer.noActiveSession')}</div>
  }

  const viewerRel = previewFile ?? ''
  const viewerAbs = cwd ? toAbsolute(viewerRel, cwd) : viewerRel

  return (
    <div className="file-explorer">
      <div
        className="fe-tree-panel"
        ref={treePanelRef}
        tabIndex={0}
        onKeyDown={handleTreeKeyDown}
      >
        <div className="fe-tree-header">
          <span>{title}</span>
          {loadingDir !== null && <Loader2 className="fe-spinner" size={14} />}
          <span className="fe-header-actions">
            <button className="fe-header-btn" onClick={refreshAll} title={t('fileExplorer.refreshAll')} aria-label={t('fileExplorer.refreshAll')}>
              <RefreshCw size={13} />
            </button>
            <button className="fe-header-btn" onClick={collapseAll} title={t('fileExplorer.collapseAll')} aria-label={t('fileExplorer.collapseAll')}>
              <ChevronsDownUp size={13} />
            </button>
          </span>
        </div>
        <TreeNode
          dirPath=""
          name={sessionId ? t('fileExplorer.projectRoot') : ''}
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
          <div className="empty sm">{t('fileExplorer.selectFileHint')}</div>
        )}
        {previewFile && loadingFile && <div className="empty sm">{t('common:loading')}</div>}
        {previewFile && !loadingFile && fileContent && (
          <>
            <div className="fe-viewer-toolbar">
              <Breadcrumb path={fileContent.path} onCopySegment={copyToClipboard} />
              <div className="fe-viewer-actions">
                {fileContent.language === 'markdown' && (
                  <div className="fe-segmented" role="tablist">
                    <button
                      className={`fe-seg-btn ${viewMode === 'preview' ? 'active' : ''}`}
                      onClick={() => setViewMode('preview')}
                      role="tab"
                      aria-selected={viewMode === 'preview'}
                    >
                      {t('fileExplorer.preview')}
                    </button>
                    <button
                      className={`fe-seg-btn ${viewMode === 'source' ? 'active' : ''}`}
                      onClick={() => setViewMode('source')}
                      role="tab"
                      aria-selected={viewMode === 'source'}
                    >
                      {t('fileExplorer.source')}
                    </button>
                  </div>
                )}
                <button className="fe-tool-btn" onClick={() => copyToClipboard(viewerAbs)} title={t('fileExplorer.copyPath')} aria-label={t('fileExplorer.copyPath')}>
                  <Copy size={14} />
                </button>
                <button className="fe-tool-btn" onClick={() => addToContext([{ path: viewerRel, kind: 'file' }])} title={t('fileExplorer.atReference')} aria-label={t('fileExplorer.atReference')}>
                  <Quote size={14} />
                </button>
                <button className="fe-tool-btn" onClick={() => revealSelectedFile(viewerAbs)} title={t('fileExplorer.revealInSystem')} aria-label={t('fileExplorer.revealInSystem')}>
                  <FolderOpenIcon size={14} />
                </button>
              </div>
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
                diffAddedLines={diffAddedLines}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Cursor-style path breadcrumb: dir › dir › file, with the filename emphasized.
 *  Clicking a segment copies its cumulative path (dir1/dir2/…/seg). */
function Breadcrumb({ path, onCopySegment }: { path: string; onCopySegment: (text: string) => void }) {
  const separator = path.includes('\\') ? '\\' : '/'
  const leadingSep = path.startsWith('/') ? '/' : ''
  const segments = path.split(/[/\\]/).filter(Boolean)
  return (
    <div className="fe-breadcrumb" title={path}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1
        const cumulative = leadingSep + segments.slice(0, i + 1).join(separator)
        return (
          <span key={i} className="fe-crumb-group">
            {i > 0 && <span className="fe-crumb-sep" aria-hidden>›</span>}
            <button
              type="button"
              className={`fe-crumb ${isLast ? 'current' : ''}`}
              onClick={() => onCopySegment(cumulative)}
              title={cumulative}
            >
              {seg}
            </button>
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
  onAddToContext: (items: ComposerAttachment[]) => void
  onRefreshDir: (path: string) => void
  cwd?: string
  depth: number
  isRoot?: boolean
}

/** Shared directory context-menu items (root + subdirs stay in sync). */
function DirMenuItems({
  dirPath, cwd, onOpenDirectory, onCopyPath, onAddToContext, onRefreshDir,
}: Pick<TreeNodeProps, 'dirPath' | 'cwd' | 'onOpenDirectory' | 'onCopyPath' | 'onAddToContext' | 'onRefreshDir'>) {
  const { t } = useTranslation('nav')
  const relative = dirPath || '.'
  return (
    <ContextMenuContent align="start" side="right" sideOffset={4}>
      <ContextMenuItem onClick={() => onOpenDirectory(dirPath)}>
        <FolderOpenIcon size={14} />
        {t('fileExplorer.openFolder')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCopyPath(relative)}>
        <Copy size={14} />
        {t('fileExplorer.copyRelativePath')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(dirPath, cwd) : dirPath || cwd || '.')}>
        <Copy size={14} />
        {t('fileExplorer.copyAbsolutePath')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAddToContext([{ path: relative, kind: 'folder' }])}>
        <Quote size={14} />
        {t('fileExplorer.addFolderToContext')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onRefreshDir(dirPath)}>
        <RefreshCw size={14} />
        {t('fileExplorer.refresh')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Shared file context-menu items (used by both TreeNode + DirRow file rows). */
function FileMenuItems({
  filePath, cwd, selectedFiles, onOpenFile, onRevealFile, onCopyPath, onAddToContext,
}: {
  filePath: string
  cwd?: string
  selectedFiles: Set<string>
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
  onCopyPath: (text: string) => void
  onAddToContext: (items: ComposerAttachment[]) => void
}) {
  const { t } = useTranslation('nav')
  const targets = selectedFiles.size > 0 ? [...selectedFiles] : [filePath]
  return (
    <ContextMenuContent align="start" side="right" sideOffset={4}>
      <ContextMenuItem onClick={() => onOpenFile(filePath)}>
        <ExternalLink size={14} />
        {t('fileExplorer.openFile')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onRevealFile(cwd ? toAbsolute(filePath, cwd) : filePath)}>
        <FolderOpenIcon size={14} />
        {navigator.platform.startsWith('Win') ? t('fileExplorer.revealInExplorer') : t('fileExplorer.revealInFinder')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onCopyPath(filePath)}>
        <Copy size={14} />
        {t('fileExplorer.copyRelativePath')}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onCopyPath(cwd ? toAbsolute(filePath, cwd) : filePath)}>
        <Copy size={14} />
        {t('fileExplorer.copyAbsolutePath')}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => onAddToContext(targets.map((p) => ({ path: p, kind: 'file' as const })))}>
        <Quote size={14} />
        {selectedFiles.size > 1
          ? t('fileExplorer.addNToContext', { count: selectedFiles.size })
          : t('fileExplorer.addToContext')}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** A single file row with its context menu (shared by TreeNode + DirRow). */
function FileRow({
  childPath, name, selectedFiles, depth, cwd,
  onFileClick, onFileContextMenu, onOpenFile, onRevealFile, onCopyPath, onAddToContext,
}: {
  childPath: string
  name: string
  selectedFiles: Set<string>
  depth: number
  cwd?: string
  onFileClick: (path: string, e: React.MouseEvent) => void
  onFileContextMenu: (path: string) => void
  onOpenFile: (path: string) => void
  onRevealFile: (path: string) => void
  onCopyPath: (text: string) => void
  onAddToContext: (items: ComposerAttachment[]) => void
}) {
  const isSelected = selectedFiles.has(childPath)
  return (
    <ContextMenu>
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
            <span className="fe-file-name">{name}</span>
          </div>
        }
      />
      <FileMenuItems
        filePath={childPath}
        cwd={cwd}
        selectedFiles={selectedFiles}
        onOpenFile={onOpenFile}
        onRevealFile={onRevealFile}
        onCopyPath={onCopyPath}
        onAddToContext={onAddToContext}
      />
    </ContextMenu>
  )
}

function renderChild(entry: DirEntry, dirPath: string, props: TreeNodeProps) {
  const childPath = joinPath(dirPath, entry.name)
  if (entry.isDirectory) {
    return <DirRow key={childPath} {...props} dirPath={childPath} name={entry.name} depth={props.depth + 1} isRoot={undefined} />
  }
  return (
    <FileRow
      key={childPath}
      childPath={childPath}
      name={entry.name}
      selectedFiles={props.selectedFiles}
      depth={props.depth}
      cwd={props.cwd}
      onFileClick={props.onFileClick}
      onFileContextMenu={props.onFileContextMenu}
      onOpenFile={props.onOpenFile}
      onRevealFile={props.onRevealFile}
      onCopyPath={props.onCopyPath}
      onAddToContext={props.onAddToContext}
    />
  )
}

function TreeNode(props: TreeNodeProps) {
  const { dirPath, name, tree, expanded, loadingDir, onToggleDir, depth, isRoot } = props
  const isOpen = expanded.has(dirPath)
  const entries = tree[dirPath]
  const isLoadingThis = loadingDir === dirPath

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
          <DirMenuItems
            dirPath={dirPath}
            cwd={props.cwd}
            onOpenDirectory={props.onOpenDirectory}
            onCopyPath={props.onCopyPath}
            onAddToContext={props.onAddToContext}
            onRefreshDir={props.onRefreshDir}
          />
        </ContextMenu>
      ) : null}

      {isOpen && (
        <div className="fe-children">
          {isLoadingThis && !entries ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {entries?.map((entry) => renderChild(entry, dirPath, props))}
        </div>
      )}
    </div>
  )
}

function DirRow(props: TreeNodeProps) {
  const { dirPath, name, tree, expanded, loadingDir, onToggleDir, depth } = props
  const isOpen = expanded.has(dirPath)
  return (
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
      <DirMenuItems
        dirPath={dirPath}
        cwd={props.cwd}
        onOpenDirectory={props.onOpenDirectory}
        onCopyPath={props.onCopyPath}
        onAddToContext={props.onAddToContext}
        onRefreshDir={props.onRefreshDir}
      />
      {isOpen && (
        <div className="fe-children">
          {loadingDir === dirPath && !tree[dirPath] ? (
            <div className="fe-loading" style={{ paddingLeft: `${8 + (depth + 1) * 14}px` }}>
              <Loader2 className="fe-spinner" size={12} />
            </div>
          ) : null}
          {tree[dirPath]?.map((entry) => renderChild(entry, dirPath, props))}
        </div>
      )}
    </ContextMenu>
  )
}
