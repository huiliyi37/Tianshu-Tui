import { useTranslation } from 'react-i18next'
import { AUTONOMY_LEVELS, LEVEL_META, type AutonomyLevel } from '../lib/autonomy'

/**
 * Segmented autonomy selector (S) — 监督 / 默认 / 自治. Used in the new-thread
 * dialog, the thread header (live switch), and settings (global default).
 * `compact` renders the header-sized variant without the hint line.
 */
export function AutonomyControl(props: {
  value: AutonomyLevel
  onChange: (level: AutonomyLevel) => void
  compact?: boolean
  disabled?: boolean
}) {
  const { value, onChange, compact, disabled } = props
  // Subscribes this component to language changes so LEVEL_META getters re-read.
  const { t } = useTranslation('autonomy')
  return (
    <div className={`autonomy ${compact ? 'compact' : ''}`}>
      <div className="autonomy-seg" role="radiogroup" aria-label={t('groupAria')}>
        {AUTONOMY_LEVELS.map((lvl) => {
          const meta = LEVEL_META[lvl]
          const active = lvl === value
          return (
            <button
              key={lvl}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              className={`autonomy-opt level-${lvl} ${active ? 'active' : ''}`}
              title={meta.hint}
              onClick={() => onChange(lvl)}
            >
              <span className="autonomy-glyph" aria-hidden>{meta.glyph}</span>
              {meta.label}
            </button>
          )
        })}
      </div>
      {!compact && <div className="autonomy-hint">{LEVEL_META[value].hint}</div>}
    </div>
  )
}
