import { useEffect } from 'react'

// P1-6 — shortcut cheatsheet overlay (Cmd+/ toggles). Static reference table;
// the actual bindings live in use-global-shortcuts.ts and Composer.tsx.

const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const MOD = IS_MAC ? '⌘' : 'Ctrl'

interface ShortcutRow {
  keys: string[]
  desc: string
}

const GROUPS: Array<{ title: string; rows: ShortcutRow[] }> = [
  {
    title: '全局',
    rows: [
      { keys: [`${MOD}+K`], desc: '命令面板' },
      { keys: [`${MOD}+/`], desc: '快捷键速查（本面板）' },
      { keys: [`${MOD}+N`], desc: '新建会话' },
      { keys: [`${MOD}+1…9`], desc: '切换功能区（工作区/任务/收件箱…）' },
      { keys: [`${MOD}+,`], desc: '设置' },
    ],
  },
  {
    title: '会话与布局',
    rows: [
      { keys: ['Ctrl+Tab', `${MOD}+Shift+]`], desc: '下一个会话标签' },
      { keys: ['Ctrl+Shift+Tab', `${MOD}+Shift+[`], desc: '上一个会话标签' },
      { keys: [`${MOD}+W`], desc: '关闭当前标签' },
      { keys: [`${MOD}+B`], desc: '侧栏开关' },
      { keys: [`${MOD}+Shift+B`], desc: '审查面板开关' },
      { keys: [`${MOD}+J`, 'Ctrl+`'], desc: '终端开关' },
      { keys: [`${MOD}+;`], desc: '旁路提问（不影响主任务的轻会话）' },
      { keys: [`${MOD}+.`], desc: 'Zen 模式（隐藏侧栏与面板）' },
      { keys: [`${MOD}+O`], desc: '视图模式循环：标准 → 详尽 → 摘要' },
      { keys: ['右下 ☰ 钮'], desc: '消息导航 · 跳转历史消息（↑/↓ 选择 · Enter 跳转 · Esc 关闭）' },
    ],
  },
  {
    title: '输入框',
    rows: [
      { keys: ['Enter'], desc: '发送（运行中为插入引导）' },
      { keys: ['Shift+Enter'], desc: '换行' },
      { keys: ['Shift+Tab'], desc: 'Plan / Agent 模式切换' },
      { keys: ['Esc'], desc: '清空输入；空输入且运行中 → 停止' },
      { keys: ['Esc Esc'], desc: '回滚菜单（空输入连按两次）' },
      { keys: ['@'], desc: '文件引用补全（消息中的 @file 可点击预览）' },
      { keys: ['/'], desc: '斜杠命令菜单（行首）' },
    ],
  },
  {
    title: '功能速查',
    rows: [
      { keys: ['+ 菜单'], desc: '议事会 ♟ / 团队模式 ⬡ / 派子代理 / 模型切换 / 星域' },
      { keys: ['/effort'], desc: '推理强度选择面板（Auto/Max/High/Medium/Low/Off）' },
      { keys: ['点击 @file'], desc: '右侧抽屉预览文件内容（语法高亮）' },
      { keys: ['Insights'], desc: '成本统计 + 缓存命中率 + DeepSeek 余额查询' },
      { keys: ['/council'], desc: '多模型议事会（天权/天府/天璇三席评审）' },
      { keys: ['/team'], desc: '团队模式（多 agent 并行执行计划）' },
    ],
  },
]

export function ShortcutOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="shortcut-overlay-backdrop" onClick={onClose} role="presentation">
      <div
        className="shortcut-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="快捷键速查"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shortcut-overlay-head">
          <h3>快捷键</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="shortcut-overlay-body">
          {GROUPS.map((g) => (
            <section key={g.title} className="shortcut-group">
              <h4>{g.title}</h4>
              {g.rows.map((row) => (
                <div key={row.desc} className="shortcut-row">
                  <span className="shortcut-keys">
                    {row.keys.map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="shortcut-or">或</span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </span>
                  <span className="shortcut-desc">{row.desc}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
