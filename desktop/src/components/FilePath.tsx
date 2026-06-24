import { openFile } from '../runtime/client'

/** Clickable file path — opens in the system editor via sidecar. */
export function FilePath({ path, className }: { path: string; className?: string }) {
  return (
    <span
      className={`file-path-link ${className ?? ''}`}
      title={`打开 ${path}`}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); void openFile(path) }}
      onKeyDown={(e) => { if (e.key === 'Enter') void openFile(path) }}
    >
      {path}
    </span>
  )
}
