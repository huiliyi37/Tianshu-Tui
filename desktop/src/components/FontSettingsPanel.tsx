import { useTranslation } from 'react-i18next'
import { type FontFamilyPref } from '../lib/font-family'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function FontSettingsPanel({
  value,
  onChange,
}: {
  value: FontFamilyPref
  onChange: (pref: FontFamilyPref) => void
}) {
  const { t } = useTranslation('settings')

  const FONT_FAMILY_LABEL: Record<FontFamilyPref, string> = {
    sans: t('font.sans'),
    kaiti: t('font.kaiti'),
    geometric: t('font.geometric'),
    mono: t('font.mono'),
  }

  return (
    <section className="settings-group">
      <h4>{t('font.title')}</h4>
      <Select value={value} onValueChange={(v) => onChange(v as FontFamilyPref)}>
        <SelectTrigger className="w-40">
          <SelectValue placeholder={t('font.placeholder')} />
        </SelectTrigger>
        <SelectContent>
          {(['sans', 'kaiti', 'geometric', 'mono'] as FontFamilyPref[]).map((f) => (
            <SelectItem key={f} value={f}>{FONT_FAMILY_LABEL[f]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="meta">{t('font.hint')}</div>
    </section>
  )
}
