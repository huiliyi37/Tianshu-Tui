import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatRadioMessage, extractTemplateVars, type RadioContext } from '../radio-templates.js'

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
