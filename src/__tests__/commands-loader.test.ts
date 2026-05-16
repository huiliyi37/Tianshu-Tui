import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadCustomCommands, resolveCustomCommand } from '../commands/loader.js'
import { resolveAppPromptInput } from '../tui/slash-commands.js'

function makeProject(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-commands-'))
  mkdirSync(join(cwd, '.rivet', 'commands'), { recursive: true })
  return cwd
}

describe('custom command loader', () => {
  it('loads markdown commands from .rivet/commands', () => {
    const cwd = makeProject()
    writeFileSync(join(cwd, '.rivet', 'commands', 'review.md'), `Review this:
$ARGUMENTS`)

    const commands = loadCustomCommands(cwd)

    assert.equal(commands.length, 1)
    assert.equal(commands[0]?.name, 'review')
    assert.equal(commands[0]?.body, `Review this:
$ARGUMENTS`)
  })

  it('ignores non-markdown and unsafe command names', () => {
    const cwd = makeProject()
    writeFileSync(join(cwd, '.rivet', 'commands', 'safe-command.md'), 'safe')
    writeFileSync(join(cwd, '.rivet', 'commands', 'notes.txt'), 'ignore')
    writeFileSync(join(cwd, '.rivet', 'commands', 'bad name.md'), 'ignore')
    mkdirSync(join(cwd, '.rivet', 'commands', 'nested'))
    writeFileSync(join(cwd, '.rivet', 'commands', 'nested', 'deep.md'), 'ignore')

    const commands = loadCustomCommands(cwd)

    assert.deepEqual(commands.map(c => c.name), ['safe-command'])
  })

  it('resolves command arguments into the prompt body', () => {
    const cwd = makeProject()
    writeFileSync(join(cwd, '.rivet', 'commands', 'fix.md'), `Fix this bug:
$ARGUMENTS`)

    const resolved = resolveCustomCommand(cwd, '/fix auth race')

    assert.equal(resolved, `Fix this bug:
auth race`)
  })

  it('returns null for unknown custom commands', () => {
    const cwd = makeProject()

    assert.equal(resolveCustomCommand(cwd, '/missing nope'), null)
  })

  it('resolves unknown app slash commands before agent execution', () => {
    const cwd = makeProject()
    writeFileSync(join(cwd, '.rivet', 'commands', 'review.md'), `Review this:
$ARGUMENTS`)

    const resolved = resolveAppPromptInput('/review src/main.tsx', cwd)

    assert.equal(resolved, `Review this:
src/main.tsx`)
  })

  it('keeps normal app input unchanged', () => {
    const cwd = makeProject()

    assert.equal(resolveAppPromptInput('plain prompt', cwd), 'plain prompt')
  })
})
