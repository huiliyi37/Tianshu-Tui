import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatRadioMessage, formatHeartbeatMessage, extractTemplateVars, type RadioContext, type TemplateVars } from '../radio-templates.js'

describe('extractTemplateVars', () => {
  it('extracts file count and top files from tool history', () => {
    const history = [
      { tool: 'read_file', target: 'src/auth/middleware.ts', status: 'success' as const },
      { tool: 'read_file', target: 'src/auth/types.ts', status: 'success' as const },
      { tool: 'read_file', target: 'src/auth/handler.ts', status: 'success' as const },
    ]
    const vars = extractTemplateVars(history)
    assert.equal(vars.fileCount, 3)
    assert.ok(vars.topFiles.includes('middleware.ts'))
    assert.ok(vars.topFiles.includes('types.ts'))
  })

  it('extracts target files from write/edit tools', () => {
    const history = [
      { tool: 'edit_file', target: 'src/auth/middleware.ts', status: 'success' as const },
      { tool: 'write_file', target: 'src/auth/new-handler.ts', status: 'success' as const },
    ]
    const vars = extractTemplateVars(history)
    assert.ok(vars.targetFiles.includes('middleware.ts'))
    assert.ok(vars.targetFiles.includes('new-handler.ts'))
  })

  it('extracts error info from failed tool', () => {
    const history = [
      { tool: 'bash', target: 'npm test', status: 'failed' as const, error: 'TypeError: cannot read property x of undefined' },
    ]
    const vars = extractTemplateVars(history)
    assert.ok(vars.errorBrief.includes('TypeError'))
    assert.equal(vars.lastFailedTool, 'bash')
  })
})

describe('formatRadioMessage', () => {
  it('formats explore→plan transition', () => {
    const ctx: RadioContext = {
      transition: 'explore→plan',
      vars: { fileCount: 5, topFiles: '（auth.ts, types.ts）', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '观局', turnCount: 3 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.includes('5'))
    assert.ok(msg.includes('auth.ts'))
  })

  it('formats test_fail milestone', () => {
    const ctx: RadioContext = {
      transition: 'test_fail',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: 'auth.test.ts', lastFailedTool: 'bash', failCount: 2, phaseName: '试锋', turnCount: 0 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.includes('✗'))
    assert.ok(msg.includes('2'))
  })

  it('formats stuck warning', () => {
    const ctx: RadioContext = {
      transition: 'stuck',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '铸形', turnCount: 8 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.includes('⚠'))
    assert.ok(msg.includes('铸形'))
    assert.ok(msg.includes('8'))
  })

  it('returns fallback for unknown transition', () => {
    const ctx: RadioContext = {
      transition: 'unknown_transition',
      vars: { fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '', lastFailedTool: '', failCount: 0, phaseName: '观局', turnCount: 5 },
    }
    const msg = formatRadioMessage(ctx)
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.includes('观局'))
  })
})

describe('formatHeartbeatMessage', () => {
  function vars(overrides: Partial<TemplateVars> = {}): TemplateVars {
    return {
      fileCount: 0, topFiles: '', targetFiles: '', errorBrief: '',
      lastFailedTool: '', failCount: 0, phaseName: '寻迹', turnCount: 6,
      ...overrides,
    }
  }

  it('explore heartbeat mentions reading code', () => {
    const msg = formatHeartbeatMessage('explore', vars({ topFiles: '（auth.ts, types.ts）' }))
    assert.ok(msg.includes('了解代码'))
    assert.ok(msg.includes('auth.ts'))
  })

  it('plan heartbeat mentions thinking', () => {
    const msg = formatHeartbeatMessage('plan', vars({ phaseName: '观局', turnCount: 8 }))
    assert.ok(msg.includes('方案'))
    assert.ok(msg.includes('8'))
  })

  it('execute heartbeat mentions files being edited', () => {
    const msg = formatHeartbeatMessage('execute', vars({ targetFiles: 'middleware.ts, handler.ts' }))
    assert.ok(msg.includes('修改'))
    assert.ok(msg.includes('middleware.ts'))
  })

  it('verify heartbeat mentions testing', () => {
    const msg = formatHeartbeatMessage('verify', vars({ errorBrief: '1 个未通过' }))
    assert.ok(msg.includes('验证'))
    assert.ok(msg.includes('1 个未通过'))
  })

  it('deliver heartbeat signals near completion', () => {
    const msg = formatHeartbeatMessage('deliver', vars({ phaseName: '归航' }))
    assert.ok(msg.includes('马上好') || msg.includes('最后检查'))
  })

  it('falls back gracefully for unknown phaseClass', () => {
    const msg = formatHeartbeatMessage('unknown', vars({ phaseName: '未知', turnCount: 3 }))
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.includes('3'))
  })

  it('falls back when all vars are empty in template', () => {
    // explore template: '还在了解代码结构{topFiles}。'
    // With topFiles='', stripped message is '还在了解代码结构。'
    // That has content so it shouldn't trigger the skeletal fallback.
    // Let's test that it renders even without vars
    const msg = formatHeartbeatMessage('explore', vars({ topFiles: '' }))
    // Should still produce a meaningful message
    assert.ok(msg.startsWith('[天枢]'))
    assert.ok(msg.length > 8)
  })
})
