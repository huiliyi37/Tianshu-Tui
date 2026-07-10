import { useTranslation } from 'react-i18next'
import { openFile } from '../runtime/client'
import { useUiDispatch } from '../state/store'

/** Clickable file path — single-click opens in the system editor;
 *  double-click reveals the file in the right-side FileExplorer. */
export function FilePath({ path, className }: { path: string; className?: string }) {
  const { t } = useTranslation('threadView')
  const dispatch = useUiDispatch()
  return (
    <span
      className={`file-path-link ${className ?? ''}`}
      title={t('file.openTitle', { path })}
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); void openFile(path) }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        dispatch({ type: 'requestRevealFile', path })
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') void openFile(path) }}
    >
      {path}
    </span>
  )
}
