import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWritingPlanPrompt,
  defaultPlanPath,
  formatPlanDate,
  parseSlashInput,
  resolveEcosystemWorkflowInput,
  semanticPlanSlug,
  slugifyFeatureName,
} from '../ecosystem-workflows.js'

describe('ecosystem workflow helpers', () => {
  it('formats local plan dates as YYYY-MM-DD', () => {
    assert.equal(formatPlanDate(new Date(2026, 4, 19)), '2026-05-19')
  })

  it('slugifies feature names for plan paths', () => {
    assert.equal(slugifyFeatureName('Add Context7 MCP preset!'), 'add-context7-mcp-preset')
    assert.equal(slugifyFeatureName('编写计划 工作流'), '编写计划-工作流')
  })

  it('derives short semantic plan slugs instead of using the full prompt', () => {
    assert.equal(semanticPlanSlug('Add Context7 MCP preset!'), 'add-context7-mcp-preset')
    assert.equal(semanticPlanSlug('编写计划 工作流'), '编写计划-工作流')

    const longFeature = '你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。单会话的场景在现在的生产力下已经几乎不存在了。'
    const slug = semanticPlanSlug(longFeature)

    assert.equal(slug, '多会话并行开发设计文档')
    assert.ok(Buffer.byteLength(slug, 'utf8') <= 96)
  })

  it('builds default docs/superpowers plan path', () => {
    assert.equal(
      defaultPlanPath('Add Context7 MCP preset', new Date(2026, 4, 19)),
      'docs/superpowers/plans/2026-05-19-add-context7-mcp-preset.md',
    )
    assert.equal(
      defaultPlanPath('你说的很好，把这个内容记录到设计文档。如果行数太长就拆分两个，一个背景说明，一个是设计文档。其次，即便我使用 claude code 也是多个会话来并行执行。单会话的场景在现在的生产力下已经几乎不存在了。', new Date(2026, 4, 25)),
      'docs/superpowers/plans/2026-05-25-多会话并行开发设计文档.md',
    )
  })

  it('parses slash input preserving multi-word arguments', () => {
    assert.deepEqual(parseSlashInput('/plan add workflow aliases'), {
      command: '/plan',
      args: 'add workflow aliases',
    })
    assert.equal(parseSlashInput('plain prompt'), null)
  })

  it('builds writing-plans prompt with planning quality gates', () => {
    const prompt = buildWritingPlanPrompt({
      feature: 'Add workflow aliases',
      date: new Date(2026, 4, 19),
    })

    assert.ok(prompt.includes('我正在使用 writing-plans 技能创建实现计划。'))
    assert.ok(prompt.includes('加载 /skill writing-plans 查看完整方法论。'))
    assert.ok(prompt.includes('Do not write implementation code yet.'))
    assert.ok(prompt.includes('Read relevant code deeply before proposing tasks'))
    assert.ok(prompt.includes('docs/superpowers/plans/2026-05-19-add-workflow-aliases.md'))
    assert.ok(prompt.includes('Plan filenames must be short business-semantic names.'))
    assert.ok(prompt.includes('Do not mechanically use the entire'))
    assert.ok(prompt.includes('File structure'))
    assert.ok(prompt.includes('Research endorsement（调研背书）'))
    assert.ok(prompt.includes('write failing test → run and confirm failure → implement minimum code'))
    assert.ok(prompt.includes('Forbidden placeholders'))
    assert.ok(prompt.includes('TODO / TBD / 待定 / 后续实现 / 补充细节'))
    assert.ok(prompt.includes('Spec coverage'))
    assert.ok(prompt.includes('子代理驱动（推荐）'))
    assert.ok(prompt.includes('内联执行'))
  })

  it('resolves /plan and /write-plan into workflow prompts', () => {
    const date = new Date(2026, 4, 19)
    const plan = resolveEcosystemWorkflowInput('/plan add skill loader', { date })
    const writePlan = resolveEcosystemWorkflowInput('/write-plan add skill loader', { date })

    assert.equal(plan?.command, '/plan')
    assert.equal(writePlan?.command, '/write-plan')
    assert.ok(plan?.prompt.includes('add skill loader'))
    assert.ok(writePlan?.prompt.includes('writing-plans'))
  })

  it('resolves /team into a team-mode workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/team docs/superpowers/plans/loop-split-v3.md')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('团队模式核心骨架'))
    assert.ok(resolved?.prompt.includes('team_orchestrate'))
    assert.ok(resolved?.prompt.includes('delegate_batch'))
    assert.ok(resolved?.prompt.includes('patcher workers as 天梁 executors'))
    assert.ok(resolved?.prompt.includes('verification'))
    assert.ok(resolved?.prompt.includes('deliver_task'))
  })

  it('resolves /team max into planning-first team workflow prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/team max refactor loop pipeline')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('/team max'))
    assert.ok(resolved?.prompt.includes('multi-perspective planning'))
    assert.ok(resolved?.prompt.includes('risk audit'))
  })

  it('returns usage prompt for empty /team args', () => {
    const resolved = resolveEcosystemWorkflowInput('/team')

    assert.equal(resolved?.command, '/team')
    assert.ok(resolved?.prompt.includes('Team usage:'))
  })

  it('resolves /plan close into a plan_close tool prompt', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan close docs/superpowers/plans/demo.md --tasks 1-7 --verified npx tsc --noEmit --delivery YELLOW --note external files present')

    assert.equal(resolved?.command, '/plan')
    assert.ok(resolved?.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved?.prompt.includes('- file_path: docs/superpowers/plans/demo.md'))
    assert.ok(resolved?.prompt.includes('- tasks: 1-7'))
    assert.ok(resolved?.prompt.includes('- apply: false'))
    assert.ok(resolved?.prompt.includes('Preview only; do not write the file.'))
    assert.ok(resolved?.prompt.includes('npx tsc --noEmit'))
    assert.ok(resolved?.prompt.includes('- deliveryState: YELLOW'))
    assert.ok(resolved?.prompt.includes('- note: external files present'))
  })

  it('resolves /plan-close into a plan_close tool prompt with apply flag', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan-close docs/superpowers/plans/demo.md --tasks all --apply')

    assert.equal(resolved?.command, '/plan-close')
    assert.ok(resolved?.prompt.includes('Use the plan_close tool'))
    assert.ok(resolved?.prompt.includes('- tasks: all'))
    assert.ok(resolved?.prompt.includes('- apply: true'))
    assert.ok(!resolved?.prompt.includes('Preview only'))
  })

  it('keeps /write-plan close as writing-plans workflow', () => {
    const resolved = resolveEcosystemWorkflowInput('/write-plan close workflow docs')

    assert.equal(resolved?.command, '/write-plan')
    assert.ok(resolved?.prompt.includes('Create a comprehensive implementation plan for: close workflow docs'))
    assert.ok(!resolved?.prompt.includes('Use the plan_close tool'))
  })

  it('returns usage prompt for invalid plan close args', () => {
    const resolved = resolveEcosystemWorkflowInput('/plan close docs/superpowers/plans/demo.md')

    assert.equal(resolved?.command, '/plan')
    assert.ok(resolved?.prompt.includes('Plan close usage:'))
  })

  it('does not resolve empty or unrelated commands', () => {
    assert.equal(resolveEcosystemWorkflowInput('/plan'), null)
    assert.equal(resolveEcosystemWorkflowInput('/quality-gate'), null)
    assert.equal(resolveEcosystemWorkflowInput('plain prompt'), null)
  })
})
