import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasActionIntent,
  hasImperativeActionTail,
  hasWriteActionIntent,
  turnUsedOnlyReadTools,
} from '../action-intent-detector.js'

describe('hasActionIntent', () => {
  // ── True positives: 行动承诺 + 工具动词 ──
  it('检测"让我 grep 一下"', () => {
    assert.ok(hasActionIntent('让我 grep 一下 loop.ts 看看调用链'))
  })
  it('检测"接下来修改 turn-orchestrator.ts"', () => {
    assert.ok(hasActionIntent('接下来修改 turn-orchestrator.ts 的 no-tool 路径'))
  })
  it('检测"我来跑一下测试"', () => {
    assert.ok(hasActionIntent('我来跑一下测试确认改动没问题'))
  })
  it('检测"我现在读取文件"', () => {
    assert.ok(hasActionIntent('我现在读取 loop.ts 确认插入点'))
  })
  it('检测"let me read the file"', () => {
    assert.ok(hasActionIntent('let me read the file to check'))
  })
  it('检测"I\'ll run the tests"', () => {
    assert.ok(hasActionIntent("I'll run the tests now"))
  })
  it('检测"let\'s grep for the pattern"', () => {
    assert.ok(hasActionIntent("let's grep for the pattern"))
  })
  it('检测"going to edit that"', () => {
    assert.ok(hasActionIntent("I'm going to edit that file"))
  })
  it('检测"下一步查一下代码"', () => {
    assert.ok(hasActionIntent('下一步查一下代码'))
  })
  it('检测"这就修改"', () => {
    assert.ok(hasActionIntent('这就修改 loop.ts'))
  })
  it('检测"马上执行测试"', () => {
    assert.ok(hasActionIntent('马上执行测试'))
  })

  // ── True positives: 尾部匹配（长文本，行动承诺在最后 600 字符内） ──
  it('长文本尾部含行动承诺时检测成功', () => {
    const prefix = 'A'.repeat(2000)
    const tail = '让我 grep 一下'
    assert.ok(hasActionIntent(prefix + tail))
  })

  // ── True negatives: 无行动承诺 ──
  it('纯回答不含行动承诺', () => {
    assert.ok(!hasActionIntent('这个方案的核心思路是在 no-tool 路径上插入检查'))
  })
  it('只含工具动词不含行动承诺', () => {
    assert.ok(!hasActionIntent('你可以用 grep 搜索这个函数'))
  })
  it('只含行动承诺不含工具动词', () => {
    assert.ok(!hasActionIntent('让我想想这个问题'))
    assert.ok(!hasActionIntent('接下来我解释一下设计思路'))
    assert.ok(!hasActionIntent("let's search for the right approach"))
  })
  it('空字符串', () => {
    assert.ok(!hasActionIntent(''))
  })
  it('已完成任务的总结（不含行动承诺标记）', () => {
    assert.ok(!hasActionIntent('我已经完成了修改，以下是涉及的文件'))
  })
  it('"我来自"不触发（出处陈述，非行动宣言）', () => {
    // 回归：10ecffa5 的误报——"我来自天枢星域" + "运行在 opencode-tui"
    assert.ok(!hasActionIntent('我来自天枢星域，是运行在 opencode-tui 终端编程代理中的 AI 助手'))
  })
  it('"我来了"不触发（到达陈述，非行动宣言）', () => {
    assert.ok(!hasActionIntent('我来了，正在运行测试环境'))
  })

  // ── Edge cases ──
  it('仅"看"不触发（已从动词列表移除，误报太高）', () => {
    assert.ok(!hasActionIntent('让我看一下这个问题'))
  })
  it('"看一下代码"触发（含工具名词限定）', () => {
    assert.ok(hasActionIntent('让我看一下代码'))
  })
  it('无文本时不触发', () => {
    assert.ok(!hasActionIntent(''))
  })
  it('行动承诺在文本开头而非尾部时仍检测', () => {
    assert.ok(hasActionIntent('让我 edit loop.ts\n\n上面是我要做的修改'))
  })
})

describe('hasImperativeActionTail（动词开头的祈使收尾，4df36bcd）', () => {
  it('「全部正确。跑 typecheck + 测试。」触发（无承诺词、裸动词宣布）', () => {
    assert.ok(hasImperativeActionTail('全部正确。跑 typecheck + 测试。'))
    assert.ok(hasActionIntent('全部正确。跑 typecheck + 测试。'), 'hasActionIntent 应同步覆盖')
  })
  it('「更新计划，方向修正为源头量化 + 净删除」触发（spec T3 现场）', () => {
    assert.ok(hasImperativeActionTail('四条全核实完了。\n更新计划，方向修正为源头量化 + 净删除'))
  })
  it('「现在重写计划，修正方向」触发（spec T4 现场）', () => {
    assert.ok(hasImperativeActionTail('现在重写计划，修正方向：源头量化 + 净删除'))
  })
  it('完成态汇报不触发：「测试全部通过。」', () => {
    assert.ok(!hasImperativeActionTail('测试全部通过。'))
  })
  it('完成态汇报不触发：「跑了一遍 typecheck，没有错误。」', () => {
    assert.ok(!hasImperativeActionTail('跑了一遍 typecheck，没有错误。'))
  })
  it('非动词开头的陈述不触发', () => {
    assert.ok(!hasImperativeActionTail('这个方案的核心思路是在 no-tool 路径上插入检查'))
    assert.ok(!hasImperativeActionTail('我来了，正在运行测试环境'))
  })
  it('超长尾句不触发（长句多为陈述而非祈使）', () => {
    assert.ok(!hasImperativeActionTail('运行' + 'X'.repeat(100)))
  })
})

describe('hasWriteActionIntent（只读轮闸门用的写侧承诺）', () => {
  it('「接下来修改 turn-orchestrator.ts」触发', () => {
    assert.ok(hasWriteActionIntent('接下来修改 turn-orchestrator.ts 的 no-tool 路径'))
  })
  it('「接下来重写计划文件」触发（spec 验证项）', () => {
    assert.ok(hasWriteActionIntent('接下来重写计划文件'))
  })
  it('「让我更新文档」触发（spec 验证项）', () => {
    assert.ok(hasWriteActionIntent('让我更新文档'))
  })
  it('祈使收尾同样触发：「跑 typecheck + 测试。」', () => {
    assert.ok(hasWriteActionIntent('全部正确。跑 typecheck + 测试。'))
  })
  it('读侧承诺不触发：「让我看看这个文件」（正常调研，配 read_file 是合法组合）', () => {
    assert.ok(!hasWriteActionIntent('让我看看这个文件'))
  })
  it('读侧承诺不触发：「让我 grep 一下 loop.ts」', () => {
    assert.ok(!hasWriteActionIntent('让我 grep 一下 loop.ts 看看调用链'))
  })
  it('纯陈述不触发', () => {
    assert.ok(!hasWriteActionIntent('这个函数的修改历史在 git log 里'))
  })
})

describe('turnUsedOnlyReadTools', () => {
  it('无工具轮返回 false（归 no-tool 闸门管）', () => {
    assert.equal(turnUsedOnlyReadTools([]), false)
  })
  it('纯读工具轮返回 true', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'grep', input: {} },
      { name: 'read_file', input: {} },
      { name: 'glob', input: {} },
    ]), true)
  })
  it('含写工具返回 false', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'read_file', input: {} },
      { name: 'write_file', input: {} },
    ]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'bash', input: {} }]), false)
    assert.equal(turnUsedOnlyReadTools([{ name: 'run_tests', input: {} }]), false)
  })
  it('委派只读 scout 算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_task', input: { profile: 'code_scout' } },
    ]), true)
  })
  it('委派写能力 profile（patcher）不算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_task', input: { profile: 'patcher' } },
    ]), false)
  })
  it('delegate_batch 任一 task 带写 profile 即不算只读', () => {
    assert.equal(turnUsedOnlyReadTools([
      { name: 'delegate_batch', input: { tasks: [{ profile: 'code_scout' }, { profile: 'patcher' }] } },
    ]), false)
  })
})
