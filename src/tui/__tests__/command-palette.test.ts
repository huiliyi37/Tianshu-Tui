import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getPaletteCommands } from '../command-palette.js'

describe('getPaletteCommands', () => {
  it('exposes the pager surface with p hotkey', () => {
    const pager = getPaletteCommands().find(command => command.name === '__surface:pager')

    assert.ok(pager)
    assert.equal(pager.category, 'surface')
    assert.equal(pager.hotkey, 'p')
  })

  // ── T9 提示面板补全：每个 case handler 在 slash-commands.ts 已注册，
  //    但必须在 palette 列表暴露，否则用户输入 `/` 看不到提示。
  //    反证：漏注册任一条 → 下面对应 it 立即打红，提示面板 UI 缺位立刻暴露。

  it('exposes /review (L2 adversarial verifier) for manual code review', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/review')
    assert.ok(cmd, '/review must be in palette so users discover the L2 review trigger')
    assert.match(cmd.description, /review/i)
  })

  it('exposes /review max (L3 Review Squadron, 5 inspectors)', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/review max')
    assert.ok(cmd, '/review max must be in palette so users discover the L3 squadron trigger')
    assert.match(cmd.description, /L3|squadron|inspectors|max/i)
  })

  it('exposes /plan (writing-plans workflow) for creating implementation plans', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/plan')
    assert.ok(cmd, '/plan must be in palette so users discover the writing-plans workflow')
    assert.match(cmd.description, /plan/i)
  })

  it('exposes /write-plan as alias of /plan for users typing the longer form', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/write-plan')
    assert.ok(cmd, '/write-plan must be in palette as a discoverable alias of /plan')
    assert.match(cmd.description, /plan|write/i)
  })

  it('exposes /plan-mode (write-blocked plan authoring mode)', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/plan-mode')
    assert.ok(cmd, '/plan-mode must be in palette so users can enter plan authoring mode')
    assert.match(cmd.description, /plan.*mode|enter.*plan/i)
  })

  it('exposes /plan-list to browse submitted plans', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/plan-list')
    assert.ok(cmd, '/plan-list must be in palette to surface the plan browser')
  })

  it('exposes /plan-approve and /plan-reject for plan workflow hand-off', () => {
    const approve = getPaletteCommands().find(c => c.name === '/plan-approve')
    const reject = getPaletteCommands().find(c => c.name === '/plan-reject')
    assert.ok(approve, '/plan-approve must be in palette to hand off approved plans')
    assert.ok(reject, '/plan-reject must be in palette to surface rejection feedback')
  })

  it('exposes /permission for permission mode/rule discovery', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/permission')
    assert.ok(cmd, '/permission must be in palette so users discover permission controls')
    // 描述已本地化为中文（ad10ae99 权限选择器），中英文关键词都接受
    assert.match(cmd.description, /permission|mode|rule|权限|模式/i)
  })

  it('exposes /skill install to discover skill installation', () => {
    const cmd = getPaletteCommands().find(c => c.name === '/skill install')
    assert.ok(cmd, '/skill install must be in palette so users can install skills')
    assert.match(cmd.description, /install|import|claude/i)
  })

  // 反证：UI 提示面板必须能通过子串过滤命中新增条目。filterCommands 用
  // substring + fuzzy 子序列匹配 — 输入 "plan" 必须返回所有 plan-* 命令。
  // 仅在 palette 列表里写名字但 filter 链路不通（如缺 description）会让
  // 提示面板回到空，UI 仍然看不见。
  it('every plan-family command carries a non-empty description (UI hint cannot collapse)', () => {
    const planCmds = getPaletteCommands().filter(c =>
      c.name === '/plan' ||
      c.name === '/write-plan' ||
      c.name === '/plan-mode' ||
      c.name === '/plan-list' ||
      c.name === '/plan-approve' ||
      c.name === '/plan-reject'
    )
    assert.equal(planCmds.length, 6, 'expected 6 plan-family palette entries')
    for (const c of planCmds) {
      assert.ok(c.description.length > 0, `${c.name} must have a non-empty description`)
    }
  })
})