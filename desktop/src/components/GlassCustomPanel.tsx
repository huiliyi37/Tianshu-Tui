import type { GlassConfig } from '../lib/glass-custom'

export function GlassCustomPanel({
  config,
  onChange,
}: {
  config: GlassConfig
  onChange: (updates: Partial<GlassConfig>) => void
}) {
  const sliders: { label: string; value: number; min: number; max: number; unit: string; key: keyof GlassConfig }[] = [
    { label: '侧边栏浓度 (不透明度)', value: config.sidebarOpacity, min: 10, max: 100, unit: '%', key: 'sidebarOpacity' },
    { label: '侧边栏模糊半径', value: config.sidebarBlur, min: 0, max: 64, unit: 'px', key: 'sidebarBlur' },
    { label: '主内容区浓度 (不透明度)', value: config.mainOpacity, min: 10, max: 100, unit: '%', key: 'mainOpacity' },
    { label: '主内容区模糊半径', value: config.mainBlur, min: 0, max: 64, unit: 'px', key: 'mainBlur' },
  ]

  return (
    <div className="glass-custom-section">
      <h5>自定义毛玻璃浓度与模糊度</h5>
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
