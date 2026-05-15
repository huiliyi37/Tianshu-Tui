import { BASH_TOOL } from './bash.js'
import { DIFF_TOOL } from './diff.js'
import { EDIT_FILE_TOOL } from './edit.js'
import { GIT_TOOL } from './git.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { READ_FILE_TOOL } from './read-file.js'
import { RUN_TESTS_TOOL } from './run-tests.js'
import { TODO_TOOL } from './todo.js'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'
import { WEB_FETCH_TOOL } from './web-fetch.js'
import { WRITE_FILE_TOOL } from './write-file.js'

export function createDefaultToolRegistry(extraTools: Tool[] = []): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(READ_FILE_TOOL)
  registry.register(WRITE_FILE_TOOL)
  registry.register(BASH_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(GREP_TOOL)
  registry.register(GLOB_TOOL)
  registry.register(DIFF_TOOL)
  registry.register(RUN_TESTS_TOOL)
  registry.register(GIT_TOOL)
  registry.register(TODO_TOOL)
  registry.register(WEB_FETCH_TOOL)
  for (const tool of extraTools) registry.register(tool)
  return registry
}
