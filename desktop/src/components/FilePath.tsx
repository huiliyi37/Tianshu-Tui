import { useTranslation } from 'react-i18next'
import { openFile } from '../runtime/client'
import { useUiDispatch } from '../state/store'

/** Clickable file path — single-click opens in the system editor;
 *  Ctrl/Cmd+click (or double-click) reveals the file in the right-side FileExplorer. */
export function FilePath({ path, className }: { path: string; className?: string }) {
  const { t } = useTranslation('threadView')
  const dispatch = useUiDispatch()
  const reveal = (e: React.MouseEvent) => {
    e.stopPropagation()
    dispatch({ type: 'requestRevealFile', path })
  }
  return (
    <span
      className={`file-path-link ${className ?? ''}`}
      title={t('file.openTitle', { path })}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        if (e.ctrlKey || e.metaKey) {
          reveal(e)
        } else {
          void openFile(path)
        }
      }}
      onDoubleClick={reveal}
      onKeyDown={(e) => { if (e.key === 'Enter') void openFile(path) }}
    >
      {path}
    </span>
  )
}
