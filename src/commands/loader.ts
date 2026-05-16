import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface CustomCommand {
  name: string
  body: string
}

const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function loadCustomCommands(cwd: string): CustomCommand[] {
  const dir = join(cwd, '.rivet', 'commands')
  if (!existsSync(dir)) return []

  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => ({
      name: basename(entry.name, '.md'),
      fileName: entry.name,
    }))
    .filter(command => COMMAND_NAME_RE.test(command.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(command => ({
      name: command.name,
      body: readFileSync(join(dir, command.fileName), 'utf8'),
    }))
}

export function resolveCustomCommand(cwd: string, input: string): string | null {
  const match = input.trim().match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null

  const [, name, args = ''] = match
  const command = loadCustomCommands(cwd).find(candidate => candidate.name === name)
  if (!command) return null

  return command.body.replaceAll('$ARGUMENTS', args)
}
