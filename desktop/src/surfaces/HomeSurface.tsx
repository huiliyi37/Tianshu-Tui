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
    desc: '了解天枢的工具执行与权限安全模型',
    href: `${REPO_URL}/blob/main/docs/user-guide-sandbox-permissions.md`,
  },
  {
    icon: HelpCircle,
    title: 'Provider 配置',
    desc: '配置 DeepSeek / Claude / GLM 等 API Key',
    href: `${REPO_URL}/blob/main/docs/user-guide-provider-config.md`,
  },
]

export function HomeSurface() {
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
            <h1 className="home-title">天枢 · tiānshū</h1>
            <p className="home-subtitle">Next-Gen Agentic Coding Runtime</p>
          </div>
        </div>
        <p className="home-lead">
          智能上下文管理、多星域协同博弈、自主安全沙箱。
          <br />
          在桌面端打开项目，让 tianshu 接管并完成复杂的工程化编码任务。
        </p>
        <div className="home-actions">
          <button className="btn btn-primary home-btn" onClick={createFirstThread} disabled={busy}>
            <MessageSquare size={16} />
            {busy ? '初始化会话…' : '开启新对话'}
          </button>
          <button className="btn btn-secondary home-btn" onClick={() => open(REPO_URL)}>
            <Code size={16} />
            开源仓库
          </button>
        </div>
      </header>

      <div className="home-bento-grid">
        {/* Card 1: Quick Start steps */}
        <div className="bento-card bento-steps">
          <h3 className="bento-card-title">
            <Zap size={16} className="bento-title-icon" />
            快速开始
          </h3>
          <ol className="bento-step-list">
            <li>
              <span className="step-num">1</span>
              <div>
                <strong>选择项目</strong>
                <p>在左侧边栏打开或创建一个项目目录作为工作区。</p>
              </div>
            </li>
            <li>
              <span className="step-num">2</span>
              <div>
                <strong>配置 API Key</strong>
                <p>进入「设置」面板或在下方终端中设置大模型密钥。</p>
              </div>
            </li>
            <li>
              <span className="step-num">3</span>
              <div>
                <strong>开始编码</strong>
                <p>在输入框键入需求，tianshu 将自主进行规划、编码及自测。</p>
              </div>
            </li>
          </ol>
        </div>

        {/* Card 2: Documentation Grid */}
        <div className="bento-card bento-docs">
          <h3 className="bento-card-title">
            <BookOpen size={16} className="bento-title-icon" />
            文档与手册
          </h3>
          <div className="bento-docs-grid">
            {DOCS.map((doc) => (
              <button
                key={doc.title}
                className="bento-doc-item"
                onClick={() => open(doc.href)}
                title={doc.desc}
              >
                <div className="bento-doc-head">
                  <doc.icon size={16} className="bento-doc-icon" />
                  <span className="bento-doc-title">{doc.title}</span>
                </div>
                <p className="bento-doc-desc">{doc.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Card 3: Command helper */}
        <div className="bento-card bento-commands">
          <h3 className="bento-card-title">
            <Terminal size={16} className="bento-title-icon" />
            常用快捷指令
          </h3>
          <p className="bento-card-subtitle">点击命令快速复制代码</p>
          <div className="bento-cmd-list">
            {[
              { cmd: '/autonomous', label: '启用无打扰自主执行模式' },
              { cmd: '/team', label: '委派多代理组队并行拆解任务' },
              { cmd: '/review', label: '对当前的变更或计划执行审查' },
              { cmd: '/python status', label: '核对依赖环境与 Git 仓库状态' }
            ].map((item) => (
              <button
                key={item.cmd}
                className="bento-cmd-item"
                onClick={() => handleCopyCommand(item.cmd)}
                title="点击复制指令"
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
            下载桌面端
          </h3>
          <p className="bento-card-subtitle">跨平台发布包安装</p>
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
          开源协议：Apache-2.0
        </span>
        <button className="home-link" onClick={() => open(REPO_URL)}>
          github.com/huiliyi37/Tianshu-Tui
        </button>
      </footer>
    </div>
  )
}
