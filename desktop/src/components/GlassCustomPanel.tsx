import { useTranslation } from 'react-i18next'
import type { GlassConfig } from '../lib/glass-custom'

export function GlassCustomPanel({
  config,
  onChange,
}: {
  config: GlassConfig
  onChange: (updates: Partial<GlassConfig>) => void
}) {
  const { t } = useTranslation('settings')
  const sliders: { label: string; value: number; min: number; max: number; unit: string; key: keyof GlassConfig }[] = [
    { label: t('glass.sidebarOpacity'), value: config.sidebarOpacity, min: 10, max: 100, unit: '%', key: 'sidebarOpacity' },
    { label: t('glass.sidebarBlur'), value: config.sidebarBlur, min: 0, max: 64, unit: 'px', key: 'sidebarBlur' },
    { label: t('glass.mainOpacity'), value: config.mainOpacity, min: 10, max: 100, unit: '%', key: 'mainOpacity' },
    { label: t('glass.mainBlur'), value: config.mainBlur, min: 0, max: 64, unit: 'px', key: 'mainBlur' },
  ]

  return (
    <div className="glass-custom-section">
      <h5>{t('glass.title')}</h5>
      <div className="glass-custom-grid">
        {sliders.map((s) => (
          <div key={s.key} className="glass-custom-item">
            <div className="glass-custom-label">
              <span>{s.label}</span>
              <span className="glass-value-badge">{s.value}{s.unit}</span>
            </div>
            <input
              type="range"
              className="glass-slider"
              min={s.min}
              max={s.max}
              value={s.value}
              onChange={(e) => onChange({ [s.key]: parseInt(e.target.value) })}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
