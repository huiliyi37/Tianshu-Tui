import { type FontFamilyPref } from '../lib/font-family'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const FONT_FAMILY_LABEL: Record<FontFamilyPref, string> = {
  sans: '系统无衬线 (Sans-Serif)',
  kaiti: '优雅楷体 (Chinese Kaiti)',
  geometric: '几何主义 (Outfit / Inter)',
  mono: '极客等宽 (JetBrains Mono)',
}

export function FontSettingsPanel({
  value,
  onChange,
}: {
  value: FontFamilyPref
  onChange: (pref: FontFamilyPref) => void
}) {
  return (
    <section className="settings-group">
      <h4>字体风格</h4>
      <Select value={value} onValueChange={(v) => onChange(v as FontFamilyPref)}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder="选择字体风格" />
        </SelectTrigger>
        <SelectContent>
          {(['sans', 'kaiti', 'geometric', 'mono'] as FontFamilyPref[]).map((f) => (
            <SelectItem key={f} value={f}>{FONT_FAMILY_LABEL[f]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="meta">调整全局字体风格与排版，支持衬线、等宽等定制风格。</div>
    </section>
  )
}
