import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  Code,
  Download,
  FileText,
  Globe,
  HelpCircle,
  Shield,
  Sparkles,
  Terminal,
  MessageSquare,
  Copy,
  Check,
  Zap,
} from 'lucide-react'
import { useUiDispatch } from '../state/store'
import { openExternal } from '../lib/open-external'

const REPO_URL = 'https://github.com/huiliyi37/Tianshu-Tui'
const RELEASES_URL = 'https://github.com/huiliyi37/Tianshu-Tui/releases'

interface DocLink {
  icon: React.ElementType
  /** i18n key prefix under home:docs.* — resolved to .title / .desc at render. */
  key: string
  href: string
}

const DOCS: DocLink[] = [
  {
    icon: BookOpen,
    key: 'readme',
    href: `${REPO_URL}#readme`,
  },
  {
    icon: FileText,
    key: 'manual',
    href: `${REPO_URL}/blob/main/docs/user-guide.md`,
  },
  {
    icon: Shield,
    key: 'sandbox',
    href: `${REPO_URL}/blob/main/docs/user-guide-sandbox-permissions.md`,
  },
  {
    icon: HelpCircle,
    key: 'provider',
    href: `${REPO_URL}/blob/main/docs/user-guide-provider-config.md`,
  },
]

export function HomeSurface() {
  const { t } = useTranslation('home')
  const dispatch = useUiDispatch()
  const [busy, setBusy] = useState(false)
  const [copiedText, setCopiedText] = useState<string | null>(null)

  const open = (href: string) => {
    openExternal(href)
  }

  const createFirstThread = () => {
    setBusy(true)
    dispatch({ type: 'openNew', open: true })
    setTimeout(() => setBusy(false), 400)
  }

  const handleCopyCommand = (cmd: string) => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopiedText(cmd)
      setTimeout(() => setCopiedText(null), 1500)
    })
  }

  return (
    <div className="home-surface">
      <header className="home-hero">
        <div className="home-brand">
          <span className="home-logo" aria-hidden>
            <Sparkles size={28} />
          </span>
          <div>
            <h1 className="home-title">{t('brand.title')}</h1>
            <p className="home-subtitle">Next-Gen Agentic Coding Runtime</p>
          </div>
        </div>
        <p className="home-lead">
          {t('lead.line1')}
          <br />
          {t('lead.line2')}
        </p>
        <div className="home-actions">
          <button className="btn btn-primary home-btn" onClick={createFirstThread} disabled={busy}>
            <MessageSquare size={16} />
            {busy ? t('actions.initializing') : t('actions.newThread')}
          </button>
          <button className="btn btn-secondary home-btn" onClick={() => open(REPO_URL)}>
            <Code size={16} />
            {t('actions.repo')}
          </button>
        </div>
      </header>

      <div className="home-bento-grid">
        {/* Card 1: Quick Start steps */}
        <div className="bento-card bento-steps">
          <h3 className="bento-card-title">
            <Zap size={16} className="bento-title-icon" />
            {t('quickStart.title')}
          </h3>
          <ol className="bento-step-list">
            <li>
              <span className="step-num">1</span>
              <div>
                <strong>{t('quickStart.step1.title')}</strong>
                <p>{t('quickStart.step1.desc')}</p>
              </div>
            </li>
            <li>
              <span className="step-num">2</span>
              <div>
                <strong>{t('quickStart.step2.title')}</strong>
                <p>{t('quickStart.step2.desc')}</p>
              </div>
            </li>
            <li>
              <span className="step-num">3</span>
              <div>
                <strong>{t('quickStart.step3.title')}</strong>
                <p>{t('quickStart.step3.desc')}</p>
              </div>
            </li>
          </ol>
        </div>

        {/* Card 2: Documentation Grid */}
        <div className="bento-card bento-docs">
          <h3 className="bento-card-title">
            <BookOpen size={16} className="bento-title-icon" />
            {t('docs.sectionTitle')}
          </h3>
          <div className="bento-docs-grid">
            {DOCS.map((doc) => (
              <button
                key={doc.key}
                className="bento-doc-item"
                onClick={() => open(doc.href)}
                title={t(`docs.${doc.key}.desc`)}
              >
                <div className="bento-doc-head">
                  <doc.icon size={16} className="bento-doc-icon" />
                  <span className="bento-doc-title">{t(`docs.${doc.key}.title`)}</span>
                </div>
                <p className="bento-doc-desc">{t(`docs.${doc.key}.desc`)}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Card 3: Command helper */}
        <div className="bento-card bento-commands">
          <h3 className="bento-card-title">
            <Terminal size={16} className="bento-title-icon" />
            {t('commands.title')}
          </h3>
          <p className="bento-card-subtitle">{t('commands.subtitle')}</p>
          <div className="bento-cmd-list">
            {[
              { cmd: '/yes', label: t('commands.yes') },
              { cmd: '/team', label: t('commands.team') },
              { cmd: '/review', label: t('commands.review') },
              { cmd: '/python status', label: t('commands.status') }
            ].map((item) => (
              <button
                key={item.cmd}
                className="bento-cmd-item"
                onClick={() => handleCopyCommand(item.cmd)}
                title={t('commands.copyHint')}
              >
                <span className="bento-cmd-text">{item.cmd}</span>
                <span className="bento-cmd-label">{item.label}</span>
                <span className="bento-cmd-copy">
                  {copiedText === item.cmd ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Card 4: Get Client */}
        <div className="bento-card bento-download">
          <h3 className="bento-card-title">
            <Download size={16} className="bento-title-icon" />
            {t('download.title')}
          </h3>
          <p className="bento-card-subtitle">{t('download.subtitle')}</p>
          <div className="bento-dl-buttons">
            {[
              { name: 'macOS (.dmg)', ext: 'dmg' },
              { name: 'Windows (.msi)', ext: 'msi' },
              { name: 'Linux (.AppImage)', ext: 'AppImage' }
            ].map((platform) => (
              <button
                key={platform.name}
                className="bento-dl-btn"
                onClick={() => open(RELEASES_URL)}
              >
                <span className="dl-platform">{platform.name}</span>
                <span className="dl-hint">Release {platform.ext}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <footer className="home-footer">
        <span>
          <Globe size={12} />
          {t('footer.license')}
        </span>
        <button className="home-link" onClick={() => open(REPO_URL)}>
          github.com/huiliyi37/Tianshu-Tui
        </button>
      </footer>
    </div>
  )
}
