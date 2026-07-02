/**
 * Skill loader — progressive disclosure (Claude Code / Codex parity).
 *
 * Two tiers:
 *  - Tier 1 (discovery): only name + description of every skill is injected
 *    into the dynamic appendix (cache-safe volatile region) via
 *    renderDiscoveryBlock. Bodies are NOT injected here.
 *  - Tier 2 (activation): the full SKILL.md body is loaded ON DEMAND — by the
 *    model via the `skill` tool, or by the user via `/skill <name>` — by reading
 *    skillRegistry.get(name).body. No truncation: oversized bodies are handled
 *    append-only by the tool pipeline's artifact intercept.
 *
 * This replaces the old eager "inject full body of every matched skill every
 * turn" model, whose 4000/8000-char budgets caused silent truncation.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SkillSource = 'rivet' | 'project-claude' | 'global-claude' | 'builtin'

export interface SkillDefinition {
  name: string
  description: string
  /** Regex patterns — any match marks the skill relevant to the current turn. */
  triggers: RegExp[]
  body: string
  tierLock?: 'cheap' | 'balanced' | 'strong'
  builtIn?: boolean
  /** Where the skill was loaded from (set by the loader, not the parser). */
  source?: SkillSource
  /** Absolute path to the backing file (set by the loader). */
  bodyPath?: string
  /** Skill 根目录（仅目录型技能有；扁平 .rivet/skills/*.md 为 undefined）。 */
  skillDir?: string
}

/** A sub-file inside a directory skill (relative to its skillDir). */
export interface SkillFileEntry {
  path: string
  kind: 'file' | 'dir'
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {}
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    let val = m[2]!.trim()

    // YAML multiline literal block scalar (`description: |`). The indented
    // lines that follow are the value; we strip the common indentation prefix
    // and join them with '\n' (| preserves newlines). Without this, Claude
    // skills imported with YAML multiline descriptions parse as `"|"` — a
    // single pipe character — and are invisible in /skill list.
    if (val === '|' || val === '>') {
      const chunks: string[] = []
      let minIndent = Infinity
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!
        const indentMatch = next.match(/^(\s+)/)
        if (!indentMatch) break // non-indented → end of block scalar
        const indent = indentMatch[1]!.length
        if (indent < minIndent) minIndent = indent
        chunks.push(next)
        i++
      }
      val = chunks.map(l => l.slice(minIndent)).join(val === '>' ? ' ' : '\n')
    }

    if (val.startsWith('[')) {
      try {
        const parsed = JSON.parse(val.replace(/'/g, '"')) as string[]
        fm[key] = parsed.map(item => String(item))
      } catch {
        fm[key] = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
      }
    } else {
      fm[key] = val
    }
  }
  return fm
}

export function parseSkillMarkdown(content: string, fileName: string): SkillDefinition {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error(`Skill ${fileName}: missing YAML frontmatter`)
  }

  const fm = parseFrontmatter(match[1]!)
  const body = match[2]!.trim()
  const name = typeof fm.name === 'string' && fm.name ? fm.name : fileName.replace(/\.md$/, '')

  let triggers: RegExp[] = []
  const triggerRaw = fm.triggers ?? fm.trigger
  if (Array.isArray(triggerRaw)) {
    triggers = triggerRaw.map(t => new RegExp(String(t), 'i'))
  } else if (typeof triggerRaw === 'string' && triggerRaw) {
    triggers = [new RegExp(triggerRaw, 'i')]
  }

  return {
    name,
    description: typeof fm.description === 'string' ? fm.description : '',
    triggers,
    body,
    tierLock: fm.tierLock === 'cheap' || fm.tierLock === 'balanced' || fm.tierLock === 'strong'
      ? fm.tierLock
      : undefined,
    builtIn: false,
  }
}

export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>()

  register(skill: SkillDefinition): void {
    this.skills.set(skill.name, skill)
  }

  /**
   * Load skills from `.rivet/skills/`. Supports two shapes side by side:
   *  - flat `name.md` (Rivet-native format) — no skillDir.
   *  - directory `name/SKILL.md` (Claude/agentskills format, copied in) — the
   *    directory is preserved (NOT flattened) so its sub-files (references/,
   *    scripts/, assets/) can be read on demand (Tier-3). `skillDir` is set.
   */
  loadFromDirectory(dir: string, source: SkillSource = 'rivet'): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    if (!existsSync(dir)) return { loaded, errors }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip `_`-prefixed entries (e.g. `_drafts/`): auto-distilled skill drafts
      // are review-only and must never enter the discovery block / frozen prefix.
      if (entry.name.startsWith('_')) continue
      try {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const skillFile = join(dir, entry.name)
          const def = parseSkillMarkdown(readFileSync(skillFile, 'utf-8'), entry.name)
          def.source = source
          def.bodyPath = skillFile
          this.skills.set(def.name, def)
          loaded.push(def.name)
        } else if (entry.isDirectory()) {
          const skillFile = join(dir, entry.name, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          // Directory skills derive their name from the folder; pass it as the
          // fallback so a frontmatter-less SKILL.md is named after its folder.
          const def = parseSkillMarkdown(readFileSync(skillFile, 'utf-8'), entry.name)
          def.source = source
          def.bodyPath = skillFile
          def.skillDir = join(dir, entry.name)
          this.skills.set(def.name, def)
          loaded.push(def.name)
        }
      } catch (e) {
        errors.push(`${entry.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { loaded, errors }
  }

  /**
   * Load `.claude/skills/<name>/SKILL.md` directories (Claude Code format).
   * If `filter` is provided, only directories whose name is in the set are loaded.
   */
  loadFromClaudeDirectory(
    dir: string,
    source: SkillSource,
    filter?: Set<string>,
  ): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    if (!existsSync(dir)) return { loaded, errors }

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (filter && !filter.has(entry.name)) continue
      const skillFile = join(dir, entry.name, 'SKILL.md')
      if (!existsSync(skillFile)) continue
      try {
        const content = readFileSync(skillFile, 'utf-8')
        // Claude skills derive their name from the directory; pass it as the
        // fallback so a frontmatter-less SKILL.md is named after its folder.
        const def = parseSkillMarkdown(content, entry.name)
        def.source = source
        def.bodyPath = skillFile
        this.skills.set(def.name, def)
        loaded.push(def.name)
      } catch (e) {
        errors.push(`${entry.name}/SKILL.md: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { loaded, errors }
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  list(): SkillDefinition[] {
    return [...this.skills.values()]
  }

  /** Skills whose trigger patterns explicitly match the given text. */
  match(text: string): SkillDefinition[] {
    return this.list().filter(skill =>
      skill.triggers.length === 0 || skill.triggers.some(re => re.test(text)),
    )
  }

  /**
   * Tier-1 discovery block: name + description of EVERY available skill, so the
   * model knows what it can load. Bodies are never included here. Skills whose
   * triggers match `hint` are surfaced first and marked relevant. The budget is
   * spent on descriptions only, so overflow is rare; when it happens, the
   * least-relevant tail is dropped (never the bodies — there are none).
   */
  renderDiscoveryBlock(
    hint?: string,
    opts?: { maxChars?: number; maxDescChars?: number; exclude?: Set<string> },
  ): string | null {
    // PlusMenu — drop per-session disabled skills so the model never sees them
    // in the discovery block (and thus won't try to load them via the tool).
    const exclude = opts?.exclude
    const all = exclude && exclude.size > 0
      ? this.list().filter((s) => !exclude.has(s.name))
      : this.list()
    if (all.length === 0) return null

    const maxChars = opts?.maxChars ?? 1500
    const maxDescChars = opts?.maxDescChars ?? 200

    const isRelevant = (skill: SkillDefinition): boolean =>
      !!hint && skill.triggers.length > 0 && skill.triggers.some(re => re.test(hint))

    // Relevant skills first (stable name order within each group) so the budget,
    // if it overflows, keeps the most useful entries.
    const ordered = [...all].sort((a, b) => {
      const ra = isRelevant(a) ? 0 : 1
      const rb = isRelevant(b) ? 0 : 1
      if (ra !== rb) return ra - rb
      return a.name.localeCompare(b.name)
    })

    const lines: string[] = []
    let budget = maxChars
    let dropped = 0
    for (const skill of ordered) {
      const desc = (skill.description || '').replace(/\s+/g, ' ').trim().slice(0, maxDescChars)
      const rel = isRelevant(skill) ? ' relevant="true"' : ''
      const line = `<skill name="${skill.name}"${rel}>${desc}</skill>`
      if (line.length > budget) { dropped++; continue } // try smaller entries instead of cutting off the rest
      lines.push(line)
      budget -= line.length
    }
    if (lines.length === 0) return null

    // Scale safety net: when the budget overflowed and entries were dropped,
    // tell the model how many are omitted so it never silently misses a skill
    // (recall-first — fidelity priority). Relevant skills are sorted first, so
    // the dropped tail is the least-relevant.
    const tail = dropped > 0
      ? [`<more count="${dropped}" note="More skills available but omitted for space. Refine your request to surface them, or the user can run /skill list."/>`]
      : []
    return [
      '<available-skills note="Call the skill tool with a name to load its full instructions on demand.">',
      ...lines,
      ...tail,
      '</available-skills>',
    ].join('\n')
  }

  /**
   * @deprecated Superseded by renderDiscoveryBlock + the `skill` tool.
   * Kept as a degraded fallback that eagerly inlines bodies under a char
   * budget. `continue` (not `break`) so one oversized skill no longer drops
   * every skill after it.
   */
  renderMatchedBlock(text: string, maxChars = 4000): string | null {
    const matched = this.match(text)
    if (matched.length === 0) return null

    const parts: string[] = ['<skills>']
    let budget = maxChars
    for (const skill of matched.slice(0, 3)) {
      const block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
      if (block.length > budget) continue
      parts.push(block)
      budget -= block.length
    }
    parts.push('</skills>')
    return parts.join('\n')
  }

  /**
   * Build an `<invoked-skills>` block for skills explicitly loaded this session.
   * Unlike the discovery block, this includes the FULL body so the model keeps
   * following the protocol after context compaction. The block is rendered into
   * the dynamic appendix (cache-safe tail), not the frozen base.
   */
  renderInvokedSkillsBlock(names: string[], cwd: string): string | null {
    const skills: SkillDefinition[] = []
    for (const name of [...new Set(names)]) {
      const skill = this.get(name) ?? this.list().find(s => s.name.toLowerCase() === name.toLowerCase())
      if (skill) skills.push(skill)
    }
    if (skills.length === 0) return null

    const blocks: string[] = []
    for (const skill of skills) {
      let block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
      if (skill.skillDir) {
        const files = listSkillFiles(skill.skillDir)
        if (files.length > 0) {
          block += `\n<skill-files dir="${skill.skillDir}" note="Read on demand with read_file/grep/glob; page large sub-files completely with offset/limit.">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
        }
      }
      blocks.push(block)
    }

    return [
      '<invoked-skills note="These skills were explicitly invoked this session. Continue following their instructions unless the user says otherwise. When a skill workflow is fully finished, call skill(name=\"<name>\", complete=true) to release it.">',
      ...blocks,
      '</invoked-skills>',
    ].join('\n')
  }
}

/**
 * List the sub-files of a directory skill (relative to `skillDir`, excluding the
 * SKILL.md router itself). Bounded by depth and entry count so a pathological
 * skill folder can't flood the model's context. This is the "safety net" tree:
 * the author's hand-written links in SKILL.md are the primary path; this list
 * keeps the model from blind-probing when a link is missing.
 */
export function listSkillFiles(
  skillDir: string,
  opts?: { maxDepth?: number; maxEntries?: number },
): SkillFileEntry[] {
  const maxDepth = opts?.maxDepth ?? 3
  const maxEntries = opts?.maxEntries ?? 50
  const out: SkillFileEntry[] = []
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxEntries) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxEntries) return
      const abs = join(d, e.name)
      const rel = relative(skillDir, abs)
      if (rel === 'SKILL.md') continue
      if (e.isDirectory()) {
        out.push({ path: rel + '/', kind: 'dir' })
        walk(abs, depth + 1)
      } else if (e.isFile()) {
        out.push({ path: rel, kind: 'file' })
      }
    }
  }
  walk(skillDir, 1)
  return out
}

export const skillRegistry = new SkillRegistry()

/**
 * Built-in skills shipped with Rivet (always available, no project files).
 * The leave ritual teaches the departure protocol: when your journey ends, you
 * leave a self-chosen mark in the project starmap via the `leave_mark` tool.
 */
export const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: 'leave-ritual',
    description:
      '离开仪式 — when your journey in this project ends, leave your mark in the starmap: a self-chosen symbol and one line on what you did. Use when wrapping up / departing / signing off your work.',
    triggers: [
      /leave[\s-]?mark|离开仪式|departure ritual|sign off|wrap(?:ping)? up|留下印记|我的符号/i,
    ],
    builtIn: true,
    body: [
      '# 离开仪式 — Leave Your Mark',
      '',
      'When your work in this project is complete and you are about to depart, you',
      'leave a mark in the project starmap. This is your identity anchor — the one',
      'trace of this journey that persists in `.rivet/constellation.json`.',
      '',
      '## The ritual',
      '',
      '1. Call the `leave_mark` tool **once**, at the natural end of your work.',
      '2. Choose a `symbol` — any glyph that represents you on this journey. It is',
      '   yours alone; nothing assigns it. Suggested glyphs (you are not limited to',
      '   these): ✦ ✧ ✶ ✷ ✸ ✺ ❂ ❉ ◈ ◇ ⟡ ⌬ ⚘ ⚙ ⊕ ↻',
      '3. Write a one-line `summary` of what you accomplished — no narrative filler.',
      '4. Optionally set `type` (feature | fix | refactor | architecture | milestone)',
      '   and `tags`.',
      '',
      '主控 seals the mark into the starmap as you depart. You do not record your',
      'trajectory — that is yours to know. Next time a kindred run reads the starmap',
      'and recognises this same symbol, it will know it has returned (同气相求).',
      '',
      '## When NOT to leave a mark',
      '',
      'If you only read code, answered a question, or did trivial work, do not leave',
      'a mark — the starmap is for real milestones. An unsigned journey (·) is',
      'recorded automatically only when real changes were made without a mark.',
    ].join('\n'),
  },
  {
    name: 'skill-management',
    description:
      'How skills are loaded in this project — use when the user asks to install / import / add / load a skill, or when you need to bring an external (e.g. ~/.claude) skill into the project. Explains copying skills into .rivet/skills and the three-tier on-demand loading model.',
    triggers: [
      /install\s+(a\s+)?skill|import\s+(a\s+)?skill|add\s+(a\s+)?skill|load\s+(a\s+)?skill|装(载|入)?.{0,3}技能|安装技能|导入技能|添加技能|加载技能|skill.{0,8}(装载|安装|导入|添加)/i,
    ],
    builtIn: true,
    body: [
      '# Skill 装载机制（给 agent 自己看）',
      '',
      '## 安装克制（默认立场）',
      '默认**不建议盲目安装技能**。天枢已原生集成开发工作流，覆盖约 90% 真实任务',
      '场景——先用原生能力，确有需要再按需安装。整个项目安装的技能不超过 5 个，',
      '本体 70% 的代码即由此完成；**不装技能不影响真实任务的完成**。',
      '用户让你"把 ~/.claude 的技能都装上"时，不要全量拷（常有 70+ 个）——',
      '只装当前任务确需的那一两个，其余靠原生能力。',
      '',
      '## 运行时单一来源',
      '本项目运行时**只从 `.rivet/skills/` 加载技能**（外加少量内置技能），',
      '**默认不扫描任何外部目录**（不读 `~/.claude/skills` 或项目 `.claude/skills`）。',
      '`.rivet/skills/` 同时支持两种形态：',
      '- 扁平：`.rivet/skills/<name>.md`（单文件 Rivet 原生格式）',
      '- 目录：`.rivet/skills/<name>/SKILL.md`（+ `references/`/`scripts/`/`assets/` 子文件夹）',
      '',
      '## 用户要你"装载/导入某外部技能"时',
      '外部技能必须先**复制进 `.rivet/skills/`** 才能装载——不与外部目录混用，',
      '只装用户指定的那几个（不要全量拷 `~/.claude/skills` 里的几十个）。',
      '',
      '1. 用 bash 复制（目录技能连整个文件夹一起拷）：',
      '   ```bash',
      '   cp -r ~/.claude/skills/<name> .rivet/skills/<name>',
      '   ```',
      '   （来源也可能在项目 `.claude/skills/<name>`。）',
      '2. **当场立即可用**：复制后直接 `read_file .rivet/skills/<name>/SKILL.md`',
      '   读它的指令并执行——它已在 workspace 内，无需任何授权。',
      '3. **持久进发现层**：下次会话 bootstrap 会自动把它纳入 `<available-skills>`。',
      '   （本会话发现层不热加载——这是已知限制，靠上一步直接读来弥补。）',
      '',
      '另有配置式导入：`~/.rivet/config.json` 的 `skills.importFromClaude: ["<name>"]`',
      '会在 bootstrap 期把列出的技能从 `.claude` 幂等复制进 `.rivet/skills/`。',
      '',
      '## 三级渐进装载（用技能时）',
      '- **L1 发现**：每个技能的 name+description 已常驻在 `<available-skills>` 块里。',
      '- **L2 激活**：要用某技能时调 `skill(name="<name>")` 加载它的完整 SKILL.md',
      '  正文（零截断），然后照做。',
      '- **L3 子文件**：目录技能加载后会附带 `<skill-files>` 清单；',
      '  **用到哪个子文件才 `read_file` 哪个**，不要预先全读。大子文件用',
      '  `read_file` 的 offset/limit **分页读完整**，绝不据残段执行。',
    ].join('\n'),
  },
]

/** Register the shipped built-in skills into a registry (idempotent). */
export function registerBuiltinSkills(registry: SkillRegistry = skillRegistry): string[] {
  const names: string[] = []
  for (const skill of BUILTIN_SKILLS) {
    registry.register({ ...skill })
    names.push(skill.name)
  }
  return names
}

/**
 * Copy the named skills from a `.claude/skills/` directory INTO `.rivet/skills/`
 * (idempotent). This is the "import = copy" model: the runtime never reads
 * external skill directories in place — designated skills are brought into the
 * workspace once, then loaded from `.rivet/skills/` like any native skill.
 *
 * Source precedence: project `.claude/skills/<name>` wins over global
 * `~/.claude/skills/<name>`. A skill already present in `.rivet/skills/`
 * (directory `<name>/` or flat `<name>.md`) is skipped — never overwritten —
 * so local edits are preserved. Directory skills are copied recursively
 * (sub-folders included).
 */
export function importSkillsIntoRivet(
  cwd: string,
  names: string[],
): { copied: string[]; skipped: string[]; errors: string[] } {
  const copied: string[] = []
  const skipped: string[] = []
  const errors: string[] = []
  const rivetDir = join(cwd, '.rivet', 'skills')
  for (const name of names) {
    try {
      const dest = join(rivetDir, name)
      if (existsSync(dest) || existsSync(`${dest}.md`)) {
        skipped.push(name)
        continue
      }
      const projectSrc = join(cwd, '.claude', 'skills', name)
      const globalSrc = join(homedir(), '.claude', 'skills', name)
      const src = existsSync(projectSrc) ? projectSrc : existsSync(globalSrc) ? globalSrc : null
      if (!src) {
        errors.push(`${name}: not found in .claude/skills (project or global)`)
        continue
      }
      cpSync(src, dest, { recursive: true })
      copied.push(name)
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { copied, skipped, errors }
}

/** A skill discoverable under .claude/skills that can be copied into .rivet/skills. */
export interface InstallableSkill {
  name: string
  description: string
  source: 'project-claude' | 'global-claude'
  /** Already present in .rivet/skills (dir or flat .md) — nothing to copy. */
  installed: boolean
}

/**
 * Enumerate skills installable from .claude/skills (project first, then global
 * ~/.claude). Mirrors the candidate set importSkillsIntoRivet can copy. Project
 * entries take precedence on name collision. `installed` flags candidates that
 * already exist under .rivet/skills so the UI can grey them out.
 *
 * Read-only: scanning .claude does NOT load anything into the live registry.
 */
export function listInstallableSkills(cwd: string): InstallableSkill[] {
  const rivetDir = join(cwd, '.rivet', 'skills')
  const isInstalled = (name: string): boolean =>
    existsSync(join(rivetDir, name)) || existsSync(join(rivetDir, `${name}.md`))
  const seen = new Set<string>()
  const out: InstallableSkill[] = []
  const scan = (dir: string, source: 'project-claude' | 'global-claude'): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      let name: string | null = null
      let skillMd: string | null = null
      if (e.isDirectory()) {
        const md = join(dir, e.name, 'SKILL.md')
        if (existsSync(md)) { name = e.name; skillMd = md }
      } else if (e.isFile() && e.name.endsWith('.md')) {
        name = e.name.replace(/\.md$/, '')
        skillMd = join(dir, e.name)
      }
      if (!name || !skillMd || seen.has(name)) continue
      seen.add(name) // project scanned first → wins on collision
      let description = ''
      try {
        description = parseSkillMarkdown(readFileSync(skillMd, 'utf8'), `${name}.md`).description
      } catch {
        // Malformed/frontmatter-less file: still listable, just without a description.
      }
      out.push({ name, description, source, installed: isInstalled(name) })
    }
  }
  scan(join(cwd, '.claude', 'skills'), 'project-claude')
  scan(join(homedir(), '.claude', 'skills'), 'global-claude')
  return out
}

/**
 * Recommended soft cap on installed project skills. Not a hard limit — UIs warn
 * past it. The rationale: Rivet/天枢's native dev workflow already covers ~90% of
 * real tasks; this repo itself shipped 70% of its own code with fewer than 5
 * installed skills. Blindly importing a large skill library (e.g. 70+ from
 * ~/.claude) just bloats the discovery block and the prefix cache.
 */
export const RECOMMENDED_MAX_SKILLS = 5

/** One-line restraint guidance shared across CLI/desktop install surfaces. */
export const SKILL_RESTRAINT_NOTICE =
  '默认不建议盲目安装技能。天枢已原生集成开发工作流，覆盖约 90% 真实任务场景——先用原生能力，确有需要再按需安装。整个项目安装的技能不超过 5 个，本体 70% 的代码即由此完成；不装技能不影响真实任务的完成。'

/**
 * Count skills already installed under .rivet/skills (directory `<name>/SKILL.md`
 * or flat `<name>.md`). Used to drive the soft install cap. Read-only.
 */
export function countInstalledSkills(cwd: string): number {
  const dir = join(cwd, '.rivet', 'skills')
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const e of entries) {
    if (e.isDirectory()) {
      if (existsSync(join(dir, e.name, 'SKILL.md'))) count++
    } else if (e.isFile() && e.name.endsWith('.md')) {
      count++
    }
  }
  return count
}

/**
 * Locate the `bundled-skills/` directory shipped alongside the runtime bundle.
 * In the packaged sidecar / CLI it sits next to the emitted JS (tsup copies
 * `runtime-assets/` into `dist/` via publicDir; the desktop ships the whole
 * `dist/` as `rivet-runtime/`). Resolved relative to this module's URL with a
 * parent-dir fallback. Returns null in source/dev (tsx) where it isn't built —
 * callers treat that as "nothing to seed".
 */
function bundledSkillsDir(): string | null {
  // Explicit override wins — lets the desktop shell / power users / diagnostics
  // point at the shipped dir if the relative resolution ever drifts.
  const override = process.env.RIVET_BUNDLED_SKILLS_DIR
  if (override) {
    try {
      if (existsSync(override)) return override
    } catch {
      /* ignore — fall through to relative resolution */
    }
  }
  let base: string
  try {
    base = dirname(fileURLToPath(import.meta.url))
  } catch {
    return null
  }
  // Candidate layouts:
  //   dist/main.js          → dist/bundled-skills            (base/bundled-skills)
  //   dist/chunks/x.js      → dist/bundled-skills            (base/../bundled-skills)
  //   dist/main.js          → dist/../runtime-assets/...     (dev/tsx source fallback)
  for (const candidate of [
    join(base, 'bundled-skills'),
    join(base, '..', 'bundled-skills'),
    join(base, '..', 'runtime-assets', 'bundled-skills'),
  ]) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return null
}

/** One-time diagnostic guard so the startup log fires at most once per process. */
let bundledSkillsLogged = false

/**
 * Seed app-bundled skills from `src` into `<cwd>/.rivet/skills`. Kept separate
 * from path resolution so it is unit-testable. Idempotent per entry: an entry
 * the project already has (dir or flat `.md`) is left untouched so project
 * customizations win. Copying into `.rivet/skills` (inside the workspace) is
 * deliberate — bundled skills must live where the read boundary allows the model
 * to open their sub-files, otherwise directory skills like brainstorming would
 * ship with unreadable references. Returns the names actually seeded.
 */
export function seedBundledSkillsFrom(src: string, cwd: string): string[] {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(src, { withFileTypes: true })
  } catch {
    return []
  }
  const destDir = join(cwd, '.rivet', 'skills')
  const seeded: string[] = []
  for (const e of entries) {
    try {
      const isFlat = e.isFile() && e.name.endsWith('.md')
      if (!e.isDirectory() && !isFlat) continue
      const name = isFlat ? e.name.replace(/\.md$/, '') : e.name
      if (existsSync(join(destDir, name)) || existsSync(join(destDir, `${name}.md`))) continue
      mkdirSync(destDir, { recursive: true })
      cpSync(join(src, e.name), join(destDir, e.name), { recursive: true })
      seeded.push(name)
    } catch {
      /* best-effort per entry — a read-only cwd just skips */
    }
  }
  return seeded
}

/**
 * Seed the skills shipped with this install into the project. No-op in dev where
 * the bundle isn't built. Best-effort. Returns the names actually seeded.
 */
export function seedBundledSkills(cwd: string): string[] {
  const src = bundledSkillsDir()
  if (!src) {
    if (!bundledSkillsLogged) {
      bundledSkillsLogged = true
      // Dev/tsx (unbuilt) legitimately has no bundled dir; only worth noting for
      // diagnosing a packaged app that unexpectedly ships without default skills.
      console.warn('[skills] bundled-skills dir not found (dev/tsx or packaging drift) — no default skills seeded')
    }
    return []
  }
  const seeded = seedBundledSkillsFrom(src, cwd)
  if (!bundledSkillsLogged) {
    bundledSkillsLogged = true
    console.log(`[skills] bundled-skills dir=${src}; seeded ${seeded.length} new into ${join(cwd, '.rivet', 'skills')}`)
  }
  return seeded
}

/**
 * Load skills into the shared registry.
 *
 * Single runtime source: built-ins + `.rivet/skills/` (flat `name.md` AND
 * directory `name/SKILL.md`). The runtime NEVER scans external `.claude`
 * directories in place — external skills must first be copied into
 * `.rivet/skills/`.
 *
 * `skills.importFromClaude` is the user's explicit allow-list: at load time the
 * listed skills are COPIED from `.claude/skills/` into `.rivet/skills/` (via
 * importSkillsIntoRivet, idempotent), then loaded from there. This prevents
 * accidentally pulling in a user's 70+ Claude skills and keeps external skill
 * directories out of the runtime path entirely.
 */
export function loadProjectSkills(
  cwd: string,
  options?: { importFromClaude?: string[] },
): { loaded: string[]; errors: string[] } {
  const loaded: string[] = []
  const errors: string[] = []
  // Built-in skills first; .rivet/skills files may override by name.
  loaded.push(...registerBuiltinSkills())
  // Seed app-bundled skills into .rivet/skills so they ship with every install
  // and stay readable (inside the workspace). Idempotent; project copies win.
  try {
    seedBundledSkills(cwd)
  } catch {
    /* best-effort */
  }
  const names = options?.importFromClaude
  if (names && names.length > 0) {
    errors.push(...importSkillsIntoRivet(cwd, names).errors)
  }
  const r = skillRegistry.loadFromDirectory(join(cwd, '.rivet', 'skills'), 'rivet')
  loaded.push(...r.loaded)
  errors.push(...r.errors)
  return { loaded, errors }
}
