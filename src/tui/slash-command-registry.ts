/**
 * Unified slash command registry — metadata-driven command framework.
 *
 * Replaces the scattered special-case handling in app.ts / SlashRouter with
 * declarative command descriptors:
 *   { name, immediate, handler, overlay?, needsAgent? }
 *
 * Benefits:
 * - app.ts no longer hard-codes /clear, /starmap, /chronicle, /exit.
 * - External SlashRouter can register commands instead of returning a blanket boolean.
 * - Commands declare whether they need an active agent / overlay, enabling uniform
 *   validation and queue routing.
 */

import type { TuiApp } from './engine/app.js'

export interface SlashCommandContext {
  /** The TuiApp instance executing the command */
  app: TuiApp
  /** Full original input (including leading slash) */
  input: string
  /** Normalized input with leading/trailing whitespace trimmed */
  trimmed: string
}

export interface SlashCommand {
  /** Command name with leading slash, e.g. '/help' */
  name: string
  /** Short description for command palette / help listings */
  description?: string
  /**
   * If true, the command is executed locally and is never sent to the agent.
   * If false (the default), the handler decides whether to swallow the input
   * or let it fall through to the agent pipeline.
   */
  immediate?: boolean
  /**
   * If true, the command requires an active agent run. When inactive, the
   * command is rejected with a friendly message.
   */
  needsAgent?: boolean
  /**
   * If set, the command opens the named overlay. The registry validates that
   * the overlay exists before executing.
   */
  overlay?: string
  /**
   * Command handler. Return true to indicate the command was consumed.
   * Return false to let the input fall through to the agent as raw text.
   */
  handler: (ctx: SlashCommandContext) => boolean | Promise<boolean>
}

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>()

  /** Register a command. Overwrites an existing command with the same name. */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  /** Register multiple commands at once. */
  registerMany(commands: readonly SlashCommand[]): void {
    for (const cmd of commands) this.register(cmd)
  }

  /** Unregister a command by name. */
  unregister(name: string): void {
    this.commands.delete(name)
  }

  /** Look up an exact command. */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name)
  }

  /** Check if a command is registered. */
  has(name: string): boolean {
    return this.commands.has(name)
  }

  /** All registered commands, sorted by name. */
  list(): SlashCommand[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Find the best matching command for an input string.
   * Prefers exact match; falls back to the first command whose name is a prefix.
   */
  match(input: string): SlashCommand | undefined {
    const trimmed = input.trim()
    const exact = this.commands.get(trimmed)
    if (exact) return exact
    for (const [name, cmd] of this.commands) {
      if (trimmed.startsWith(name + ' ')) return cmd
    }
    return undefined
  }

  /**
   * Execute the matching command if any.
   * Returns { handled: true } when a command consumed the input.
   * Returns { handled: false } when no command matched.
   */
  async execute(ctx: SlashCommandContext): Promise<{ handled: boolean }> {
    const cmd = this.match(ctx.trimmed)
    if (!cmd) return { handled: false }

    if (cmd.needsAgent && !ctx.app.busy) {
      ctx.app.commitStatic(`[${cmd.name}] requires an active agent run.`)
      return { handled: true }
    }

    if (cmd.overlay) {
      if (ctx.app.activateOverlay(cmd.overlay)) {
        return { handled: true }
      }
      // Overlay activation failed — let the handler decide.
    }

    const handled = await cmd.handler(ctx)
    return { handled }
  }
}
