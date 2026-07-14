import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { HomeWelcome } from '../components/HomeWelcome'
import { openExternal } from '../lib/open-external'

const REPO_URL = 'https://github.com/huiliyi37/Tianshu-Tui'

// Codex 对标首页（Wave 2）：原 hero + bento-grid 换成居中欢迎（HomeWelcome，
// 与 WorkspaceSurface 的 onboard 空态共用）。文档/下载等低频入口收进命令面板
// 与 GitHub 仓库，首页只保留一个轻量 footer。
export function HomeSurface() {
  const { t } = useTranslation('home')

  return (
    <div className="home-surface">
      <HomeWelcome />
      <footer className="home-footer">
        <span>
          <Globe size={12} />
          {t('footer.license')}
        </span>
        <button className="home-link" onClick={() => openExternal(REPO_URL)}>
          github.com/huiliyi37/Tianshu-Tui
        </button>
      </footer>
    </div>
  )
}
