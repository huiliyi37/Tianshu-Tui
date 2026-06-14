import type { Tool } from './types.js'
import { skillRegistry } from '../skills/skill-loader.js'

/**
 * Tier-2 skill activation. The discovery block (volatile appendix) lists every
 * available skill's name + description; this tool loads the FULL body of one of
 * them on demand. The body is returned as an ordinary tool result — append-only
 * to history — so the whole session can see it. There is NO truncation here;
 * oversized bodies are handled by the tool pipeline's existing artifact
 * intercept, the same as any other large tool output.
 *
 * The static definition deliberately does NOT embed any concrete skill name, so
 * the tool description stays byte-stable across sessions and the prefix cache is
 * preserved. The set of loadable skills lives only in the volatile discovery
 * block.
 */
export const SKILL_TOOL: Tool = {
  definition: {
    name: 'skill',
    description: `Load the full instructions for a skill by name, then follow them.

Skills are reusable workflow playbooks. The available-skills block lists each skill's name and a short description. When a skill's description matches what you are doing, call this tool with its exact name to load its complete instructions on demand, then carry them out.

Example: skill(name="brainstorming")`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact name of the skill to load (see the available-skills block).' },
      },
      required: ['name'],
    },
  },

  async execute(params) {
    const raw = params.input.name
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: 'Error: name is required', isError: true }
    }
    const name = raw.trim()

    const skill = skillRegistry.get(name)
    if (!skill) {
      const available = skillRegistry.list().map(s => s.name).sort()
      const list = available.length > 0 ? available.join(', ') : '(none loaded)'
      return {
        content: `Skill not found: "${name}".\nAvailable skills: ${list}`,
        isError: true,
      }
    }

    return {
      content: `<skill name="${skill.name}">\n${skill.body}\n</skill>`,
      uiContent: `Loaded skill: ${skill.name}`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
