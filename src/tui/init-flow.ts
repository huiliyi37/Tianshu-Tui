/**
 * Headless state machine for the interactive `/init` project scaffolding wizard.
 *
 * Mirrors connect-flow.ts: pure and side-effect free (the fs probe lives in the
 * `probeInitFlowInput` factory; the class itself only transitions on probed
 * data), so every path is unit-testable without a TUI. It produces *view
 * models* (what the overlay renders) and a terminal *commit descriptor* (what
 * src/bootstrap/init-scaffold.ts applies to disk). Zero LLM — all suggestions
 * are deterministic templates derived from the project fingerprint.
 *
 * Three steps:
 *   scope   → multi-choice: verify 声明 / skills 脚手架 / hooks 脚手架
 *             (verify checked by default; skills/hooks opt-in — restraint)
 *   details → the concrete fingerprint-derived items, each toggleable
 *             (skipped when neither skills nor hooks is checked)
 *   confirm → the file list about to be written → Enter commits
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectProjectFingerprint, type ProjectFingerprint } from '../repo/project-fingerprint.js'
import { countInstalledSkills, RECOMMENDED_MAX_SKILLS } from '../skills/skill-loader.js'
import type { InitCommit, InitHookSpec, InitSkillSpec } from '../bootstrap/init-scaffold.js'

export type { InitCommit, InitHookSpec, InitSkillSpec } from '../bootstrap/init-scaffold.js'

export type InitPhase = 'scope' | 'details' | 'confirm'

export interface InitChoiceOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
  /** Multi-select checkbox state (space toggles). */
  checked: boolean
}

/** What the TUI overlay should render for the current step. */
export interface InitView {
  kind: 'multi-choice' | 'confirm'
  title: string
  subtitle?: string
  /** 信息性提示行（非 toggleable 动作项）——如第三方 agent 配置参考提示。 */
  note?: string
  /** e.g. "步骤 1 / 3" */
  stepLabel?: string
  /** multi-choice step */
  options?: InitChoiceOption[]
  /** confirm step: files about to be written */
  lines?: string[]
}

export type InitStepResult =
  | { kind: 'next'; view: InitView }
  | { kind: 'error'; message: string; view: InitView }
  | { kind: 'commit'; commit: InitCommit; summary: string }

/** Everything the wizard needs to know about the project (probed once). */
export interface InitFlowInput {
  fingerprint: ProjectFingerprint
  /** Skills already installed under .rivet/skills (drives the soft cap). */
  installedSkillCount: number
  /** package.json script matching release/publish, when present. */
  releaseScript?: string
}

/**
 * Probe the on-disk project facts the wizard suggests from. The only fs-touching
 * code in this module — InitFlow itself stays pure for unit tests.
 */
export function probeInitFlowInput(cwd: string): InitFlowInput {
  const fingerprint = detectProjectFingerprint(cwd)
  let releaseScript: string | undefined
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> }
    releaseScript = Object.keys(pkg.scripts ?? {}).find(s => /release|publish/.test(s))
  } catch { /* no readable package.json → no release suggestion */ }
  return { fingerprint, installedSkillCount: countInstalledSkills(cwd), releaseScript }
}

/** Scaffold templates carry only what the model cannot infer itself. */
const SCAFFOLD_NOTE = '<!-- /init 生成 · 只写模型自己推断不出来的东西：命令来自项目指纹核实，按需删改。 -->'

/** 克制纪律：建议数 ≤3（另见 SKILL_RESTRAINT_NOTICE），且不突破全局软上限。 */
const MAX_SUGGESTED_SKILLS = 3

/**
 * Deterministic skill suggestions from the project fingerprint: test runner,
 * lint, release. ≤3, and never more than the remaining headroom under
 * RECOMMENDED_MAX_SKILLS (已装 + 新增 ≤5).
 */
export function suggestInitSkills(input: InitFlowInput): InitSkillSpec[] {
  const fp = input.fingerprint
  const headroom = Math.max(0, RECOMMENDED_MAX_SKILLS - input.installedSkillCount)
  const out: InitSkillSpec[] = []
  if (fp.hasTestInfra && fp.testCommand) {
    out.push({
      slug: 'run-tests',
      description: '运行项目测试套件并处理失败（命令经 /init 核实）',
      triggers: ['run tests', '跑测试', '测试失败'],
      body: [
        '# run-tests',
        '',
        SCAFFOLD_NOTE,
        '',
        `测试命令：\`${fp.testCommand}\``,
        '',
        '交付前必须整跑通过；失败先读第一个失败用例的完整输出，修复后重跑全套，不要只跑单条凑绿。',
      ].join('\n'),
    })
  }
  if (fp.lintCommand) {
    out.push({
      slug: 'lint-fix',
      description: '运行项目 lint 并修复问题（命令经 /init 核实）',
      triggers: ['lint', '静态检查', '代码风格'],
      body: [
        '# lint-fix',
        '',
        SCAFFOLD_NOTE,
        '',
        `检查命令：\`${fp.lintCommand}\``,
        '',
        '优先用工具的自动修复（如 --fix），再人工核对 diff；不要逐处手改风格问题。',
      ].join('\n'),
    })
  }
  if (input.releaseScript) {
    out.push({
      slug: 'release',
      description: `项目发版流程（脚本 ${input.releaseScript} 经 /init 核实）`,
      triggers: ['发版', 'release', 'publish'],
      body: [
        '# release',
        '',
        SCAFFOLD_NOTE,
        '',
        `发版入口：\`npm run ${input.releaseScript}\``,
        '',
        '发版前确认测试与 typecheck 全绿，核对版本号与 changelog；发版失败不要重推同一版本号。',
      ].join('\n'),
    })
  }
  return out.slice(0, Math.min(MAX_SUGGESTED_SKILLS, headroom))
}

/**
 * Deterministic hook templates: postTool typecheck (when a typecheck command
 * is known) + postSession test reminder (when the project has tests). 1-2 个。
 */
export function suggestInitHooks(input: InitFlowInput): InitHookSpec[] {
  const fp = input.fingerprint
  const out: InitHookSpec[] = []
  if (fp.typecheckCommand) {
    out.push({
      name: 'posttool-typecheck.sh',
      event: 'postTool',
      // 后台化后脚本立即返回——timeoutMs 用缺省即可，60s 是旧同步版遗留概念。
      purpose: `写操作后后台跑 \`${fp.typecheckCommand}\`，结果落 .rivet/hooks/last-typecheck.log`,
      script: [
        '#!/bin/sh',
        '# /init 生成：Edit/Write 后后台跑 typecheck，失败输出落日志文件。',
        '# 必须立即返回——postTool hook 是 spawnSync 同步执行，阻塞会罚站整个工具循环。',
        '# 只写模型自己推断不出来的东西：typecheck 命令来自项目指纹核实。',
        'case "$RIVET_TOOL_NAME" in',
        '  edit_file|write_file|hash_edit|apply_patch) ;;',
        '  *) exit 0 ;;',
        'esac',
        'mkdir -p .rivet/hooks',
        '# 连续编辑会并发起多个后台检查：同一日志覆盖写，读到的是最近一次完成的结果。',
        `( ${fp.typecheckCommand} > .rivet/hooks/last-typecheck.log 2>&1 ) &`,
        'exit 0',
        '',
      ].join('\n'),
    })
  }
  if (fp.hasTestInfra && fp.testCommand) {
    out.push({
      name: 'postsession-check-tests.sh',
      event: 'postSession',
      purpose: `会话结束提醒用 \`${fp.testCommand}\` 验证后再交付`,
      script: [
        '#!/bin/sh',
        '# /init 生成：会话结束提醒——没有测试证据的交付不算完成。',
        '# 只写模型自己推断不出来的东西：测试命令来自项目指纹核实。',
        // 单引号包裹：shell 双引号内反引号会触发命令替换。
        `echo '提醒：本会话若有代码改动，确认 \`${fp.testCommand}\` 已跑通再交付。'`,
        'exit 0',
        '',
      ].join('\n'),
    })
  }
  return out
}

const SCOPE_VERIFY = 'verify'
const SCOPE_SKILLS = 'skills'
const SCOPE_HOOKS = 'hooks'

export class InitFlow {
  private phase: InitPhase = 'scope'
  private readonly scope = { verify: true, skills: false, hooks: false }
  private readonly skillSpecs: InitSkillSpec[]
  private readonly hookSpecs: InitHookSpec[]
  private readonly skillPicks: boolean[]
  private readonly hookPicks: boolean[]
  /** 项目根存在的第三方 agent 配置（如 CLAUDE.md）——仅作人工参考提示。 */
  private readonly externalAgentDocs?: string[]
  private cancelledFlag = false

  constructor(input: InitFlowInput) {
    this.skillSpecs = suggestInitSkills(input)
    this.hookSpecs = suggestInitHooks(input)
    this.externalAgentDocs = input.fingerprint.externalAgentDocs
    // 进入 details 的项默认全选——用户已在 scope 显式勾选该类别；
    // 「默认不勾选」的克制纪律作用于 scope 层的 skills/hooks 本身。
    this.skillPicks = this.skillSpecs.map(() => true)
    this.hookPicks = this.hookSpecs.map(() => true)
  }

  /** The view for the current step. */
  view(): InitView {
    switch (this.phase) {
      case 'scope':
        return {
          kind: 'multi-choice',
          title: '项目初始化 — 生成范围',
          subtitle: '选择要生成的内容（已有文件与配置不会被覆盖）',
          stepLabel: '步骤 1 / 3',
          note: this.externalAgentDocs && this.externalAgentDocs.length > 0
            ? `ℹ 检测到 ${this.externalAgentDocs.join('、')}（第三方 agent 配置）。可人工参考其内容充实 .rivet.md 的 Stack/纪律节；天枢不会自动搬运或注入它（身份边界）。`
            : undefined,
          options: [
            {
              id: SCOPE_VERIFY,
              label: 'verify 声明',
              description: '.rivet-config.json + .rivet.md ## Stack（补缺，已有 key 不覆盖）',
              recommended: true,
              checked: this.scope.verify,
            },
            {
              id: SCOPE_SKILLS,
              label: `skills 脚手架（建议 ${this.skillSpecs.length} 个）`,
              description: '按项目指纹生成 .rivet/skills/*.md（同名不覆盖，克制 ≤5 个）',
              checked: this.scope.skills,
            },
            {
              id: SCOPE_HOOKS,
              label: `hooks 脚手架（建议 ${this.hookSpecs.length} 个）`,
              description: '.rivet/hooks.json 数组合并 + .rivet/hooks/*.sh 脚本模板',
              checked: this.scope.hooks,
            },
          ],
        }
      case 'details':
        return {
          kind: 'multi-choice',
          title: '项目初始化 — 逐项确认',
          subtitle: '按项目指纹生成的清单（空格去掉不需要的项）',
          stepLabel: '步骤 2 / 3',
          options: [
            // 只展示 scope 页勾选了的类别——未勾选类别的项不会进 commit，不应出现。
            ...(this.scope.skills
              ? this.skillSpecs.map((s, i) => ({
                  id: `skill:${s.slug}`,
                  label: `skill: ${s.slug}`,
                  description: s.description,
                  checked: this.skillPicks[i]!,
                }))
              : []),
            ...(this.scope.hooks
              ? this.hookSpecs.map((h, i) => ({
                  id: `hook:${h.name}`,
                  label: `hook: ${h.event} → ${h.name}`,
                  description: h.purpose,
                  checked: this.hookPicks[i]!,
                }))
              : []),
          ],
        }
      case 'confirm':
        return {
          kind: 'confirm',
          title: '项目初始化 — 确认写入',
          subtitle: '以下文件将被创建或补缺更新（已有内容不覆盖）',
          stepLabel: '步骤 3 / 3',
          lines: this.confirmLines(),
        }
    }
  }

  /** Space: toggle a checkbox on multi-choice steps. */
  toggle(id: string): InitStepResult {
    if (this.cancelledFlag) {
      return { kind: 'error', message: '流程已取消。', view: this.view() }
    }
    switch (this.phase) {
      case 'scope': {
        if (id === SCOPE_SKILLS && !this.scope.skills && this.skillSpecs.length === 0) {
          return { kind: 'error', message: '当前项目无可建议的 skill（未知项目或已达技能上限）。', view: this.view() }
        }
        if (id === SCOPE_HOOKS && !this.scope.hooks && this.hookSpecs.length === 0) {
          return { kind: 'error', message: '当前项目无可建议的 hook 模板（需检测到 typecheck 或测试命令）。', view: this.view() }
        }
        if (id === SCOPE_VERIFY) this.scope.verify = !this.scope.verify
        else if (id === SCOPE_SKILLS) this.scope.skills = !this.scope.skills
        else if (id === SCOPE_HOOKS) this.scope.hooks = !this.scope.hooks
        else return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
        return { kind: 'next', view: this.view() }
      }
      case 'details': {
        const skillIdx = this.skillSpecs.findIndex(s => `skill:${s.slug}` === id)
        if (skillIdx >= 0) {
          this.skillPicks[skillIdx] = !this.skillPicks[skillIdx]
          return { kind: 'next', view: this.view() }
        }
        const hookIdx = this.hookSpecs.findIndex(h => `hook:${h.name}` === id)
        if (hookIdx >= 0) {
          this.hookPicks[hookIdx] = !this.hookPicks[hookIdx]
          return { kind: 'next', view: this.view() }
        }
        return { kind: 'error', message: `未知选项：${id}`, view: this.view() }
      }
      case 'confirm':
        return { kind: 'error', message: '确认页无可切换项（Enter 执行，Esc 取消）。', view: this.view() }
    }
  }

  /** Enter: advance to the next step; on the confirm step produce the commit. */
  confirm(): InitStepResult {
    if (this.cancelledFlag) {
      return { kind: 'error', message: '流程已取消。', view: this.view() }
    }
    switch (this.phase) {
      case 'scope': {
        if (!this.scope.verify && !this.scope.skills && !this.scope.hooks) {
          return { kind: 'error', message: '未选择任何生成项（空格勾选，或 Esc 取消）。', view: this.view() }
        }
        this.phase = this.needsDetails() ? 'details' : 'confirm'
        return { kind: 'next', view: this.view() }
      }
      case 'details':
        this.phase = 'confirm'
        return { kind: 'next', view: this.view() }
      case 'confirm': {
        const commit: InitCommit = {
          verify: this.scope.verify,
          skills: this.pickedSkills(),
          hooks: this.pickedHooks(),
        }
        const parts: string[] = []
        if (commit.verify) parts.push('verify 声明')
        if (commit.skills.length > 0) parts.push(`${commit.skills.length} 个 skill`)
        if (commit.hooks.length > 0) parts.push(`${commit.hooks.length} 个 hook`)
        return { kind: 'commit', commit, summary: `项目初始化：${parts.join(' + ') || '无生成项'}` }
      }
    }
  }

  /** Esc: mark the flow cancelled (the TUI then discards the instance). */
  cancel(): void {
    this.cancelledFlag = true
  }

  get cancelled(): boolean {
    return this.cancelledFlag
  }

  private needsDetails(): boolean {
    return (this.scope.skills && this.skillSpecs.length > 0) || (this.scope.hooks && this.hookSpecs.length > 0)
  }

  private pickedSkills(): InitSkillSpec[] {
    if (!this.scope.skills) return []
    return this.skillSpecs.filter((_, i) => this.skillPicks[i])
  }

  private pickedHooks(): InitHookSpec[] {
    if (!this.scope.hooks) return []
    return this.hookSpecs.filter((_, i) => this.hookPicks[i])
  }

  private confirmLines(): string[] {
    const lines: string[] = []
    if (this.scope.verify) {
      lines.push('.rivet-config.json — verify 声明补缺（已有 key 保留）')
      lines.push('.rivet.md — ## Stack 段同步（由声明单向生成）')
    }
    for (const s of this.pickedSkills()) {
      lines.push(`.rivet/skills/${s.slug}.md — 新建`)
    }
    const hooks = this.pickedHooks()
    if (hooks.length > 0) {
      lines.push('.rivet/hooks.json — 合并新增条目（已有条目保留）')
      for (const h of hooks) lines.push(`.rivet/hooks/${h.name} — 新建（+x）`)
    }
    if (lines.length === 0) lines.push('（没有选中的生成项 — Enter 将不写入任何文件）')
    return lines
  }
}
