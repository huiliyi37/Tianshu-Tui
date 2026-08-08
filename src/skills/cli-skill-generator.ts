/**
 * CLI Skill Generator — turn a CLI's `--help` output into a
 * `.rivet/skills/cli-<name>.md` skill artifact.
 *
 * Runtime flow:
 *   1. run `<cli> --help` (stdout+stderr, bounded by a timeout)
 *   2. parse the help text into a command list — recognizing the three common
 *      help dialects: commander (Node), click (Python), argparse (Python)
 *   3. for each detected subcommand (one level), run `<cli> <sub> --help` and
 *      parse it into its own command group
 *   4. render markdown (YAML frontmatter + command-group tables + a
 *      "For AI Agents" discipline section, structurally aligned with the
 *      CLI-Anything skill_generator.py output)
 *   5. write `.rivet/skills/cli-<name>.md`
 *
 * Graceful degradation: if the help text cannot be parsed (unknown dialect,
 * no command listing), the raw help text is embedded in the body instead of
 * hard-failing. The generated flat file is picked up by the existing skill
 * loader on the next bootstrap (Tier-1 discovery + Tier-2 on-demand load) —
 * zero tool-schema change, zero prefix-cache impact.
 *
 * Frontmatter uses UNQUOTED values on purpose: the loader's parseFrontmatter
 * does not strip surrounding quotes from non-array values, so `name: "x"`
 * would land the literal quotes into the skill name and break discovery. This
 * matches every existing `.rivet/skills/*.md` in the repo.
 */

import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CliCommand {
  name: string
  description: string
}

export interface CliCommandGroup {
  /** group name: the binary for the root group, a subcommand for sub-groups */
  name: string
  description: string
  commands: CliCommand[]
}

export type HelpDialect = 'commander' | 'click' | 'argparse' | 'unknown'

export interface CliHelpParse {
  dialect: HelpDialect
  /** subcommands extracted from the root help (empty when degraded) */
  commands: CliCommand[]
  /** the raw help text, always preserved */
  rawText: string
  /** true when no dialect matched / no command list could be extracted */
  degraded: boolean
}

export interface CliSkillResult {
  /** absolute path of the written skill file */
  filePath: string
  skillName: string
  dialect: HelpDialect
  groups: CliCommandGroup[]
  degraded: boolean
  /** subcommands whose `--help` runs failed or produced unparseable output */
  skippedSubcommands: string[]
}

export interface CliSkillOptions {
  /** binary to introspect (resolved via PATH unless it contains a slash) */
  binary: string
  /** working directory for the help runs (default process.cwd()) */
  cwd?: string
  /** per-run timeout in ms (default 10_000) */
  timeoutMs?: number
  /** output directory (default `.rivet/skills` under cwd) */
  outDir?: string
  /** collect subcommand help one level deep (default true) */
  subcommands?: boolean
  /** cap on how many subcommands to expand (default 16) */
  maxSubcommands?: number
}

interface RunOutcome {
  ok: boolean
  notFound: boolean
  stdout: string
  stderr: string
}

function runProcess(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, notFound: false, stdout, stderr })
        const e = err as NodeJS.ErrnoException & {
          code?: string | number
        }
        if (e.code === 'ENOENT') {
          return resolve({ ok: false, notFound: true, stdout: '', stderr: '' })
        }
        // non-zero exit / timeout / killed — keep whatever was emitted
        resolve({
          ok: false,
          notFound: false,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        })
      },
    )
  })
}

/** Merge stdout+stderr into one help text (some CLIs print help to stderr). */
function joinOut(r: RunOutcome): string {
  return [r.stdout, r.stderr].filter(Boolean).join('\n')
}

/** Extract the body of a `header:` section (entries until the next header). */
function extractSection(text: string, headerRe: RegExp): string {
  const lines = text.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i]!.trimEnd())) {
      start = i
      break
    }
  }
  if (start === -1) return ''
  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') {
      if (out.length > 0) break
      continue
    }
    // a new section header at column 0 ends this section
    if (!/^\s/.test(line) && /^[A-Za-z][A-Za-z0-9 ()-]*:$/.test(line.trim())) break
    out.push(line)
  }
  return out.join('\n')
}

/** Split one `name [options]  description` line into a command entry. */
function splitCommandEntry(rawLine: string): CliCommand | null {
  const line = rawLine.trim()
  if (!line || line.startsWith('-') || line.startsWith('*')) return null
  // strip commander positional markers: "init [options]" / "help [command]"
  const cleaned = line.replace(/(\s*)\[(?:options|command|arguments?)\]/g, ' ').trimEnd()
  const m = cleaned.match(/^(\S[\S ]*?)\s{2,}(\S[\S ]*)$/)
  if (m) return { name: m[1]!.trim(), description: m[2]!.trim() }
  // name-only: a short token chain (≤3 words, no punctuation beyond -/_)
  if (/^[A-Za-z0-9][\w-]*(?: [A-Za-z0-9][\w-]*){0,2}$/.test(cleaned)) {
    return { name: cleaned, description: '' }
  }
  return null
}

/**
 * Parse a command-listing section. Entries share a base indentation; deeper
 * indented lines are treated as description continuations (click wraps long
 * descriptions to the next line).
 */
function parseCommandList(sectionText: string, opts: { skipBraced?: boolean } = {}): CliCommand[] {
  const entries: CliCommand[] = []
  let baseIndent: number | undefined
  for (const rawLine of sectionText.split('\n')) {
    const text = rawLine.trim()
    if (!text) continue
    if (opts.skipBraced && text.startsWith('{')) continue
    const indent = rawLine.match(/^ */)![0]!.length
    if (baseIndent === undefined) baseIndent = indent
    if (indent > baseIndent) {
      // continuation of the previous entry's description
      const last = entries[entries.length - 1]
      if (last) last.description = last.description ? `${last.description} ${text}` : text
      continue
    }
    const parsed = splitCommandEntry(rawLine)
    if (parsed) entries.push(parsed)
  }
  return entries
}

/**
 * Argparse lists subcommands either as `{a,b,c}` in the usage line and/or as
 * an indented sub-parser block under "positional arguments:". Real subcommand
 * entries appear AFTER the braced anchor line; a leading metavar label line
 * (e.g. "command") is not a subcommand and is dropped.
 */
function parseArgparseCommands(
  positionalSection: string,
  usageSet: string | undefined,
): CliCommand[] {
  const lines = positionalSection.split('\n')
  const braceIdx = lines.findIndex((l) => l.includes('{'))
  const body = braceIdx === -1 ? positionalSection : lines.slice(braceIdx + 1).join('\n')
  const parsed = parseCommandList(body, { skipBraced: true })
  if (parsed.length > 0) return parsed
  // no descriptions available — synthesize bare names from the usage {a,b,c}
  if (usageSet) {
    return usageSet
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, description: '' }))
  }
  return []
}

/**
 * Parse a CLI `--help` text into the root subcommand list.
 *
 * Dialect detection is signal-based: argparse advertises `{a,b,c}` in the
 * usage line / positional section; commander's `-h, --help` line says
 * "display help for command"; click's says "Show this message and exit." When
 * only a bare `Commands:` section exists, the entry style (`[options]` markers
 * vs. plain names) breaks the tie.
 */
export function parseHelpText(text: string): CliHelpParse {
  const rawText = text.replace(/\r\n?/g, '\n').trim()
  if (!rawText) return { dialect: 'unknown', commands: [], rawText, degraded: true }

  const usageLine = rawText.match(/^[Uu]sage:\s*(.+)$/m)?.[1]?.trim() ?? ''
  const commandsSection = extractSection(rawText, /^Commands:$/)
  const positionalSection = extractSection(rawText, /^positional arguments:$/)
  const optionsSection = extractSection(rawText, /^(?:Options|options):$/)

  const usageSet = usageLine.match(/\{([^}]+)\}/)?.[1]
  const bracedInPositional = /{/.test(positionalSection)

  let dialect: HelpDialect = 'unknown'
  if (usageSet || bracedInPositional) {
    dialect = 'argparse'
  } else if (/display help for command/.test(optionsSection)) {
    dialect = 'commander'
  } else if (/Show this message and exit/.test(optionsSection)) {
    dialect = 'click'
  } else if (commandsSection) {
    dialect = /\[(?:options|command)\]/.test(commandsSection) ? 'commander' : 'click'
  }

  let commands: CliCommand[] = []
  if (dialect === 'argparse') {
    commands = parseArgparseCommands(positionalSection, usageSet)
  } else if (dialect === 'commander' || dialect === 'click') {
    commands = parseCommandList(commandsSection)
  }

  // degraded: 方言未识别，或方言命中但没有提取到任何命令列表（叶子 CLI）
  // —— 两者都意味着产物无法提供命令参考，正文应降级为原始帮助文本
  return { dialect, commands, rawText, degraded: dialect === 'unknown' || commands.length === 0 }
}

/** Lowercase alnum+`-` slug from a binary path/name. */
function sanitizeName(binary: string): string {
  const slug = basename(binary)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'cli'
}

export interface SkillMarkdownInput {
  binary: string
  skillName: string
  dialect: HelpDialect
  groups: CliCommandGroup[]
  degraded: boolean
  rawText?: string
  skippedSubcommands?: string[]
  generatedAt?: string
}

/** Escape a value for a double-quoted YAML scalar line. */
function yamlScalar(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Render the skill markdown. Structure follows skill_generator.py's
 * generate_skill_md_simple: frontmatter → # title → usage → command-group
 * tables → "For AI Agents" discipline section. On degradation, the raw help
 * text is embedded as the body instead of a hard failure.
 */
export function generateSkillMarkdown(input: SkillMarkdownInput): string {
  const { binary, skillName, dialect, groups, degraded, skippedSubcommands } = input
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const groupCount = groups.length
  const description =
    `CLI 技能：${binary} 命令与子命令参考（自动生成自 ${binary} --help，方言 ${dialect}）。` +
    (degraded
      ? ' 未能解析命令列表，正文为原始帮助文本。'
      : ` 含 ${groupCount} 个命令组（含子命令一层）。`)

  const lines: string[] = [
    '---',
    `name: ${yamlScalar(skillName)}`,
    `description: ${yamlScalar(description)}`,
    `triggers: ["${basename(binary)}", "${skillName}"]`,
    '---',
    '',
    `# ${skillName}`,
    '',
    `> 自动生成：\`${binary} --help\` 输出解析（方言：\`${dialect}\`，` +
      (degraded ? '命令列表解析失败，已降级为原始文本' : `含 ${groupCount} 个命令组`) +
      `），生成于 ${generatedAt}。`,
    '',
    '## Usage',
    '',
    '```bash',
    `${binary} --help`,
    `${binary} <command> --help   # 子命令一层`,
    '```',
    '',
  ]

  if (groups.length > 0) {
    lines.push('## Command Groups', '')
    for (const group of groups) {
      lines.push(`### ${group.name}`, '')
      if (group.commands.length === 0) {
        lines.push('_无命令条目_', '')
        continue
      }
      lines.push('| Command | Description |', '|---------|-------------|')
      for (const cmd of group.commands) {
        const desc = cmd.description.replace(/\|/g, '\\|')
        lines.push(`| \`${cmd.name}\` | ${desc} |`)
      }
      lines.push('')
    }
  }

  if (skippedSubcommands && skippedSubcommands.length > 0) {
    lines.push('## 未展开的子命令', '')
    lines.push(`以下子命令的 \`--help\` 未能解析，未生成命令表：${skippedSubcommands.join(', ')}`, '', '')
  }

  lines.push('## For AI Agents', '')
  lines.push(`When using \`${binary}\` programmatically:`, '')
  lines.push('1. **Help output is the source of truth** — this skill is a snapshot of `--help`; re-run `--help` before guessing flags.')
  lines.push('2. **Check exit codes** — 0 for success, non-zero for errors.')
  lines.push('3. **Parse stderr** for error messages on failure.')
  lines.push('4. **Use absolute paths** for file-related arguments.')
  lines.push('5. **Prefer machine-readable output** when the CLI offers it (e.g. `--json`, `--format`, `-o`, `--output`).')

  if (degraded) {
    lines.push('', '## 原始帮助文本（解析失败降级）', '', '```text', input.rawText ?? '', '```')
  }

  return lines.join('\n') + '\n'
}

/**
 * Orchestrate the whole flow: run `<binary> --help`, parse the root command
 * list, expand each subcommand (one level) into its own command group, then
 * write `.rivet/skills/cli-<name>.md`. Root help parse failure degrades to a
 * raw-text body; subcommand expansion failures are skipped, never fatal.
 */
export async function generateCliSkill(opts: CliSkillOptions): Promise<CliSkillResult> {
  const { binary } = opts
  const cwd = opts.cwd ?? process.cwd()
  const timeoutMs = opts.timeoutMs ?? 10_000
  const outDir = opts.outDir ?? join(cwd, '.rivet', 'skills')
  const doSubs = opts.subcommands ?? true
  const maxSubs = opts.maxSubcommands ?? 16

  const root = await runProcess(binary, ['--help'], { cwd, timeoutMs })
  if (root.notFound) throw new Error(`cli-skill-generator: binary not found: ${binary}`)
  const rootText = joinOut(root)
  if (!rootText.trim()) throw new Error(`cli-skill-generator: "${binary} --help" produced no output`)

  const rootParse = parseHelpText(rootText)
  const groups: CliCommandGroup[] = []
  if (rootParse.commands.length > 0) {
    groups.push({ name: binary, description: '', commands: rootParse.commands })
  }
  const skippedSubcommands: string[] = []
  if (!rootParse.degraded && doSubs) {
    for (const cmd of rootParse.commands.slice(0, maxSubs)) {
      const argv = [...cmd.name.split(/\s+/), '--help']
      const r = await runProcess(binary, argv, { cwd, timeoutMs })
      const subText = joinOut(r)
      if (r.notFound || !r.ok || !subText.trim()) {
        skippedSubcommands.push(cmd.name)
        continue
      }
      const subParse = parseHelpText(subText)
      if (subParse.degraded || subParse.commands.length === 0) {
        skippedSubcommands.push(cmd.name)
        continue
      }
      groups.push({ name: cmd.name, description: '', commands: subParse.commands })
    }
  }

  const skillName = `cli-${sanitizeName(binary)}`
  const md = generateSkillMarkdown({
    binary,
    skillName,
    dialect: rootParse.dialect,
    groups,
    degraded: rootParse.degraded,
    rawText: rootText,
    skippedSubcommands,
  })

  mkdirSync(outDir, { recursive: true })
  const filePath = join(outDir, `${skillName}.md`)
  writeFileSync(filePath, md, 'utf-8')

  return {
    filePath,
    skillName,
    dialect: rootParse.dialect,
    groups,
    degraded: rootParse.degraded,
    skippedSubcommands,
  }
}

// Direct invocation: `tsx src/skills/cli-skill-generator.ts <binary> [--out <dir>]`
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1] : undefined
  const binary = args.find((a) => a !== '--out' && a !== (outDir ?? ''))
  if (!binary) {
    console.error('usage: cli-skill-generator.ts <binary> [--out <dir>]')
    process.exit(1)
  }
  generateCliSkill({ binary, outDir })
    .then((res) => {
      console.log(`Generated: ${res.filePath} (dialect=${res.dialect}, degraded=${res.degraded}, groups=${res.groups.length})`)
    })
    .catch((e) => {
      console.error(`cli-skill-generator: ${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    })
}
