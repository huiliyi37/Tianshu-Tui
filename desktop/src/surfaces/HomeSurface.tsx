import { useState } from 'react'
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
} from 'lucide-react'
import { useUiDispatch } from '../state/store'

const REPO_URL = 'https://github.com/huiliyi37/Tianshu-Tui'
const RELEASES_URL = 'https://github.com/huiliyi37/Tianshu-Tui/releases'

interface DocLink {
  icon: React.ElementType
  title: string
  desc: string
  href: string
}

const DOCS: DocLink[] = [
  {
    icon: BookOpen,
    title: 'README',
    desc: '项目简介、特性与快速开始',
    href: `${REPO_URL}#readme`,
  },
  {
    icon: FileText,
    title: '用户手册',
    desc: '完整使用指南与命令参考',
    href: `${REPO_URL}/blob/main/docs/user-guide.md`,
  },
  {
    icon: Shield,
    title: '沙箱权限说明',
    desc: '了解天枢的工具执行与权限模型',
    href: `${REPO_URL}/blob/main/docs/user-guide-sandbox-permissions.md`,
  },
  {
    icon: HelpCircle,
    title: 'Provider 配置',
    desc: '配置 DeepSeek / Claude / GLM 等 API Key',
    href: `${REPO_URL}/blob/main/docs/user-guide-provider-config.md`,
  },
]

const DOWNLOADS = [
  { label: 'macOS (.dmg)', asset: '*.dmg' },
  { label: 'Windows (.msi)', asset: '*.msi' },
  { label: 'Linux (.AppImage)', asset: '*.AppImage' },
]

export function HomeSurface() {
  const dispatch = useUiDispatch()
  const [busy, setBusy] = useState(false)

  const open = (href: string) => {
    window.open(href, '_blank', 'noopener,noreferrer')
  }

  const createFirstThread = () => {
    setBusy(true)
    dispatch({ type: 'openNew', open: true })
    // Brief feedback; the dialog itself provides the real UI.
    setTimeout(() => setBusy(false), 400)
  }

  return (
    <div className="home-surface">
      <header className="home-hero">
        <div className="home-brand">
          <span className="home-logo" aria-hidden>枢</span>
          <div>
            <h1 className="home-title">天枢 · Tianshu</h1>
            <p className="home-subtitle">全功能终端编程智能体运行时</p>
          </div>
        </div>
        <p className="home-lead">
          智能上下文管理、多模型协调、结构化审查纪律、可扩展工具架构。
          <br />
          在桌面端打开项目，让天枢自主完成编码任务。
        </p>
        <div className="home-actions">
          <button className="btn btn-primary home-btn" onClick={createFirstThread} disabled={busy}>
            <MessageSquare size={18} />
            {busy ? '打开中…' : '开始第一个线程'}
          </button>
          <button className="btn btn-secondary home-btn" onClick={() => open(RELEASES_URL)}>
            <Download size={18} />
            下载桌面端
          </button>
          <button className="btn btn-secondary home-btn" onClick={() => open(REPO_URL)}>
            <Code size={18} />
            开源仓库
          </button>
        </div>
      </header>

      <section className="home-section">
        <h2 className="home-section-title">
          <BookOpen size={18} />
          文档与手册
        </h2>
        <div className="home-grid">
          {DOCS.map((doc) => (
            <button
              key={doc.title}
              className="home-card"
              onClick={() => open(doc.href)}
              title={doc.desc}
            >
              <doc.icon size={22} className="home-card-icon" />
              <div className="home-card-text">
                <span className="home-card-title">{doc.title}</span>
                <span className="home-card-desc">{doc.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="home-section">
        <h2 className="home-section-title">
          <Download size={18} />
          获取桌面端
        </h2>
        <div className="home-downloads">
          {DOWNLOADS.map((dl) => (
            <button
              key={dl.label}
              className="home-download"
              onClick={() => open(RELEASES_URL)}
            >
              <span className="home-download-label">{dl.label}</span>
              <span className="home-download-hint">在 Releases 中查找 {dl.asset}</span>
            </button>
          ))}
        </div>
        <p className="home-note">
          也可通过源码构建：克隆仓库后执行 <code>npm install && npm run build</code>。
        </p>
      </section>

      <section className="home-section">
        <h2 className="home-section-title">
          <Sparkles size={18} />
          快速开始
        </h2>
        <ol className="home-steps">
          <li>
            <strong>选择项目</strong>
            <span>在左侧边栏打开或创建一个项目目录。</span>
          </li>
          <li>
            <strong>配置 API Key</strong>
            <span>进入「设置」或在终端执行 <code>rivet config set-key deepseek sk-xxx</code>。</span>
          </li>
          <li>
            <strong>开始对话</strong>
            <span>在工作台输入需求，天枢会自主分析、编码、测试并提交。</span>
          </li>
        </ol>
      </section>

      <section className="home-section">
        <h2 className="home-section-title">
          <Terminal size={18} />
          常用命令
        </h2>
        <div className="home-commands">
          <code>/goal &lt;目标&gt;</code>
          <span>设定跨回合自主目标</span>
          <code>/plan &lt;功能&gt;</code>
          <span>创建实现计划</span>
          <code>/python status</code>
          <span>检查 Python/uv/Git 环境</span>
          <code>/mirror china</code>
          <span>切换国内镜像加速下载</span>
        </div>
      </section>

      <footer className="home-footer">
        <span>
          <Globe size={14} />
          开源协议：Apache-2.0
        </span>
        <button className="home-link" onClick={() => open(REPO_URL)}>
          github.com/huiliyi37/Tianshu-Tui
        </button>
      </footer>
    </div>
  )
}
