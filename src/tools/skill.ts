import type { Tool } from './types.js'
import { skillRegistry, listSkillFiles } from '../skills/skill-loader.js'

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
    description: `按名称加载某个 skill 的完整指令，然后照做。

skill 是可复用的工作流 playbook。available-skills 区块列出了每个 skill 的名称和简述。当某个 skill 的简述与你正在做的事匹配时，用它的确切名称调用本工具，按需加载完整指令，然后执行。

执行完已加载的 skill 后，调用 skill(name="<name>", complete=true) 释放它。这样工作流结束后，该 skill 的指令不会再被重新注入上下文。

示例：skill(name="brainstorming")`,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要加载或标记完成的 skill 的确切名称（见 available-skills 区块）。' },
        complete: { type: 'boolean', description: '为 true 时，将该 skill 标记为已完成而不是加载它。该 skill 的指令将不再被重新注入上下文。' },
      },
      required: ['name'],
    },
  },

  async execute(params) {
    const raw = params.input.name
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '错误：name 必填', isError: true }
    }
    const name = raw.trim()

    const skill = skillRegistry.get(name) ?? skillRegistry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
    if (!skill) {
      const available = skillRegistry.list().map(s => s.name).sort()
      const list = available.length > 0 ? available.join(', ') : '（未加载任何 skill）'
      return {
        content: `未找到 skill：「${name}」。\n可用 skill：${list}`,
        isError: true,
      }
    }

    if (params.input.complete === true) {
      params.onSkillCompleted?.(skill.name)
      return { content: `Skill「${skill.name}」已标记为完成。`, uiContent: `已完成 skill：${skill.name}` }
    }

    params.onSkillInvoked?.(skill.name)

    const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`
    // Flat (no skillDir) skills have no sub-files — return body as-is.
    if (!skill.skillDir) {
      return { content: body, uiContent: `已加载 skill：${skill.name}` }
    }
    const files = listSkillFiles(skill.skillDir)
    if (files.length === 0) {
      return { content: body, uiContent: `已加载 skill：${skill.name}` }
    }
    // Directory skill: append the sub-file tree so the model knows what it can
    // read on demand (Tier-3). The body itself is never truncated.
    const tree = files.map(f => `  ${f.path}`).join('\n')
    const filesBlock = [
      `<skill-files dir="${skill.skillDir}" note="按上方指令需要时再用 read_file/grep/glob 按需读取。不要预先全部加载。大文件先用 read_file(focus=...) 提取关键片段，缺口再用 offset/limit 精读；切勿把摘要当成完整文件。">`,
      tree,
      '</skill-files>',
    ].join('\n')
    return {
      content: `${body}\n${filesBlock}`,
      uiContent: `已加载 skill：${skill.name}（+${files.length} 个文件）`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
