import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import zhCN from '../locales/zh-CN.json'
import en from '../locales/en.json'

// i18n initialization. Language is detected from localStorage → browser → fallback zh-CN.
// Translations are bundled (no network). New components use useTranslation() hook;
// existing hardcoded Chinese remains functional (zh-CN is the default).
export function initI18n() {
  // Already initialized (HMR)?
  if (i18n.isInitialized) return i18n

  return i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        'zh-CN': { translation: zhCN },
        en: { translation: en },
      },
      fallbackLng: 'zh-CN',
      supportedLngs: ['zh-CN', 'en'],
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: 'rivet:lang',
        caches: ['localStorage'],
      },
    })
}

export default i18n
