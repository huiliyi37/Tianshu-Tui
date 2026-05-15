## Bash Tool

Execute shell commands for build, test, git, and system operations.

**IMPORTANT**: Do NOT use Bash for reading, searching, or editing files. Use the dedicated tools instead:
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
Good: `npm test -- --grep "login"`
Good: `git add src/api/client.ts && git commit -m "fix: add retry logic to API client"`
Bad: `cat src/file.ts` (use read_file instead)
Bad: `echo "content" > file.ts` (use write_file instead)
