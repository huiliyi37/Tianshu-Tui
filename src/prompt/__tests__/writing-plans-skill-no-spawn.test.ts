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
  // These guard phrases are what actively prevent the spawn. Without
  // them the fix is incomplete: the LLM has nothing to anchor on.
  const guards = [
    {
      pattern: '不要调用 `task` / `Agent` / `TodoWrite`',
      why: 'must explicitly name Cursor/Claude Code tool names so the LLM knows what to avoid',
    },
    {
      pattern: '`delegate_task` / `delegate_batch`',
      why: 'must surface real Rivet tool names so the LLM has a positive anchor',
    },
    {
      pattern: '计划阶段不要派子代理',
      why: 'must state the planning-phase prohibition explicitly',
    },
    {
      pattern: '不要派 scout',
      why: 'must forbid the scout concept in the 注意事项 tail',
    },
  ]
  for (const { pattern, why } of guards) {
    assert.ok(
      content.includes(pattern),
      `Guard rail missing: "${pattern}" — ${why}`,
    )
  }
})