import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMcpServerTools } from '../runtime/client'
import { openExternal } from '../lib/open-external'
import type { McpStatusResponse, McpServerConfig, McpConnectionState, McpPreset, McpServerToolsResponse } from '../runtime/types'

/**
 * 把单行参数字符串解析为 argv 数组，支持引号包裹含空格的参数。
 *
 * 修复点：旧实现 `split(/\s+/)` 会把 Windows 含空格路径
 * （如 `C:\Users\Alice\My Documents\server`）拆成多个 argv，
 * 导致 MCP server 收到错误的根目录。本解析器支持：
 *  - 双引号 "..." / 单引号 '...' 包裹的含空格参数作为一个整体
 *  - 引号内可含空格、反斜杠路径
 *  - 引号外按空白切分
 *  - 未闭合引号容忍处理（取到行尾）
 *
 * 示例：
 *   `-y @x/server "C:\My Documents\dir" flag`
 *   → ['-y', '@x/server', 'C:\My Documents\dir', 'flag']
 */
export function parseArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null // 闭合引号
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch as '"' | "'"
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) args.push(current) // 末尾参数（含未闭合引号的容忍回退）
  return args
}

// ── MCP 预设 ──────────────────────────────────────────────────
// 预设目录来自服务端 (`GET /mcp/presets`)，一键启用常用集成。带密钥的
// 预设（GitHub/Slack/Notion/Linear）会展开内联密钥表单收集 requiredEnv。

interface McpSettingsProps {
  status: McpStatusResponse | null
  statusLoading: boolean
  statusError: string | null
  /** 服务端预设目录；null = 加载中。 */
  presets: McpPreset[] | null
  /** 已在 config 中配置的预设 id（用于标注"已添加"）。 */
  configuredIds: string[]
  onAdd: (config: McpServerConfig) => void
  onRemove: (serverId: string) => void
  onRestart: (serverId: string) => void
}

/** A single discovery card. Keyed presets expand an inline secret form. */
function PresetCard({
  preset,
  configured,
  onAdd,
}: {
  preset: McpPreset
  configured: boolean
  onAdd: (config: McpServerConfig) => void
}) {
  const { t } = useTranslation('settings')
  const needsKeys = (preset.requiredEnv?.length ?? 0) > 0
  const [expanded, setExpanded] = useState(false)
  const [env, setEnv] = useState<Record<string, string>>({})

  const buildConfig = (): McpServerConfig => ({
    serverId: preset.id,
    command: preset.command,
    args: preset.args,
    url: preset.url,
    env: needsKeys ? env : undefined,
  })

  const allFilled = (preset.requiredEnv ?? []).every((f) => (env[f.key] ?? '').trim().length > 0)

  const onCardClick = () => {
    if (configured) return
    if (needsKeys) setExpanded((v) => !v)
    else onAdd(buildConfig())
  }

  return (
    <div className={`mcp-preset-card${configured ? ' configured' : ''}`}>
      <div onClick={onCardClick} style={{ cursor: configured ? 'default' : 'pointer' }}>
        <div className="mcp-preset-name">
          {configured ? '✓ ' : needsKeys ? '🔑 ' : '+ '}{preset.name}
          {configured && <span className="meta" style={{ marginLeft: 6 }}>{t('mcp.configured')}</span>}
          {!configured && needsKeys && !expanded && (
            <button className="btn-mini" onClick={(e) => { e.stopPropagation(); setExpanded(true) }} style={{ marginLeft: 'auto' }}>
              {t('mcp.enable')}
            </button>
          )}
        </div>
        <div className="mcp-preset-desc">{preset.description}</div>
        <div className="mcp-preset-cmd">
          {preset.transport === 'stdio' ? `${preset.command ?? ''} ${(preset.args ?? []).join(' ')}` : preset.url}
        </div>
      </div>
      {expanded && !configured && needsKeys && (
        <div className="mcp-preset-keyform" onClick={(e) => e.stopPropagation()}>
          {(preset.requiredEnv ?? []).map((f) => (
            <div className="form-row" key={f.key}>
              <label title={f.help}>{f.label}</label>
              <input
                type="password"
                value={env[f.key] ?? ''}
                placeholder={f.help}
                onChange={(e) => setEnv((prev) => ({ ...prev, [f.key]: (e.target as HTMLInputElement).value }))}
              />
            </div>
          ))}
          <div className="form-actions">
            <button
              className="btn-mini"
              disabled={!allFilled}
              onClick={() => { onAdd(buildConfig()); setExpanded(false) }}
            >
              {t('mcp.confirmEnable')}
            </button>
            <button className="btn-mini" onClick={() => setExpanded(false)}>{t('mcp.cancel')}</button>
            {preset.docsUrl && (
              <button
                className="btn-mini"
                onClick={() => openExternal(preset.docsUrl!)}
              >
                {t('mcp.docs')}
              </button>
            )}
          </div>
        </div>
      )}
      {!configured && !needsKeys && preset.docsUrl && (
        <button
          className="btn-mini"
          style={{ marginTop: 4 }}
          onClick={() => openExternal(preset.docsUrl!)}
        >
          {t('mcp.docs')}
        </button>
      )}
    </div>
  )
}

const STATUS_DOT: Record<string, string> = {
  connected: '●',
  connecting: '◐',
  degraded: '◐',
  error: '✗',
  disconnected: '○',
}

/** Connection states with an i18n label under settings:mcp.status.* */
const KNOWN_STATUSES = new Set(['connected', 'connecting', 'degraded', 'error', 'disconnected'])

const STATUS_CLASS: Record<string, string> = {
  connected: 'green',
  connecting: 'yellow',
  degraded: 'yellow',
  error: 'red',
  disconnected: 'muted',
}

function StatusBadge({ state }: { state: McpConnectionState }) {
  const { t } = useTranslation('settings')
  const cls = STATUS_CLASS[state.status] ?? 'muted'
  return (
    <span className={`mcp-status-badge ${cls}`} title={state.error ?? ''}>
      <span className="dot">{STATUS_DOT[state.status] ?? '○'}</span>
      <span className="label">{KNOWN_STATUSES.has(state.status) ? t(`mcp.status.${state.status}`) : state.status}</span>
      {state.toolCount > 0 && <span className="count">{state.toolCount} tools</span>}
    </span>
  )
}

export function McpSettings({
  status,
  statusLoading,
  statusError,
  presets,
  configuredIds,
  onAdd,
  onRemove,
  onRestart,
}: McpSettingsProps) {
  const { t } = useTranslation('settings')
  const [showAdd, setShowAdd] = useState(false)
  const [serverId, setServerId] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  // Per-server expanded tools list (lazy-fetched on first expand).
  const [toolsOpen, setToolsOpen] = useState<string | null>(null)
  const [toolsCache, setToolsCache] = useState<Record<string, McpServerToolsResponse['tools'] | 'loading' | 'error'>>({})

  const toggleTools = (id: string) => {
    if (toolsOpen === id) {
      setToolsOpen(null)
      return
    }
    setToolsOpen(id)
    if (!toolsCache[id] || toolsCache[id] === 'error') {
      setToolsCache((prev) => ({ ...prev, [id]: 'loading' }))
      listMcpServerTools(id)
        .then((res) => setToolsCache((prev) => ({ ...prev, [id]: res.tools })))
        .catch(() => setToolsCache((prev) => ({ ...prev, [id]: 'error' })))
    }
  }

  const handleAdd = async () => {
    if (!serverId.trim()) return
    setAdding(true)
    try {
      const config: McpServerConfig = { serverId: serverId.trim() }
      if (transport === 'stdio') {
        config.command = command.trim()
        if (args.trim()) config.args = parseArgs(args.trim())
      } else {
        config.url = url.trim()
      }
      onAdd(config)
      setShowAdd(false)
      setServerId('')
      setCommand('')
      setArgs('')
      setUrl('')
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="settings-group">
      <h4>{t('mcp.title')}</h4>

      {statusLoading && <div className="meta">{t('mcp.loading')}</div>}
      {statusError && <div className="meta warn">{statusError}</div>}

      {status && (
        <div className="mcp-summary meta">
          {status.servers.length === 0
            ? t('mcp.noServers')
            : t('mcp.summary', {
                connected: status.servers.filter(s => s.status === 'connected').length,
                total: status.servers.length,
                tools: status.totalTools,
              })}
        </div>
      )}

      {status && status.servers.length > 0 && (
        <div className="mcp-server-list">
          {status.servers.map((s) => (
            <div key={s.serverId}>
              <div className="mcp-server-row">
                <div className="mcp-server-info">
                  <span className="mcp-server-id">{s.serverId}</span>
                  <span className="mcp-server-transport">{s.transport ?? '—'}</span>
                  <StatusBadge state={s} />
                  {s.error && s.status === 'error' && (
                    <span className="mcp-server-error" title={s.error}>
                      {s.lastErrorClass ? `[${s.lastErrorClass}] ` : ''}{s.error.slice(0, 60)}
                    </span>
                  )}
                </div>
                <div className="mcp-server-actions">
                  {s.toolCount > 0 && (
                    <button
                      className="btn-mini"
                      onClick={() => toggleTools(s.serverId)}
                      title={t('mcp.viewTools')}
                    >
                      {toolsOpen === s.serverId ? t('mcp.collapse') : t('mcp.tools')}
                    </button>
                  )}
                  {(s.status === 'connected' || s.status === 'degraded' || s.status === 'error') && (
                    <button
                      className="btn-mini"
                      onClick={() => onRestart(s.serverId)}
                      title={t('mcp.reconnect')}
                    >
                      {t('mcp.restart')}
                    </button>
                  )}
                  <button
                    className="btn-mini danger"
                    onClick={() => onRemove(s.serverId)}
                    title={t('mcp.deleteServer')}
                  >
                    {t('mcp.delete')}
                  </button>
                </div>
              </div>
              {toolsOpen === s.serverId && (
                <div className="mcp-tools-list">
                  {toolsCache[s.serverId] === 'loading' && <div className="meta">{t('mcp.toolsLoading')}</div>}
                  {toolsCache[s.serverId] === 'error' && <div className="meta warn">{t('mcp.toolsFailed')}</div>}
                  {Array.isArray(toolsCache[s.serverId]) && (
                    (toolsCache[s.serverId] as McpServerToolsResponse['tools']).map((tool) => (
                      <div key={tool.name} className="mcp-tool-row">
                        <span className="mcp-tool-name">{tool.name}</span>
                        <span className="mcp-tool-desc" title={tool.description}>{tool.description}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {!showAdd && (
        <>
          <div className="mcp-presets">
            <div className="mcp-presets-label">{t('mcp.recommended')}</div>
            {presets == null ? (
              <div className="meta">{t('mcp.presetsLoading')}</div>
            ) : (
              <div className="mcp-presets-grid">
                {presets.map((p) => (
                  <PresetCard
                    key={p.id}
                    preset={p}
                    configured={configuredIds.includes(p.id)}
                    onAdd={onAdd}
                  />
                ))}
              </div>
            )}
            <div className="meta" style={{ marginTop: 6 }}>
              {t('mcp.restartNote')}
            </div>
          </div>
          <button className="btn-mini" onClick={() => setShowAdd(true)}>
            {t('mcp.addCustom')}
          </button>
        </>
      )}

      {showAdd && (
        <div className="mcp-add-form">
          <div className="form-row">
            <label>{t('mcp.serverId')}</label>
            <input
              type="text"
              value={serverId}
              onChange={(e) => setServerId((e.target as HTMLInputElement).value)}
              placeholder={t('mcp.serverIdPlaceholder')}
            />
          </div>
          <div className="form-row">
            <label>{t('mcp.transport')}</label>
            <select value={transport} onChange={(e) => setTransport((e.target as HTMLSelectElement).value as 'stdio' | 'sse')}>
              <option value="stdio">{t('mcp.stdioOption')}</option>
              <option value="sse">{t('mcp.sseOption')}</option>
            </select>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="form-row">
                <label>{t('mcp.command')}</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand((e.target as HTMLInputElement).value)}
                  placeholder={t('mcp.commandPlaceholder')}
                />
              </div>
              <div className="form-row">
                <label>{t('mcp.args')}</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs((e.target as HTMLInputElement).value)}
                  placeholder={t('mcp.argsPlaceholder')}
                />
              </div>
            </>
          ) : (
            <div className="form-row">
              <label>{t('mcp.url')}</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
                placeholder={t('mcp.urlPlaceholder')}
              />
            </div>
          )}
          <div className="form-actions">
            <button className="btn-mini" onClick={handleAdd} disabled={adding || !serverId.trim()}>
              {adding ? t('mcp.adding') : t('mcp.add')}
            </button>
            <button className="btn-mini" onClick={() => setShowAdd(false)}>{t('mcp.cancel')}</button>
          </div>
        </div>
      )}
    </section>
  )
}
