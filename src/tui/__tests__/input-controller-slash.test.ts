/**
 * InputController slash 菜单状态机单测（对标 tianshu-public input-controller）：
 * refreshSlash 开/关/参数模式、move 循环、scroll clamp、carry 保持/重置、
 * MRU 排序与 recordSlashUse 去重前移截顶。
 *
 * 纯类零终端依赖——不构造 TuiApp，直接驱动 InputController。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { InputController, SLASH_MRU_MAX } from '../engine/input-controller.js'
import type { SlashHintEntry } from '../format/slash-hint.js'

const COMMANDS: SlashHintEntry[] = [
  { name: '/help', description: 'Show all commands' },
  { name: '/compact', description: 'Compact conversation context' },
  { name: '/cost', description: 'Show session cost' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/effort', description: 'Set reasoning effort', argsHint: 'off|low|medium|high|max' },
  { name: '/exit', description: 'Quit' },
  { name: '/review', description: 'Run code review' },
  { name: '/review max', description: 'Run full squadron review' },
]

function makeController(): InputController {
  const c = new InputController()
  c.slashCommands = COMMANDS
  return c
}

describe('refreshSlash 开/关', () => {
  it('非 / 输入关闭菜单', () => {
    const c = makeController()
    c.refreshSlash('/h')
    assert.equal(c.slashMenu.open, true)
    c.refreshSlash('hello')
    assert.equal(c.slashMenu.open, false, '非 slash 输入应关闭菜单')
  })

  it('有匹配时打开并给出过滤结果', () => {
    const c = makeController()
    c.refreshSlash('/he')
    assert.equal(c.slashMenu.open, true)
    assert.deepEqual(c.slashMenu.matches.map(m => m.name), ['/help'])
    assert.equal(c.slashMenu.query, 'he')
  })

  it('无匹配时关闭', () => {
    const c = makeController()
    c.refreshSlash('/zzzzqq')
    assert.equal(c.slashMenu.open, false)
  })

  it('空 query（恰好 /）打开菜单（核心层视图由 filter 保证非空）', () => {
    const c = makeController()
    c.refreshSlash('/')
    assert.equal(c.slashMenu.open, true)
    assert.equal(c.slashMenu.matches.length, COMMANDS.length)
  })

  it('closeSlash 只关 open，保留 matches 供渲染兜底', () => {
    const c = makeController()
    c.refreshSlash('/he')
    c.closeSlash()
    assert.equal(c.slashMenu.open, false)
    assert.equal(c.slashMenu.matches.length, 1, 'matches 保留')
  })
})

describe('参数模式（/cmd 尾空格 + argsHint）', () => {
  it('带 argsHint 的命令 + 尾空格 → 菜单保持单条', () => {
    const c = makeController()
    c.refreshSlash('/effort ')
    assert.equal(c.slashMenu.open, true)
    assert.deepEqual(c.slashMenu.matches.map(m => m.name), ['/effort'], '参数模式匹配精确命令')
  })

  it('无 argsHint 的命令 + 尾空格 → 走普通过滤', () => {
    const c = makeController()
    c.refreshSlash('/help ')
    // /help 后跟空格不再前缀匹配任何命令 → 关闭
    assert.equal(c.slashMenu.open, false)
  })

  it('继续输入参数（第二字符）→ 退出参数模式', () => {
    const c = makeController()
    c.refreshSlash('/effort ')
    assert.equal(c.slashMenu.open, true)
    c.refreshSlash('/effort m')
    assert.equal(c.slashMenu.open, false, '参数输入后无命令匹配应关闭')
  })
})

describe('move/scroll 导航', () => {
  it('move 循环：首项上移环绕到末项', () => {
    const c = makeController()
    c.refreshSlash('/c')
    // /c 匹配：prefix 组 /compact /cost /clear + desc 组 /help /review（5 条）
    assert.equal(c.slashMenu.matches.length, 5)
    c.moveSlashSelection(-1)
    assert.equal(c.slashMenu.selected, 4, '上移环绕到末项')
    c.moveSlashSelection(1)
    assert.equal(c.slashMenu.selected, 0, '下移回首项')
  })

  it('scroll clamp 不环绕', () => {
    const c = makeController()
    c.refreshSlash('/c')
    c.scrollSlashSelection(100)
    assert.equal(c.slashMenu.selected, c.slashMenu.matches.length - 1, '向下翻页 clamp 到末项')
    c.scrollSlashSelection(-100)
    assert.equal(c.slashMenu.selected, 0, '向上翻页 clamp 到首项')
  })

  it('菜单关闭时 move/scroll 无副作用', () => {
    const c = makeController()
    c.refreshSlash('hi')
    c.moveSlashSelection(1)
    c.scrollSlashSelection(1)
    assert.equal(c.slashMenu.selected, 0)
  })
})

describe('carrySelection（输入变化保持选中）', () => {
  it('query 未变时选中项保持', () => {
    const c = makeController()
    c.refreshSlash('/c')
    c.moveSlashSelection(2) // 选中 /cost
    c.refreshSlash('/c') // 同 query 刷新（如渲染帧）
    assert.equal(c.slashMenu.selected, 2, '同 query 刷新不重置选中')
  })

  it('query 变化时重置选中', () => {
    const c = makeController()
    c.refreshSlash('/c')
    c.moveSlashSelection(2)
    c.refreshSlash('/co') // query 变了
    assert.equal(c.slashMenu.selected, 0, 'query 变化重置到首项')
  })

  it('旧选中命令在新 matches 中不存在时回退 0', () => {
    const c = makeController()
    c.refreshSlash('/')
    c.moveSlashSelection(3) // 选中 /clear
    // 输入变化使 /clear 不再匹配
    c.refreshSlash('/re')
    assert.equal(c.slashMenu.selected, 0, '旧选中失配回退首项')
    assert.ok(c.slashMenu.matches.some(m => m.name === '/review'))
  })
})

describe('MRU 排序', () => {
  it('recordSlashUse 去重前移', () => {
    const c = makeController()
    c.recordSlashUse('/help')
    c.recordSlashUse('/cost')
    c.recordSlashUse('/help')
    assert.deepEqual(c.slashMru, ['help', 'cost'], '重复记录前移去重（存储剥离 / 前缀）')
  })

  it('recordSlashUse 剥离 / 前缀', () => {
    const c = makeController()
    c.recordSlashUse('cost')
    assert.deepEqual(c.slashMru, ['cost'])
  })

  it('超过 SLASH_MRU_MAX 截断最旧', () => {
    const c = makeController()
    for (let i = 0; i < SLASH_MRU_MAX + 3; i++) {
      c.recordSlashUse(`/cmd${i}`)
    }
    assert.equal(c.slashMru.length, SLASH_MRU_MAX)
    assert.equal(c.slashMru[0], 'cmd' + (SLASH_MRU_MAX + 2), '最新在前')
    assert.ok(!c.slashMru.includes('cmd0'), '最旧被截断')
  })

  it('MRU 命令在同分匹配内排前（/c prefix 组内 /cost 前移）', () => {
    const c = makeController()
    c.refreshSlash('/c')
    assert.deepEqual(
      c.slashMenu.matches.map(m => m.name),
      ['/compact', '/cost', '/clear', '/help', '/review'],
      '无 MRU 时保持注册序（prefix 组在前）',
    )
    c.recordSlashUse('/cost')
    c.refreshSlash('/c')
    assert.deepEqual(
      c.slashMenu.matches.map(m => m.name),
      ['/cost', '/compact', '/clear', '/help', '/review'],
      'MRU 命令同分组内排前',
    )
  })

  it('MRU 不改变跨分组顺序（prefix 组仍在 substring/fuzzy 组前）', () => {
    const c = makeController()
    c.recordSlashUse('/review max') // /review max 是 /re 的 prefix 匹配
    c.refreshSlash('/re')
    const names = c.slashMenu.matches.map(m => m.name)
    assert.equal(names[0]!.startsWith('/review'), true, 'prefix 匹配仍在首位')
    assert.ok(names.includes('/help') === false || names.indexOf('/review') < names.indexOf('/help'), 'review 在 help（fuzzy）前')
  })
})
