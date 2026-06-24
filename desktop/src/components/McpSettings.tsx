import { useState } from 'react'
import type { McpStatusResponse, McpServerConfig, McpConnectionState } from '../runtime/types'

// ── MCP 预设 ──────────────────────────────────────────────────
// 常用 MCP 服务器的一键添加配置。Context7 提供库文档查询能力，
// 是编码 agent 最常用的外部知识源之一。

interface McpPreset {
  id: string
  name: string
  description: string
  transport: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

const MCP_PRESETS: McpPreset[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: '实时库文档查询 —— 为编码 agent 提供最新框架/库 API 参考，减少幻觉',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
  },
]

interface McpSettingsProps {
  status: McpStatusResponse | null
  statusLoading: boolean
  statusError: string | null
  onAdd: (config: McpServerConfig) => void
  onRemove: (serverId: string) => void
  onRestart: (serverId: string) => void
}

const STATUS_DOT: Record<string, string> = {
  connected: '●',
  connecting: '◐',
  degraded: '◐',
  error: '✗',
  disconnected: '○',
}

const STATUS_LABEL: Record<string, string> = {
  connected: '已连接',
  connecting: '连接中',
  degraded: '降级',
  error: '错误',
  disconnected: '未连接',
}

const STATUS_CLASS: Record<string, string> = {
  connected: 'green',
  connecting: 'yellow',
  degraded: 'yellow',
  error: 'red',
  disconnected: 'muted',
}

function StatusBadge({ state }: { state: McpConnectionState }) {
  const cls = STATUS_CLASS[state.status] ?? 'muted'
  return (
    <span className={`mcp-status-badge ${cls}`} title={state.error ?? ''}>
      <span className="dot">{STATUS_DOT[state.status] ?? '○'}</span>
      <span className="label">{STATUS_LABEL[state.status] ?? state.status}</span>
      {state.toolCount > 0 && <span className="count">{state.toolCount} tools</span>}
    </span>
  )
}

export function McpSettings({
  status,
  statusLoading,
  statusError,
  onAdd,
  onRemove,
  onRestart,
}: McpSettingsProps) {
  const [showAdd, setShowAdd] = useState(false)
  const [serverId, setServerId] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!serverId.trim()) return
    setAdding(true)
    try {
      const config: McpServerConfig = { serverId: serverId.trim() }
      if (transport === 'stdio') {
        config.command = command.trim()
        if (args.trim()) config.args = args.trim().split(/\s+/)
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
      <h4>MCP 服务器</h4>

      {statusLoading && <div className="meta">加载中…</div>}
      {statusError && <div className="meta warn">{statusError}</div>}

      {status && (
        <div className="mcp-summary meta">
          {status.servers.length === 0
            ? '未配置 MCP 服务器'
            : `${status.servers.filter(s => s.status === 'connected').length}/${status.servers.length} 已连接 · ${status.totalTools} 个工具可用`}
        </div>
      )}

      {status && status.servers.length > 0 && (
        <div className="mcp-server-list">
          {status.servers.map((s) => (
            <div key={s.serverId} className="mcp-server-row">
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
                {(s.status === 'connected' || s.status === 'degraded' || s.status === 'error') && (
                  <button
                    className="btn-mini"
                    onClick={() => onRestart(s.serverId)}
                    title="重新连接"
                  >
                    重启
                  </button>
                )}
                <button
                  className="btn-mini danger"
                  onClick={() => onRemove(s.serverId)}
                  title="删除服务器"
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!showAdd && (
        <>
          <div className="mcp-presets">
            <div className="mcp-presets-label">推荐添加</div>
            <div className="mcp-presets-grid">
              {MCP_PRESETS.map(p => (
                <div
                  key={p.id}
                  className="mcp-preset-card"
                  onClick={() => {
                    const config: McpServerConfig = {
                      serverId: p.id,
                      command: p.command,
                      args: p.args,
                      env: p.env,
                    }
                    onAdd(config)
                  }}
                >
                  <div className="mcp-preset-name">+ {p.name}</div>
                  <div className="mcp-preset-desc">{p.description}</div>
                  <div className="mcp-preset-cmd">
                    {p.command} {p.args.join(' ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <button className="btn-mini" onClick={() => setShowAdd(true)}>
            + 添加 MCP 服务器
          </button>
        </>
      )}
      {!showAdd && !MCP_PRESETS.length && (
        <button className="btn-mini" onClick={() => setShowAdd(true)}>
          + 添加 MCP 服务器
        </button>
      )}

      {showAdd && (
        <div className="mcp-add-form">
          <div className="form-row">
            <label>服务器 ID</label>
            <input
              type="text"
              value={serverId}
              onChange={(e) => setServerId((e.target as HTMLInputElement).value)}
              placeholder="如: filesystem"
            />
          </div>
          <div className="form-row">
            <label>传输方式</label>
            <select value={transport} onChange={(e) => setTransport((e.target as HTMLSelectElement).value as 'stdio' | 'sse')}>
              <option value="stdio">stdio (本地进程)</option>
              <option value="sse">SSE (远程服务)</option>
            </select>
          </div>
          {transport === 'stdio' ? (
            <>
              <div className="form-row">
                <label>命令</label>
                <input
                  type="text"
                  value={command}
                  onChange={(e) => setCommand((e.target as HTMLInputElement).value)}
                  placeholder="如: npx"
                />
              </div>
              <div className="form-row">
                <label>参数 (空格分隔)</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs((e.target as HTMLInputElement).value)}
                  placeholder="如: -y @modelcontextprotocol/server-filesystem /tmp"
                />
              </div>
            </>
          ) : (
            <div className="form-row">
              <label>URL</label>
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
                placeholder="如: http://localhost:3001/sse"
              />
            </div>
          )}
          <div className="form-actions">
            <button className="btn-mini" onClick={handleAdd} disabled={adding || !serverId.trim()}>
              {adding ? '添加中…' : '添加'}
            </button>
            <button className="btn-mini" onClick={() => setShowAdd(false)}>取消</button>
          </div>
        </div>
      )}
    </section>
  )
}
