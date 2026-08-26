import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectSlashToken,
  filterSlashMenu,
  resolveComposerSlash,
  slashNeedsArgs,
} from '../webview-ui/src/slash-local.ts'

test('detectSlashToken: 行首 / 且无空白才是命令态', () => {
  assert.equal(detectSlashToken('/'), '')
  assert.equal(detectSlashToken('/yes'), 'yes')
  assert.equal(detectSlashToken('/per'), 'per')
  assert.equal(detectSlashToken('hi /yes'), null)
  assert.equal(detectSlashToken('/yes off'), null)
  assert.equal(detectSlashToken('plain'), null)
})

test('filterSlashMenu: 空查询返回目录；按名或描述过滤', () => {
  assert.ok(filterSlashMenu('').length >= 8)
  assert.ok(filterSlashMenu('yes').some((c) => c.name === '/yes'))
  assert.ok(filterSlashMenu('/perm').some((c) => c.name.startsWith('/permission')))
  assert.ok(filterSlashMenu('全自动').some((c) => c.name === '/yes'))
  assert.ok(filterSlashMenu('rewind').some((c) => c.name === '/rewind'))
})

test('resolveComposerSlash: /yes 与别名走本地审批，不进 /prompt', () => {
  assert.deepEqual(resolveComposerSlash('/yes'), {
    kind: 'approval',
    mode: 'dangerously-skip-permissions',
  })
  assert.deepEqual(resolveComposerSlash('/yes on'), {
    kind: 'approval',
    mode: 'dangerously-skip-permissions',
  })
  assert.deepEqual(resolveComposerSlash('/yes off'), {
    kind: 'approval',
    mode: 'auto-safe',
  })
})

test('resolveComposerSlash: /permission 三档与别名', () => {
  assert.deepEqual(resolveComposerSlash('/permission supervise'), { kind: 'approval', mode: 'manual' })
  assert.deepEqual(resolveComposerSlash('/permission manual'), { kind: 'approval', mode: 'manual' })
  assert.deepEqual(resolveComposerSlash('/permission auto'), { kind: 'approval', mode: 'auto-safe' })
  assert.deepEqual(resolveComposerSlash('/permission default'), { kind: 'approval', mode: 'auto-safe' })
  assert.deepEqual(resolveComposerSlash('/permission auto 20'), { kind: 'approval', mode: 'auto-safe' })
  assert.deepEqual(resolveComposerSlash('/permission unattended'), {
    kind: 'approval',
    mode: 'dangerously-skip-permissions',
  })
  assert.deepEqual(resolveComposerSlash('/permission yolo confirm'), {
    kind: 'approval',
    mode: 'dangerously-skip-permissions',
  })
  assert.equal(resolveComposerSlash('/permission').kind, 'blocked')
})

test('resolveComposerSlash: 续跑 / 交接 / 计划模式本地落地', () => {
  assert.deepEqual(resolveComposerSlash('/resume'), { kind: 'resume' })
  assert.deepEqual(resolveComposerSlash('/handoff'), { kind: 'handoff', note: undefined })
  assert.deepEqual(resolveComposerSlash('/handoff 下班了'), { kind: 'handoff', note: '下班了' })
  assert.deepEqual(resolveComposerSlash('/plan'), { kind: 'plan-mode', state: 'planning' })
  assert.deepEqual(resolveComposerSlash('/plan-mode'), { kind: 'plan-mode', state: 'planning' })
})

test('resolveComposerSlash: 带任务的生态命令放行给 sidecar', () => {
  assert.equal(resolveComposerSlash('/plan 拆 loop').kind, 'passthrough')
  assert.equal(resolveComposerSlash('/team 并行改测试').kind, 'passthrough')
  assert.equal(resolveComposerSlash('/review max').kind, 'passthrough')
  assert.equal(resolveComposerSlash('/council 评方案').kind, 'passthrough')
  assert.equal(resolveComposerSlash('普通任务').kind, 'passthrough')
})

test('resolveComposerSlash: TUI 本地命令拦下并给友好说明，避免 400', () => {
  const compact = resolveComposerSlash('/compact')
  assert.equal(compact.kind, 'blocked')
  if (compact.kind === 'blocked') assert.match(compact.message, /sidecar|TUI|\/compact/)

  const model = resolveComposerSlash('/model')
  assert.equal(model.kind, 'blocked')
  if (model.kind === 'blocked') assert.match(model.message, /工具栏/)
})

test('resolveComposerSlash: /effort 六档落地，非法参数 blocked', () => {
  assert.deepEqual(resolveComposerSlash('/effort auto'), { kind: 'effort', level: 'auto' })
  assert.deepEqual(resolveComposerSlash('/effort high'), { kind: 'effort', level: 'high' })
  assert.deepEqual(resolveComposerSlash('/effort max'), { kind: 'effort', level: 'max' })
  assert.equal(resolveComposerSlash('/effort').kind, 'blocked')
  assert.equal(resolveComposerSlash('/effort banana').kind, 'blocked')
})

test('resolveComposerSlash: /ask 开关询问模式', () => {
  assert.deepEqual(resolveComposerSlash('/ask'), { kind: 'ask-mode', state: 'asking' })
  assert.deepEqual(resolveComposerSlash('/ask off'), { kind: 'ask-mode', state: 'off' })
})

test('resolveComposerSlash: /steer 指向排队卡；theme 不再误入 effort', () => {
  const steer = resolveComposerSlash('/steer')
  assert.equal(steer.kind, 'blocked')
  if (steer.kind === 'blocked') assert.match(steer.message, /排队/)
  const theme = resolveComposerSlash('/theme')
  assert.equal(theme.kind, 'blocked')
  if (theme.kind === 'blocked') assert.match(theme.message, /TUI/)
})

test('resolveComposerSlash: /rewind /undo 指向用户气泡入口', () => {
  const rewind = resolveComposerSlash('/rewind')
  assert.equal(rewind.kind, 'blocked')
  if (rewind.kind === 'blocked') assert.match(rewind.message, /退到这里/)

  const undo = resolveComposerSlash('/undo')
  assert.equal(undo.kind, 'blocked')
  if (undo.kind === 'blocked') assert.match(undo.message, /退到这里/)
})

test('slashNeedsArgs: /effort 点菜单先补参数', () => {
  assert.equal(slashNeedsArgs('/effort'), true)
})

test('slashNeedsArgs: 需要补任务描述的命令不立刻发送', () => {
  assert.equal(slashNeedsArgs('/team'), true)
  assert.equal(slashNeedsArgs('/plan'), true)
  assert.equal(slashNeedsArgs('/yes'), false)
  assert.equal(slashNeedsArgs('/resume'), false)
})
