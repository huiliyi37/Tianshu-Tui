import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeTeamPanelModel, overlayFleetStatus, stripTeamPanelFrames, type TeamPanelModel } from '../team-panel-model.js'
import { FleetRegistry } from '../fleet-registry.js'
import { buildTeamPanelLines } from '../format/team-panel.js'

function baseModel(): TeamPanelModel {
  return {
    mode: 'standard',
    currentWave: 0,
    totalWaves: 2,
    dispatched: 2,
    blocked: [],
    waves: [
      { id: 'wave-1', taskIds: ['t1', 't2'], risk: 'low', reason: 'parallel-safe' },
      { id: 'wave-2', taskIds: ['t3'], risk: 'high', reason: 'shared files' },
    ],
    tasks: [
      { id: 't1', title: 'explore', authority: 'pojun', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'waiting' },
      { id: 't2', title: 'map', authority: 'tianxuan', profile: 'explorer', kind: 'explore', dependsOn: [], riskTier: 'low', files: [], status: 'waiting' },
      { id: 't3', title: 'patch', authority: 'tianliang', profile: 'patcher', kind: 'patch', dependsOn: ['t1'], riskTier: 'high', files: [], status: 'waiting' },
    ],
  }
}

describe('overlayFleetStatus', () => {
  it('upgrades waiting→running and attaches elapsed + activity', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'running', progressLine: 'editing file' }, 1000)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(3000))
    const t1 = model.tasks.find(t => t.id === 't1')!
    assert.equal(t1.status, 'running')
    assert.equal(t1.elapsedMs, 2000)
    assert.equal(t1.activity, 'editing file')
  })

  it('maps passed→done and blocked→blocked', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    fleet.apply({ workOrderId: 'wo_team:t2', parentToolId: 'p1', status: 'blocked' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(10))
    assert.equal(model.tasks.find(t => t.id === 't1')!.status, 'done')
    assert.equal(model.tasks.find(t => t.id === 't2')!.status, 'blocked')
  })

  it('marks a downstream waiting task ready once its deps are done', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(10))
    const t3 = model.tasks.find(t => t.id === 't3')!
    assert.equal(t3.status, 'waiting')
    assert.equal(t3.activity, 'ready · deps met')
  })

  it('never downgrades an already-advanced status', () => {
    const model = baseModel()
    model.tasks[0]!.status = 'done'
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'running' }, 0)
    const out = overlayFleetStatus(model, fleet.getWorkers(10))
    assert.equal(out.tasks.find(t => t.id === 't1')!.status, 'done')
  })

  it('returns the same model when no workers observed', () => {
    const model = baseModel()
    assert.equal(overlayFleetStatus(model, []), model)
  })
})

describe('buildTeamPanelLines progress + live rows', () => {
  it('renders a group progress bar and per-task live rows', () => {
    const fleet = new FleetRegistry()
    fleet.apply({ workOrderId: 'wo_team:t1', parentToolId: 'p1', status: 'completed' }, 0)
    fleet.apply({ workOrderId: 'wo_team:t2', parentToolId: 'p1', status: 'running', progressLine: 'scanning' }, 0)
    const model = overlayFleetStatus(baseModel(), fleet.getWorkers(2500))
    const plain = buildTeamPanelLines(model, 80).join('\n')
    assert.ok(/\d\/3 完成/.test(plain), `progress bar present: ${plain}`)
    assert.ok(plain.includes('scanning'), 'activity line present')
    assert.ok(plain.includes('ready · deps met'), 'dependency unlock cue present')
  })
})

describe('stripTeamPanelFrames（帧剥离：raw 编码串永不入 UI 文本）', () => {
  it('剥离帧行，保留进度文本行', () => {
    const frame = encodeTeamPanelModel(baseModel())
    const mixed = `  ↳ [w1·patcher] ⚙ read_file a.ts\n${frame}\n✦ team progress: 1/3 workers done\n`
    const out = stripTeamPanelFrames(mixed)
    assert.ok(!out.includes('rivet:team-panel:v1'), '帧行被剥离')
    assert.ok(out.includes('⚙ read_file a.ts'), '帧前的进度行保留')
    assert.ok(out.includes('team progress: 1/3'), '帧后的进度行保留')
  })

  it('无帧文本原样返回（引用不变，零开销路径）', () => {
    const text = '✦ team progress: 2/3 workers done\n'
    assert.equal(stripTeamPanelFrames(text), text)
  })

  it('帧独占 chunk 剥离后只剩空白（调用方据此跳过累积）', () => {
    const only = `\n${encodeTeamPanelModel(baseModel())}\n`
    assert.equal(stripTeamPanelFrames(only).trim(), '')
  })

  it('同 buffer 多帧全部剥离（onPlanReady + 中途推进帧）', () => {
    const buf = `${encodeTeamPanelModel(baseModel())}\n✦ team progress: 1/3 workers done\n${encodeTeamPanelModel(baseModel())}\n`
    const out = stripTeamPanelFrames(buf)
    assert.ok(!out.includes('rivet:team-panel:v1'))
    assert.ok(out.includes('team progress'))
  })

  it('撕裂帧（非法 JSON 尾部）同样剥离——泄露防控不依赖 decode 成功', () => {
    const torn = '\nrivet:team-panel:v1:{"mode":"standard","wav\n'
    assert.equal(stripTeamPanelFrames(torn).trim(), '')
  })
})
