import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// NOTE: explicit imports (not import.meta.glob) — this module is also loaded
// by node:test via tsx, where Vite-only APIs are unavailable.
import zhCNApproval from '../locales/zh-CN/approval.json'
import zhCNAutomations from '../locales/zh-CN/automations.json'
import zhCNAutonomy from '../locales/zh-CN/autonomy.json'
import zhCNBrowser from '../locales/zh-CN/browser.json'
import zhCNCommandPalette from '../locales/zh-CN/commandPalette.json'
import zhCNCommon from '../locales/zh-CN/common.json'
import zhCNComposer from '../locales/zh-CN/composer.json'
import zhCNCouncil from '../locales/zh-CN/council.json'
import zhCNDelegation from '../locales/zh-CN/delegation.json'
import zhCNError from '../locales/zh-CN/error.json'
import zhCNGit from '../locales/zh-CN/git.json'
import zhCNHome from '../locales/zh-CN/home.json'
import zhCNHooks from '../locales/zh-CN/hooks.json'
import zhCNInbox from '../locales/zh-CN/inbox.json'
import zhCNInsights from '../locales/zh-CN/insights.json'
import zhCNJobs from '../locales/zh-CN/jobs.json'
import zhCNLanguage from '../locales/zh-CN/language.json'
import zhCNMission from '../locales/zh-CN/mission.json'
import zhCNNav from '../locales/zh-CN/nav.json'
import zhCNOnboarding from '../locales/zh-CN/onboarding.json'
import zhCNPlan from '../locales/zh-CN/plan.json'
import zhCNReview from '../locales/zh-CN/review.json'
import zhCNSettings from '../locales/zh-CN/settings.json'
import zhCNShell from '../locales/zh-CN/shell.json'
import zhCNSkills from '../locales/zh-CN/skills.json'
import zhCNTaskList from '../locales/zh-CN/taskList.json'
import zhCNTerminal from '../locales/zh-CN/terminal.json'
import zhCNTheme from '../locales/zh-CN/theme.json'
import zhCNThread from '../locales/zh-CN/thread.json'
import zhCNThreadView from '../locales/zh-CN/threadView.json'

import enApproval from '../locales/en/approval.json'
import enAutomations from '../locales/en/automations.json'
import enAutonomy from '../locales/en/autonomy.json'
import enBrowser from '../locales/en/browser.json'
import enCommandPalette from '../locales/en/commandPalette.json'
import enCommon from '../locales/en/common.json'
import enComposer from '../locales/en/composer.json'
import enCouncil from '../locales/en/council.json'
import enDelegation from '../locales/en/delegation.json'
import enError from '../locales/en/error.json'
import enGit from '../locales/en/git.json'
import enHome from '../locales/en/home.json'
import enHooks from '../locales/en/hooks.json'
import enInbox from '../locales/en/inbox.json'
import enInsights from '../locales/en/insights.json'
import enJobs from '../locales/en/jobs.json'
import enLanguage from '../locales/en/language.json'
import enMission from '../locales/en/mission.json'
import enNav from '../locales/en/nav.json'
import enOnboarding from '../locales/en/onboarding.json'
import enPlan from '../locales/en/plan.json'
import enReview from '../locales/en/review.json'
import enSettings from '../locales/en/settings.json'
import enShell from '../locales/en/shell.json'
import enSkills from '../locales/en/skills.json'
import enTaskList from '../locales/en/taskList.json'
import enTerminal from '../locales/en/terminal.json'
import enTheme from '../locales/en/theme.json'
import enThread from '../locales/en/thread.json'
import enThreadView from '../locales/en/threadView.json'

const resources = {
  'zh-CN': {
    approval: zhCNApproval,
    automations: zhCNAutomations,
    autonomy: zhCNAutonomy,
    browser: zhCNBrowser,
    commandPalette: zhCNCommandPalette,
    common: zhCNCommon,
    composer: zhCNComposer,
    council: zhCNCouncil,
    delegation: zhCNDelegation,
    error: zhCNError,
    git: zhCNGit,
    home: zhCNHome,
    hooks: zhCNHooks,
    inbox: zhCNInbox,
    insights: zhCNInsights,
    jobs: zhCNJobs,
    language: zhCNLanguage,
    mission: zhCNMission,
    nav: zhCNNav,
    onboarding: zhCNOnboarding,
    plan: zhCNPlan,
    review: zhCNReview,
    settings: zhCNSettings,
    shell: zhCNShell,
    skills: zhCNSkills,
    taskList: zhCNTaskList,
    terminal: zhCNTerminal,
    theme: zhCNTheme,
    thread: zhCNThread,
    threadView: zhCNThreadView,
  },
  en: {
    approval: enApproval,
    automations: enAutomations,
    autonomy: enAutonomy,
    browser: enBrowser,
    commandPalette: enCommandPalette,
    common: enCommon,
    composer: enComposer,
    council: enCouncil,
    delegation: enDelegation,
    error: enError,
    git: enGit,
    home: enHome,
    hooks: enHooks,
    inbox: enInbox,
    insights: enInsights,
    jobs: enJobs,
    language: enLanguage,
    mission: enMission,
    nav: enNav,
    onboarding: enOnboarding,
    plan: enPlan,
    review: enReview,
    settings: enSettings,
    shell: enShell,
    skills: enSkills,
    taskList: enTaskList,
    terminal: enTerminal,
    theme: enTheme,
    thread: enThread,
    threadView: enThreadView,
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
