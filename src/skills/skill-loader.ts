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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SkillSource = 'rivet' | 'project-claude' | 'global-claude'

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
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

function parseFrontmatter(raw: string): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {}
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const val = m[2]!.trim()
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

  /** Load flat `.rivet/skills/*.md` files (Rivet-native format). */
  loadFromDirectory(dir: string, source: SkillSource = 'rivet'): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    if (!existsSync(dir)) return { loaded, errors }

    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      try {
        const skillFile = join(dir, file)
        const content = readFileSync(skillFile, 'utf-8')
        const def = parseSkillMarkdown(content, file)
        def.source = source
        def.bodyPath = skillFile
        this.skills.set(def.name, def)
        loaded.push(def.name)
      } catch (e) {
        errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
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
    opts?: { maxChars?: number; maxDescChars?: number },
  ): string | null {
    const all = this.list()
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
    for (const skill of ordered) {
      const desc = (skill.description || '').replace(/\s+/g, ' ').trim().slice(0, maxDescChars)
      const rel = isRelevant(skill) ? ' relevant="true"' : ''
      const line = `<skill name="${skill.name}"${rel}>${desc}</skill>`
      if (line.length > budget) continue // try smaller entries instead of cutting off the rest
      lines.push(line)
      budget -= line.length
    }
    if (lines.length === 0) return null

    return [
      '<available-skills note="Call the skill tool with a name to load its full instructions on demand.">',
      ...lines,
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
}

export const skillRegistry = new SkillRegistry()

/**
 * Load skills into the shared registry.
 *
 * Default: only scans .rivet/skills/ (Rivet-native format).
 *
 * Claude skills (.claude/skills/<name>/SKILL.md) are opt-in via the
 * skills.importFromClaude config field — only listed skill names are
 * imported, preventing accidental loading of 70+ Claude skills.
 *
 * Precedence (later overrides earlier on name collision):
 * global Claude -> project Claude -> project Rivet (native wins).
 */
export function loadProjectSkills(
  cwd: string,
  options?: { importFromClaude?: string[] },
): { loaded: string[]; errors: string[] } {
  const loaded: string[] = []
  const errors: string[] = []
  const merge = (r: { loaded: string[]; errors: string[] }): void => {
    loaded.push(...r.loaded)
    errors.push(...r.errors)
  }
  const claudeFilter = options?.importFromClaude
  if (claudeFilter && claudeFilter.length > 0) {
    const filterSet = new Set(claudeFilter)
    merge(skillRegistry.loadFromClaudeDirectory(join(homedir(), '.claude', 'skills'), 'global-claude', filterSet))
    merge(skillRegistry.loadFromClaudeDirectory(join(cwd, '.claude', 'skills'), 'project-claude', filterSet))
  }
  merge(skillRegistry.loadFromDirectory(join(cwd, '.rivet', 'skills'), 'rivet'))
  return { loaded, errors }
}
