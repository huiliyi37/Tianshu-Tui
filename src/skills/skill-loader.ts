/**
 * Skill loader — .rivet/skills/*.md with YAML frontmatter.
 *
 * Skills are reusable workflow templates injected into the dynamic appendix
 * when their trigger patterns match the current turn context.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SkillDefinition {
  name: string
  description: string
  /** Regex patterns — any match triggers the skill. */
  triggers: RegExp[]
  body: string
  tierLock?: 'cheap' | 'balanced' | 'strong'
  builtIn?: boolean
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
  const name = typeof fm.name === 'string' ? fm.name : fileName.replace(/\.md$/, '')

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

  loadFromDirectory(dir: string): { loaded: string[]; errors: string[] } {
    const loaded: string[] = []
    const errors: string[] = []
    if (!existsSync(dir)) return { loaded, errors }

    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const def = parseSkillMarkdown(content, file)
        this.skills.set(def.name, def)
        loaded.push(def.name)
      } catch (e) {
        errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
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

  /** Find skills whose trigger patterns match the given text. */
  match(text: string): SkillDefinition[] {
    return this.list().filter(skill =>
      skill.triggers.length === 0 || skill.triggers.some(re => re.test(text)),
    )
  }

  renderMatchedBlock(text: string, maxChars = 4000): string | null {
    const matched = this.match(text)
    if (matched.length === 0) return null

    const parts: string[] = ['<skills>']
    let budget = maxChars
    for (const skill of matched.slice(0, 3)) {
      const block = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
      if (block.length > budget) break
      parts.push(block)
      budget -= block.length
    }
    parts.push('</skills>')
    return parts.join('\n')
  }
}

export const skillRegistry = new SkillRegistry()

/** Load skills from project .rivet/skills/ at startup. */
export function loadProjectSkills(cwd: string): { loaded: string[]; errors: string[] } {
  return skillRegistry.loadFromDirectory(join(cwd, '.rivet', 'skills'))
}
