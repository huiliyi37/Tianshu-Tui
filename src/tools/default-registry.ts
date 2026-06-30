import { APPLY_PATCH_TOOL } from './apply-patch.js'
import { AST_EDIT_TOOL } from './ast-edit.js'
import { AST_GREP_TOOL } from './ast-grep.js'
import { IMPORT_RESOURCE_TOOL } from './import-resource.js'
import { FILE_INFO_TOOL } from './file-info.js'
import { CREATE_DOCUMENT_TOOL } from './create-document.js'
import { CREATE_SPREADSHEET_TOOL } from './create-spreadsheet.js'
import { CREATE_IMAGE_TOOL } from './create-image.js'
import { CREATE_PRESENTATION_TOOL } from './create-presentation.js'
import { CREATE_PDF_TOOL } from './create-pdf.js'
import { EXPORT_FILE_TOOL } from './export-file.js'
import { OPEN_PATH_TOOL } from './open-path.js'
import { REQUEST_PATH_ACCESS_TOOL } from './request-path-access.js'
import { SKILL_TOOL } from './skill.js'
import { BROWSER_TOOL } from './browser.js'
import { BASH_TOOL } from './bash.js'
import { DIFF_TOOL } from './diff.js'
import { EDIT_FILE_TOOL } from './edit.js'
import { HASH_EDIT_TOOL } from './hash-edit.js'
import { GIT_TOOL } from './git.js'
import { GLOB_TOOL } from './glob.js'
import { GREP_TOOL } from './grep.js'
import { INSPECT_PROJECT_TOOL } from './inspect-project.js'
import { LEAVE_MARK_TOOL } from './leave-mark.js'
import { PLAN_SUBMIT_TOOL, PLAN_CLOSE_TOOL } from './plan.js'
import { READ_FILE_TOOL } from './read-file.js'
import { READ_SECTION_TOOL } from './read-section.js'
import { RELATED_TESTS_TOOL } from './related-tests.js'
import { REPO_MAP_TOOL } from './repo-map.js'
import { RUN_TESTS_TOOL } from './run-tests.js'
import { TODO_TOOL, createTodoTool } from './todo.js'
import type { TodoStore } from './todo-store.js'
import { ToolRegistry } from './registry.js'
import type { Tool } from './types.js'
import { WEB_FETCH_TOOL } from './web-fetch.js'
import { WEB_SEARCH_TOOL } from './web-search.js'
import { WRITE_FILE_TOOL } from './write-file.js'

export interface DefaultRegistryOptions {
  /** T8 桌面化办公工具（create_document/spreadsheet/image/presentation/pdf + export_file/open_path）。
   *  默认关闭：工具数必须守住 kernel budget（≤25），超过会触发认知过载退化
   *  （见 kernel-budget.test.ts / trained-mode-analysis.md 3.2.B）。 */
  desktopTools?: boolean
  /** N4 桌面浏览器验证工具。默认关闭：新攻击面 + 占 kernel budget，仅桌面 sidecar 开启。 */
  browserTool?: boolean
  /** 多会话隔离：注入 per-session TodoStore。缺省回退全局 TODO_TOOL（defaultStore）。
   *  注意工具 definition（name/description/schema）与 TODO_TOOL 字节一致，仅 store 不同，
   *  不影响系统提示词前缀缓存。 */
  todoStore?: TodoStore
}

export function createDefaultToolRegistry(extraTools: Tool[] = [], options: DefaultRegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
  // apply_patch moved to EXTENDED layer (interactive/bootstrap) — overlap with
  // hash_edit covers >90% of use cases; keep in interactive for edge cases.
  registry.register(IMPORT_RESOURCE_TOOL)
  registry.register(READ_FILE_TOOL)
  registry.register(WRITE_FILE_TOOL)
  if (options.desktopTools) {
    registry.register(EXPORT_FILE_TOOL)
    registry.register(OPEN_PATH_TOOL)
    registry.register(CREATE_DOCUMENT_TOOL)
    registry.register(CREATE_SPREADSHEET_TOOL)
    registry.register(CREATE_IMAGE_TOOL)
    registry.register(CREATE_PRESENTATION_TOOL)
    registry.register(CREATE_PDF_TOOL)
  }
  registry.register(PLAN_CLOSE_TOOL)
  registry.register(PLAN_SUBMIT_TOOL)
  registry.register(BASH_TOOL)
  registry.register(EDIT_FILE_TOOL)
  registry.register(HASH_EDIT_TOOL)
  registry.register(GREP_TOOL)
  registry.register(AST_GREP_TOOL)
  registry.register(AST_EDIT_TOOL)
  registry.register(GLOB_TOOL)
  registry.register(DIFF_TOOL)
  registry.register(RUN_TESTS_TOOL)
  registry.register(GIT_TOOL)
  registry.register(options.todoStore ? createTodoTool(options.todoStore) : TODO_TOOL)
  registry.register(WEB_FETCH_TOOL)
  registry.register(WEB_SEARCH_TOOL)
  registry.register(INSPECT_PROJECT_TOOL)
  registry.register(REPO_MAP_TOOL)
  registry.register(RELATED_TESTS_TOOL)
  registry.register(READ_SECTION_TOOL)
  registry.register(FILE_INFO_TOOL)
  registry.register(REQUEST_PATH_ACCESS_TOOL)
  registry.register(SKILL_TOOL)
  registry.register(LEAVE_MARK_TOOL)
  if (options.browserTool) {
    registry.register(BROWSER_TOOL)
  }
  for (const tool of extraTools) registry.register(tool)
  return registry
}
