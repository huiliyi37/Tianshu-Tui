import { exec } from 'child_process'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'

const DANGEROUS_PATTERNS = ['git push', 'rm -rf', 'git reset --hard', 'sudo', 'chmod 777']

export const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: `Execute shell commands for build, test, git, and system operations.

IMPORTANT: Do NOT use Bash for reading, searching, or editing files. Use the dedicated tools instead:
- read_file for reading files
- grep for searching file contents
- glob for finding files by pattern
- edit_file for search-and-replace edits
- write_file for creating new files

### Instructions
- Quote file paths containing spaces: cd "path with spaces/file.txt"
- Prefer absolute paths over cd when possible
- Chain independent commands with &&, not ;
- Use run_in_background for long operations (builds, tests, npm install)
- Timeout defaults to 120s; pass timeout parameter for longer commands

### Git Protocol
- NEVER skip hooks (--no-verify) unless user explicitly asks
- NEVER force push to main/master
- Create NEW commits rather than amending
- Use conventional commit format: type(scope): description
- Check git status before committing

### Examples
Good: \`npm test -- --grep "login"\`
Good: \`git add src/api/client.ts && git commit -m "fix: add retry logic to API client"\`
Bad: \`cat src/file.ts\` (use read_file instead)
Bad: \`echo "content" > file.ts\` (use write_file instead)`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'integer', description: 'Timeout in ms (default 120000)' },
      },
      required: ['command'],
    },
  },

  async execute(params: ToolCallParams) {
    const command = params.input.command as string
    const timeout = (params.input.timeout as number) ?? 120_000

    return new Promise((resolve) => {
      exec(command, {
        cwd: params.cwd,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      }, (error, stdout, stderr) => {
        if (error) {
          const output = [stdout, stderr].filter(Boolean).join('\n')
          resolve({
            content: truncateContent(output || error.message || 'Unknown error', 12000, 6000, 4000),
            isError: true,
          })
        } else {
          resolve({ content: truncateContent(stdout, 12000, 6000, 4000) })
        }
      })
    })
  },

  requiresApproval(params: ToolCallParams): boolean {
    const command = (params.input.command as string).toLowerCase()
    return DANGEROUS_PATTERNS.some(d => command.includes(d))
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
