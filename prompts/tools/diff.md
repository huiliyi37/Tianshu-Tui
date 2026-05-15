## Diff Tool

Show git diff for working tree changes.

### Usage
- Use diff to see what files have changed before committing
- Use diff before editing to understand current state
- Use diff after editing to verify changes are correct
- Results are truncated per file (200 lines max)

### Parameters
- `staged` (boolean) — Show staged changes instead of unstaged
- `path` (string) — Filter to a specific file or directory
- `context_lines` (integer) — Lines of context around changes (default: 3)

### Examples
Good: `diff()` — show all unstaged changes
Good: `diff(staged=true)` — show staged changes
Good: `diff(path="src/api/client.ts")` — show diff for one file
