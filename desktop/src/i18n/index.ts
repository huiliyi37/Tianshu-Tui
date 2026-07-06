import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import zhCNCommon from '../locales/zh-CN/common.json'
import zhCNComposer from '../locales/zh-CN/composer.json'
import zhCNCommandPalette from '../locales/zh-CN/commandPalette.json'
import zhCNSettings from '../locales/zh-CN/settings.json'
import zhCNTheme from '../locales/zh-CN/theme.json'
import zhCNLanguage from '../locales/zh-CN/language.json'
import zhCNAutonomy from '../locales/zh-CN/autonomy.json'
import zhCNThread from '../locales/zh-CN/thread.json'
import zhCNDelegation from '../locales/zh-CN/delegation.json'
import zhCNTaskList from '../locales/zh-CN/taskList.json'
import zhCNNav from '../locales/zh-CN/nav.json'
import zhCNError from '../locales/zh-CN/error.json'
import zhCNJobs from '../locales/zh-CN/jobs.json'
import zhCNPlan from '../locales/zh-CN/plan.json'

import enCommon from '../locales/en/common.json'
import enComposer from '../locales/en/composer.json'
import enCommandPalette from '../locales/en/commandPalette.json'
import enSettings from '../locales/en/settings.json'
import enTheme from '../locales/en/theme.json'
import enLanguage from '../locales/en/language.json'
import enAutonomy from '../locales/en/autonomy.json'
import enThread from '../locales/en/thread.json'
import enDelegation from '../locales/en/delegation.json'
import enTaskList from '../locales/en/taskList.json'
import enNav from '../locales/en/nav.json'
import enError from '../locales/en/error.json'
import enJobs from '../locales/en/jobs.json'
import enPlan from '../locales/en/plan.json'

const resources = {
  'zh-CN': {
    common: zhCNCommon,
    composer: zhCNComposer,
    commandPalette: zhCNCommandPalette,
    settings: zhCNSettings,
    theme: zhCNTheme,
    language: zhCNLanguage,
    autonomy: zhCNAutonomy,
    thread: zhCNThread,
    delegation: zhCNDelegation,
    taskList: zhCNTaskList,
    nav: zhCNNav,
    error: zhCNError,
    jobs: zhCNJobs,
    plan: zhCNPlan,
  },
  en: {
    common: enCommon,
    composer: enComposer,
    commandPalette: enCommandPalette,
    settings: enSettings,
    theme: enTheme,
    language: enLanguage,
    autonomy: enAutonomy,
    thread: enThread,
    delegation: enDelegation,
    taskList: enTaskList,
    nav: enNav,
    error: enError,
    jobs: enJobs,
    plan: enPlan,
  },
}

export const namespaces = Object.keys(resources['zh-CN'])

export function initI18n() {
  // Already initialized (HMR)?
  if (i18n.isInitialized) return i18n

  return i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      defaultNS: 'common',
      fallbackNS: 'common',
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
