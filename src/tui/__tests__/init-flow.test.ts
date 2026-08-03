import { test } from 'node:test'
import assert from 'node:assert/strict'

import { InitFlow, suggestInitSkills, suggestInitHooks, type InitFlowInput } from '../init-flow.js'

const NODE_INPUT: InitFlowInput = {
  fingerprint: {
    language: 'typescript',
    testCommand: 'npx vitest run',
    buildCommand: 'npm run build',
    typecheckCommand: 'tsc --noEmit',
    lintCommand: 'npx eslint .',
    hasTestInfra: true,
  },
  installedSkillCount: 0,
  releaseScript: 'release',
}

const UNKNOWN_INPUT: InitFlowInput = {
  fingerprint: { language: 'unknown', hasTestInfra: false },
  installedSkillCount: 0,
}

const WITH_CLAUDE_INPUT: InitFlowInput = {
  fingerprint: { language: 'typescript', hasTestInfra: false, externalAgentDocs: ['CLAUDE.md'] },
  installedSkillCount: 0,
}

test('scope step shows informational note when external agent configs exist', () => {
  const flow = new InitFlow(WITH_CLAUDE_INPUT)
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.match(view.note ?? '', /检测到 CLAUDE\.md（第三方 agent 配置）/)
  assert.match(view.note ?? '', /天枢不会自动搬运或注入它（身份边界）/)
})

test('scope step has no note when no external agent configs exist', () => {
  const flow = new InitFlow(NODE_INPUT)
  const view = flow.view()
  assert.equal(view.note, undefined)
})

test('scope step lists the three scopes; verify checked + recommended, skills/hooks opt-in', () => {
  const flow = new InitFlow(NODE_INPUT)
  const view = flow.view()
  assert.equal(view.kind, 'multi-choice')
  assert.equal(view.stepLabel, '步骤 1 / 3')
  const byId = new Map((view.options ?? []).map(o => [o.id, o]))
  assert.deepEqual([...byId.keys()], ['verify', 'skills', 'hooks'])
  assert.equal(byId.get('verify')?.checked, true)
  assert.equal(byId.get('verify')?.recommended, true)
  // 克制纪律：skills/hooks 默认不勾选。
  assert.equal(byId.get('skills')?.checked, false)
  assert.equal(byId.get('hooks')?.checked, false)
  // 建议数量写进 label，且 ≤3。
  assert.match(byId.get('skills')?.label ?? '', /建议 3 个/)
  assert.match(byId.get('hooks')?.label ?? '', /建议 2 个/)
})

test('suggestions derive deterministically from the fingerprint', () => {
  const skills = suggestInitSkills(NODE_INPUT)
  assert.deepEqual(skills.map(s => s.slug), ['run-tests', 'lint-fix', 'release'])
  // 模板正文简短，且带「只写模型自己推断不出来的东西」注释。
  for (const s of skills) {
    assert.ok(s.body.split('\n').length <= 8, `${s.slug} body should stay minimal`)
    assert.match(s.body, /只写模型自己推断不出来的东西/)
  }
  assert.match(skills[0]!.body, /npx vitest run/)

  const hooks = suggestInitHooks(NODE_INPUT)
  assert.deepEqual(hooks.map(h => h.name), ['posttool-typecheck.sh', 'postsession-check-tests.sh'])
  assert.equal(hooks[0]!.event, 'postTool')
  assert.match(hooks[0]!.script, /RIVET_TOOL_NAME/)
  assert.match(hooks[0]!.script, /tsc --noEmit/)
  assert.equal(hooks[1]!.event, 'postSession')
  // postSession 提醒脚本用单引号包裹，避免反引号触发 shell 命令替换。
  assert.match(hooks[1]!.script, /echo '提醒：/)
})

test('skill suggestions respect the RECOMMENDED_MAX_SKILLS headroom', () => {
  // 已装 4 个 → 只剩 1 个余量。
  assert.equal(suggestInitSkills({ ...NODE_INPUT, installedSkillCount: 4 }).length, 1)
  // 已装 5 个 → 不再建议。
  assert.equal(suggestInitSkills({ ...NODE_INPUT, installedSkillCount: 5 }).length, 0)
  // 无 lint / 无 release → 只剩 run-tests。
  const minimal: InitFlowInput = {
    fingerprint: { language: 'rust', testCommand: 'cargo test', hasTestInfra: true },
    installedSkillCount: 0,
  }
  assert.deepEqual(suggestInitSkills(minimal).map(s => s.slug), ['run-tests'])
})

test('verify-only path skips details and commits immediately', () => {
  const flow = new InitFlow(NODE_INPUT)
  const step = flow.confirm()
  assert.equal(step.kind, 'next')
  assert.equal(flow.view().kind, 'confirm')
  assert.equal(flow.view().stepLabel, '步骤 3 / 3')
  assert.deepEqual(flow.view().lines, [
    '.rivet-config.json — verify 声明补缺（已有 key 保留）',
    '.rivet.md — ## Stack 段同步（由声明单向生成）',
  ])

  const done = flow.confirm()
  assert.equal(done.kind, 'commit')
  if (done.kind !== 'commit') return
  assert.equal(done.commit.verify, true)
  assert.deepEqual(done.commit.skills, [])
  assert.deepEqual(done.commit.hooks, [])
  assert.match(done.summary, /verify/)
})

test('full path: scope multi-select → details 逐项 → confirm → commit', () => {
  const flow = new InitFlow(NODE_INPUT)
  flow.toggle('skills')
  flow.toggle('hooks')
  const step = flow.confirm()
  assert.equal(step.kind, 'next')

  // details：3 skill + 2 hook，默认全选（scope 已显式勾选类别）。
  const details = flow.view()
  assert.equal(details.kind, 'multi-choice')
  assert.equal(details.stepLabel, '步骤 2 / 3')
  const opts = details.options ?? []
  assert.equal(opts.length, 5)
  assert.ok(opts.every(o => o.checked))
  assert.deepEqual(opts.map(o => o.id), [
    'skill:run-tests', 'skill:lint-fix', 'skill:release',
    'hook:posttool-typecheck.sh', 'hook:postsession-check-tests.sh',
  ])

  // 去掉 release skill 与一个 hook。
  flow.toggle('skill:release')
  flow.toggle('hook:postsession-check-tests.sh')
  const afterToggle = flow.view()
  const byId = new Map((afterToggle.options ?? []).map(o => [o.id, o]))
  assert.equal(byId.get('skill:release')?.checked, false)
  assert.equal(byId.get('hook:postsession-check-tests.sh')?.checked, false)
  assert.equal(byId.get('skill:run-tests')?.checked, true)

  assert.equal(flow.confirm().kind, 'next')
  // confirm 页列出将写入的文件。
  const lines = flow.view().lines ?? []
  assert.ok(lines.some(l => l.includes('.rivet/skills/run-tests.md')))
  assert.ok(lines.some(l => l.includes('.rivet/skills/lint-fix.md')))
  assert.ok(!lines.some(l => l.includes('release')))
  assert.ok(lines.some(l => l.includes('.rivet/hooks.json')))
  assert.ok(lines.some(l => l.includes('.rivet/hooks/posttool-typecheck.sh')))
  assert.ok(!lines.some(l => l.includes('postsession')))

  const done = flow.confirm()
  assert.equal(done.kind, 'commit')
  if (done.kind !== 'commit') return
  assert.equal(done.commit.verify, true)
  assert.deepEqual(done.commit.skills.map(s => s.slug), ['run-tests', 'lint-fix'])
  assert.deepEqual(done.commit.hooks.map(h => h.name), ['posttool-typecheck.sh'])
  assert.match(done.summary, /2 个 skill/)
  assert.match(done.summary, /1 个 hook/)
})

test('confirm with nothing checked is rejected on the scope step', () => {
  const flow = new InitFlow(NODE_INPUT)
  flow.toggle('verify') // uncheck the only default
  const res = flow.confirm()
  assert.equal(res.kind, 'error')
  assert.match(res.kind === 'error' ? res.message : '', /未选择/)
  assert.equal(flow.view().stepLabel, '步骤 1 / 3')
})

test('skills/hooks scope toggle errors when there is nothing to suggest', () => {
  const flow = new InitFlow(UNKNOWN_INPUT)
  const skillsRes = flow.toggle('skills')
  assert.equal(skillsRes.kind, 'error')
  assert.match(skillsRes.kind === 'error' ? skillsRes.message : '', /skill/)
  const hooksRes = flow.toggle('hooks')
  assert.equal(hooksRes.kind, 'error')
  assert.match(hooksRes.kind === 'error' ? hooksRes.message : '', /hook/)
  // 校验失败不推进状态：仍停留在 scope 且未勾选。
  const view = flow.view()
  assert.equal(view.stepLabel, '步骤 1 / 3')
  assert.ok((view.options ?? []).every(o => o.id === 'verify' ? o.checked : !o.checked))
})

test('unknown ids and confirm-step toggles are errors, not state changes', () => {
  const flow = new InitFlow(NODE_INPUT)
  assert.equal(flow.toggle('nope').kind, 'error')
  flow.confirm() // → confirm (verify only)
  assert.equal(flow.toggle('verify').kind, 'error')
})

test('details only lists categories checked on the scope step', () => {
  // 只勾 skills → details 不出现 hook 项；commit 也不含 hooks。
  const flow = new InitFlow(NODE_INPUT)
  flow.toggle('skills')
  assert.equal(flow.confirm().kind, 'next')
  const opts = flow.view().options ?? []
  assert.ok(opts.length > 0)
  assert.ok(opts.every(o => o.id.startsWith('skill:')))
  const done = flow.confirm() && flow.confirm()
  assert.equal(done.kind, 'commit')
  if (done.kind !== 'commit') return
  assert.deepEqual(done.commit.skills.map(s => s.slug), ['run-tests', 'lint-fix', 'release'])
  assert.deepEqual(done.commit.hooks, [])
})

test('cancel (Esc) terminates the flow; further input is rejected', () => {
  const flow = new InitFlow(NODE_INPUT)
  flow.toggle('skills')
  flow.cancel()
  assert.equal(flow.cancelled, true)
  assert.equal(flow.confirm().kind, 'error')
  assert.equal(flow.toggle('hooks').kind, 'error')
})
