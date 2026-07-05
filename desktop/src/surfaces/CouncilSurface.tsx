import { useMemo, useState, useEffect } from 'react'
import { useUiState } from '../state/store'
import { useArtifacts, useConveneCouncil, useDomains, useSessions, useSetDomain } from '../state/queries'
import { getArtifact } from '../runtime/client'
import type { DomainEntry } from '../runtime/types'
import { Check, Users, ScrollText, Sparkles } from 'lucide-react'
import { Markdown } from '../components/Markdown'

function parseCouncilOpinions(raw: string): Record<string, string> {
  const opinions: Record<string, string> = {}
  
  const STAR_MAP: Record<string, string[]> = {
    tianshu: ['天枢', 'tianshu'],
    tianxuan: ['天璇', 'tianxuan'],
    tianji: ['天玑', 'tianji'],
    tianquan: ['天权', 'tianquan'],
    yuheng: ['玉衡', 'yuheng'],
    kaiyang: ['开阳', 'kaiyang'],
    yaoguang: ['摇光', 'yaoguang'],
    dongming: ['洞明', 'dongming'],
  }

  const sections = raw.split(/(?=###\s+)/)
  for (const sec of sections) {
    const headerLine = sec.split('\n')[0] ?? ''
    for (const [key, aliases] of Object.entries(STAR_MAP)) {
      if (aliases.some(alias => headerLine.toLowerCase().includes(alias.toLowerCase()))) {
        const content = sec.slice(headerLine.length).trim()
        if (content) {
          opinions[key] = content
        }
      }
    }
  }

  for (const [key, aliases] of Object.entries(STAR_MAP)) {
    if (!opinions[key]) {
      for (const alias of aliases) {
        const regex = new RegExp(`(?:\\*\\*${alias}\\*\\*|###\\s+${alias})[：:\\s]+([\\s\\S]+?)(?=\\n(?:\\*\\*|###|\\#)|$)`, 'i')
        const match = raw.match(regex)
        if (match && match[1]) {
          opinions[key] = match[1].trim()
          break
        }
      }
    }
  }

  return opinions
}

export function CouncilSurface() {
  const ui = useUiState()
  const sessionId = ui.activeSessionId
  const sessions = useSessions()
  const session = sessions.data?.find((s) => s.id === sessionId) ?? null
  const domains = useDomains(sessionId)
  const artifacts = useArtifacts(sessionId, 0)
  const convene = useConveneCouncil()
  const setDomain = useSetDomain()
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [rounds, setRounds] = useState<number>(1)
  
  const planArtifacts = useMemo(() => {
    return (artifacts.data ?? []).filter((a) => a.kind === 'plan' || a.kind === 'task-list')
  }, [artifacts.data])

  const latestCouncil = useMemo(() => {
    return (artifacts.data ?? []).find((a) => a.tool === 'council_convene')
  }, [artifacts.data])

  const [councilRaw, setCouncilRaw] = useState<string>('')
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null)
  const [showFullReport, setShowFullReport] = useState(false)

  const opinions = useMemo(() => {
    return councilRaw ? parseCouncilOpinions(councilRaw) : {}
  }, [councilRaw])

  const activeSeats = useMemo(() => {
    return new Set(Object.keys(opinions))
  }, [opinions])

  useEffect(() => {
    if (latestCouncil && sessionId) {
      getArtifact(sessionId, latestCouncil.id)
        .then((res) => setCouncilRaw(res.raw))
        .catch(() => setCouncilRaw(''))
    } else {
      setCouncilRaw('')
    }
  }, [latestCouncil?.id, sessionId])

  const isRunning = session?.status === 'running'
  const canConvene = !!sessionId && !isRunning && !!selectedArtifactId && !convene.isPending

  const handleConvene = () => {
    if (!canConvene || !selectedArtifactId) return
    convene.mutate({ id: sessionId, artifactId: selectedArtifactId, rounds })
  }

  const handlePickDomain = (key: string) => {
    if (!sessionId || key === 'auto') return
    setDomain.mutate({ id: sessionId, key })
  }

  return (
    <div className="surface-scroll">
      <div className="council-surface">
        <header className="council-header">
          <div>
            <h3><Sparkles size={18} /> 星域名册 · 议事会</h3>
            <p className="council-subtitle">
              {session
                ? `当前线程：${session.title ?? session.id.slice(0, 8)}`
                : '请先在左侧选择一个线程'}
            </p>
          </div>
          {session && (
            <span className={`council-status ${isRunning ? 'running' : 'idle'}`}>
              {isRunning ? '会话运行中' : '会话空闲'}
            </span>
          )}
        </header>

        {!sessionId && <div className="empty">请先选择一个线程。</div>}

        {sessionId && (
          <div className="council-layout">
            <section className="council-panel">
              <div className="council-panel-head">
                <Users size={16} />
                <h4>星域名册</h4>
              </div>
              {domains.isLoading && <div className="surface-loading">加载中…</div>}
              {domains.isError && <div className="meta warn">加载失败</div>}
              <div className="domain-grid">
                {(domains.data ?? []).map((d) => (
                  <DomainCard
                    key={d.key}
                    domain={d}
                    current={d.current}
                    onClick={() => handlePickDomain(d.key)}
                    busy={setDomain.isPending && d.current}
                  />
                ))}
              </div>
            </section>

            <aside className="council-side">
              <section className="council-panel">
                <div className="council-panel-head">
                  <ScrollText size={16} />
                  <h4>召集议事会</h4>
                </div>
                {isRunning ? (
                  <div className="council-hint warn">
                    当前会话正在运行，请等待本轮结束后再召集议事会。
                  </div>
                ) : (
                  <div className="council-form">
                    <label className="council-field">
                      <span>选择计划 artifact</span>
                      <select
                        value={selectedArtifactId ?? ''}
                        onChange={(e) => setSelectedArtifactId(e.target.value || null)}
                      >
                        <option value="">请选择…</option>
                        {planArtifacts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.target} ({a.kind})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="council-field">
                      <span>轮次</span>
                      <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                        <option value={1}>单轮会诊</option>
                        <option value={2}>双轮辩论（有冲突时启用）</option>
                      </select>
                    </label>

                    <button
                      className="btn primary council-convene-btn"
                      onClick={handleConvene}
                      disabled={!canConvene}
                    >
                      {convene.isPending ? '召集中…' : '召集议事会'}
                    </button>

                    {convene.isError && (
                      <div className="council-hint err">
                        召集失败：{(convene.error as Error)?.message}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {latestCouncil && (
                <section className="council-panel result-panel">
                  <div className="council-panel-head">
                    <Check size={16} />
                    <h4>最新议事结果</h4>
                  </div>
                  <div className="council-result-card">
                    <div className="council-result-title">{latestCouncil.target}</div>
                    <div className="council-result-summary">{latestCouncil.summary}</div>
                  </div>

                  <div className="council-roundtable-wrapper">
                    <div className="council-table">
                      <div className="table-center">
                        <div className="table-center-title">会商中枢</div>
                        <div className="table-center-desc truncate" title={latestCouncil.summary}>
                          {latestCouncil.summary}
                        </div>
                      </div>
                      {(domains.data ?? []).filter(d => d.key !== 'auto').map((d, index, arr) => {
                        const total = arr.length
                        const angle = (index * 360) / total
                        const isActive = activeSeats.has(d.key)
                        const isSelected = selectedSeat === d.key
                        
                        return (
                          <button
                            key={d.key}
                            type="button"
                            className={`cr-seat accent-${d.uiPersona?.accent ?? 'primary'} ${isActive ? 'active' : 'disabled'} ${isSelected ? 'selected' : ''}`}
                            style={{
                              transform: `rotate(${angle}deg) translate(100px) rotate(-${angle}deg)`
                            }}
                            onClick={() => {
                              if (isActive) {
                                setSelectedSeat(isSelected ? null : d.key)
                              }
                            }}
                            title={isActive ? `阅读 ${d.name} 的发言意见` : `${d.name} 未在此次会议发言`}
                          >
                            <span className="cr-seat-glyph">{d.uiPersona?.glyph ?? '✹'}</span>
                            <span className="cr-seat-name">{d.name}</span>
                            {isActive && <span className="cr-seat-pulse" />}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {selectedSeat && (() => {
                    const d = (domains.data ?? []).find(x => x.key === selectedSeat)
                    const op = opinions[selectedSeat]
                    if (!d || !op) return null
                    return (
                      <div className="council-opinion-bubble animation-slide-up">
                        <div className="cob-header">
                          <span className="cob-glyph" style={{ borderColor: `var(--${d.uiPersona?.accent ?? 'accent'})` }}>{d.uiPersona?.glyph}</span>
                          <div className="cob-meta">
                            <span className="cob-name">{d.name} · 辩论修订意见</span>
                            <span className="cob-motto">{d.motto}</span>
                          </div>
                        </div>
                        <div className="cob-body">
                          <Markdown source={op} />
                        </div>
                      </div>
                    )
                  })()}

                  {councilRaw && (
                    <div className="council-full-report">
                      <button 
                        type="button"
                        className="cfr-toggle-btn" 
                        onClick={() => setShowFullReport(!showFullReport)}
                      >
                        {showFullReport ? '收起完整议事纪要报告' : '展开完整议事纪要报告'}
                      </button>
                      {showFullReport && (
                        <div className="cfr-markdown border border-border rounded p-3 mt-2 bg-panel-2 overflow-auto max-h-[260px] text-xs">
                          <Markdown source={councilRaw} />
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

function DomainCard({
  domain,
  current,
  onClick,
  busy,
}: {
  domain: DomainEntry
  current: boolean
  onClick: () => void
  busy: boolean
}) {
  const glyph = domain.uiPersona?.glyph ?? '✹'
  const accent = domain.uiPersona?.accent ?? 'primary'
  const disabled = busy || current
  return (
    <button
      type="button"
      className={`domain-card ${current ? 'current' : ''} accent-${accent}`}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={current}
    >
      <div className="domain-glyph" aria-hidden>{glyph}</div>
      <div className="domain-body">
        <div className="domain-name">{domain.key === 'auto' ? `${domain.name} · tianshu` : domain.name}</div>
        <div className="domain-motto">{domain.motto}</div>
        <div className="domain-meta">{domain.meta}</div>
        <div className="domain-essence">{domain.essence}</div>
      </div>
      {current && (
        <span className="domain-current">
          <Check size={12} /> 当前
        </span>
      )}
    </button>
  )
}
