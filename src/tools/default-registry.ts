import { APPLY_PATCH_TOOL } from './apply-patch.js'
import { IMPORT_RESOURCE_TOOL } from './import-resource.js'
import { FILE_INFO_TOOL } from './file-info.js'
import { BASH_TOOL } from './bash.js'
import { DIFF_TOOL } from './diff.js'
import { EDIT_FILE_TOOL } from './edit.js'
import { HASH_EDIT_TOOL } from './hash-edit.js'
import { GIT_TOOL } from './git.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { INSPECT_PROJECT_TOOL } from './inspect-project.js'
import { PLAN_CLOSE_TOOL } from './plan-close.js'
import { PLAN_SUBMIT_TOOL } from './plan-submit.js'
import { READ_FILE_TOOL } from './read-file.js'
import { READ_SECTION_TOOL } from './read-section.js'
import { RELATED_TESTS_TOOL } from './related-tests.js'
import { REPO_MAP_TOOL } from './repo-map.js'
import { RUN_TESTS_TOOL } from './run-tests.js'
import { SANDBOX_EXEC_TOOL } from './sandbox-exec-tool.js'
import { TODO_TOOL } from './todo.js'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'
import { WEB_FETCH_TOOL } from './web-fetch.js'
import { WEB_SEARCH_TOOL } from './web-search.js'
import { WRITE_FILE_TOOL } from './write-file.js'

export function createDefaultToolRegistry(extraTools: Tool[] = []): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(APPLY_PATCH_TOOL)
  registry.register(IMPORT_RESOURCE_TOOL)
  registry.register(READ_FILE_TOOL)
  registry.register(WRITE_FILE_TOOL)
  registry.register(PLAN_CLOSE_TOOL)
  registry.register(PLAN_SUBMIT_TOOL)
  registry.register(BASH_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(HASH_EDIT_TOOL)
  registry.register(GREP_TOOL)
  registry.register(GLOB_TOOL)
  registry.register(DIFF_TOOL)
  registry.register(RUN_TESTS_TOOL)
  registry.register(GIT_TOOL)
  registry.register(TODO_TOOL)
  registry.register(WEB_FETCH_TOOL)
  registry.register(INSPECT_PROJECT_TOOL)
  registry.register(REPO_MAP_TOOL)
  registry.register(RELATED_TESTS_TOOL)
  registry.register(WEB_SEARCH_TOOL)
  registry.register(READ_SECTION_TOOL)
  registry.register(SANDBOX_EXEC_TOOL)
  registry.register(IMPORT_RESOURCE_TOOL)
  registry.register(FILE_INFO_TOOL)
  for (const tool of extraTools) registry.register(tool)
  return registry
}
