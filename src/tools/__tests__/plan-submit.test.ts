import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLAN_SUBMIT_TOOL } from '../plan-submit.js'
import type { ToolCallParams } from '../types.js'
import { slugify } from '../../plan/plan-store.js'

const MERMAID = '```mermaid\nflowchart TD\n  A --> B\n```'

const TEST_DIR = join(tmpdir(), 'opencode-plan-submit-tool-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('plan_submit tool', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('writes submitted plans into .rivet/plans', async () => {
    const result = await PLAN_SUBMIT_TOOL.execute(makeParams({
      title: 'Spec Workflow Upgrade',
      plan: `## Problem description\n\nNeed workflow support.\n\n${MERMAID}`,
    }))

    assert.equal(result.isError, undefined)
    assert.match(result.content, /Plan submitted/)
    assert.match(result.content, /\.rivet\/plans\/spec-workflow-upgrade\.md/)

    const file = join(TEST_DIR, '.rivet', 'plans', 'spec-workflow-upgrade.md')
    const content = readFileSync(file, 'utf-8')
    assert.match(content, /^# Spec Workflow Upgrade/m)
    assert.match(content, /Need workflow support/)
  })

  it('requires dataflow closure sections for complex spec plans', () => {
    const description = PLAN_SUBMIT_TOOL.definition.description

    assert.match(description, /Spec\/dataflow closure/)
    assert.match(description, /fact-flow map/)
    assert.match(description, /condition matrix/)
    assert.match(description, /counterexample test table/)
    assert.match(description, /RED→GREEN/)
  })
})

describe('PLAN_SUBMIT_TOOL soft diagram gate', () => {
  let cwd: string

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'plan-submit-test-'))
  })
  after(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  async function submit(title: string, plan: string) {
    return PLAN_SUBMIT_TOOL.execute({ toolUseId: 'tu', cwd, reviewDepth: 0, input: { title, plan } })
  }

  it('errors when title is missing', async () => {
    const r = await submit('', 'some plan')
    assert.equal(r.isError, true)
    assert.match(String(r.content), /title is required/)
  })

  it('errors when plan is missing', async () => {
    const r = await submit('Empty Plan', '')
    assert.equal(r.isError, true)
    assert.match(String(r.content), /plan is required/)
  })

  it('writes the plan directly when it contains a Mermaid diagram', async () => {
    const title = 'Diagrammed Plan Alpha'
    const r = await submit(title, `Here is the design.\n\n${MERMAID}\n`)
    assert.notEqual(r.isError, true)
    assert.match(String(r.content), /Plan submitted/)
    assert.ok(existsSync(join(cwd, '.rivet/plans', `${slugify(title)}.md`)))
  })

  it('first submit without a diagram does NOT write and nudges once', async () => {
    const title = 'No Diagram Plan Beta'
    const r = await submit(title, 'Plain prose plan, no diagram at all.')
    assert.equal(r.isError, true)
    assert.match(String(r.content), /no Mermaid diagram/)
    assert.match(String(r.content), /```mermaid/)
    assert.equal(existsSync(join(cwd, '.rivet/plans', `${slugify(title)}.md`)), false)
  })

  it('resubmitting the same slug without a diagram passes through (one-shot gate)', async () => {
    const title = 'No Diagram Plan Beta'
    const r = await submit(title, 'Plain prose plan, still no diagram.')
    assert.notEqual(r.isError, true)
    assert.match(String(r.content), /Plan submitted/)
    const written = await readFile(join(cwd, '.rivet/plans', `${slugify(title)}.md`), 'utf-8')
    assert.match(written, /Plain prose plan, still no diagram/)
  })
})
