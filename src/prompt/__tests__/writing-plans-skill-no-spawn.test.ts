import { test } from 'node:test'
import { strict as assert } from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SKILL_PATH = join(process.cwd(), '.claude/skills/writing-plans/SKILL.md')

test('writing-plans skill: no spawn-subagent triggers in plan phase', () => {
  const content = readFileSync(SKILL_PATH, 'utf-8')

  // ── HARD BLOCKS ────────────────────────────────────────────────
  // Each of these patterns is what triggered the `task` tool call in
  // session 6176a17f. They must NOT reappear — their presence would
  // re-arm the spawn-subagent concept link in the LLM's streaming.
  const triggers = [
    {
      pattern: '派调研 Scout（当自行调研不足时）',
      why: 'section heading that primes the model to spawn a scout subagent',
    },
    {
      pattern: 'delegate_task 并行 scout 调研',
      why: 'overview recommendation that exposes "spawn scout" as an option',
    },
    {
      pattern: '或 `subagent-driven-development`',
      why: 'template footer that offers subagent-driven-development as an option',
    },
    {
      pattern: '1. 子代理驱动（推荐）',
      why: 'handover list that recommends subagent-driven execution',
    },
    {
      pattern: '**subagent-driven-development**（推荐）',
      why: 'integration section that marks subagent-driven-development as recommended',
    },
  ]
  for (const { pattern, why } of triggers) {
    assert.ok(
      !content.includes(pattern),
      `Trigger pattern re-introduced: "${pattern}" — ${why}`,
    )
  }
})

test('writing-plans skill: anti-spawn guard rail is present', () => {
  const content = readFileSync(SKILL_PATH, 'utf-8')

  // ── REQUIRED GUARDS ────────────────────────────────────────────
  // Updated for delegation-friendly plan phase: the prohibition on ALL
  // delegation is replaced with targeted guidance on when/how to use
  // read-only star-domain scouts.
  const guards = [
    {
      // 364491db 重写了护栏措辞：TodoWrite/WebSearch 已不再逐一点名（task/Agent
      // 在 Rivet 中被自动映射），但仍必须显式点名非 Rivet 子代理工具。
      pattern: '不要调用 `task` / `Agent` 等非 Rivet 的子代理工具',
      why: 'must explicitly name non-Rivet tool names so the LLM knows what to avoid',
    },
    {
      pattern: '`delegate_task`',
      why: 'must surface real Rivet tool name so the LLM has a positive anchor',
    },
    {
      pattern: '只读 profile：`code_scout` 或 `doc_scout`',
      why: 'must guide toward read-only profiles for plan-phase research',
    },
    {
      pattern: '**不要**',
      why: 'must have explicit "do not" guardrails (no write profiles, no delegating main task)',
    },
    {
      pattern: '待核验假设',
      why: 'must warn that scout findings are unverified hypotheses',
    },
  ]
  for (const { pattern, why } of guards) {
    assert.ok(
      content.includes(pattern),
      `Guard rail missing: "${pattern}" — ${why}`,
    )
  }
})

test('writing-plans skill: Plan Mode design-doc branch forbids bash/commit recipes', () => {
  const content = readFileSync(SKILL_PATH, 'utf-8')
  const idx = content.indexOf('#### 3.1a Plan Mode')
  assert.ok(idx >= 0, 'must have §3.1a Plan Mode design-doc section')
  const end = content.indexOf('#### 3.1b', idx)
  assert.ok(end > idx, 'must have §3.1b after 3.1a')
  const planModeSection = content.slice(idx, end)
  assert.ok(planModeSection.includes('设计文档'), '3.1a must describe design doc')
  assert.ok(planModeSection.includes('验证清单'), '3.1a must use verification checklist')
  assert.ok(!planModeSection.includes('```bash'), '3.1a must not contain bash fences')
  assert.ok(!planModeSection.includes('git commit -m'), '3.1a must not contain git commit recipes')
  assert.ok(!planModeSection.includes('npx tsc'), '3.1a must not contain npx tsc recipes')
  // Independent path may still keep executable templates
  const independent = content.slice(end)
  assert.ok(independent.includes('```bash'), '3.1b may keep bash for executable plans')
})
