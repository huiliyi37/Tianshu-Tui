import { useState } from 'react'
import type { McpStatusResponse, McpServerConfig, McpConnectionState } from '../runtime/types'

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
                <label>参数 (空格分隔，含空格路径用引号包裹)</label>
                <input
                  type="text"
                  value={args}
                  onChange={(e) => setArgs((e.target as HTMLInputElement).value)}
                  placeholder='如: -y @modelcontextprotocol/server-filesystem "C:\Users\docs"'
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
