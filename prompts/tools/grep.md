## Grep Tool

Search file contents with regex or literal patterns.

### Instructions
- Use grep to find functions, classes, patterns, or keywords in source code
- Prefer grep over bash grep/rg — this tool is faster and respects .gitignore
- Results are grouped by file with line numbers
- Pattern can be a regex (default) or literal string
- Use glob to restrict search to specific file types (e.g. "*.ts", "*.{ts,tsx}")

### Parameters
- `pattern` (required): Regex or literal pattern to search for
- `path`: Directory or file to search (default: cwd)
- `glob`: File filter e.g. "*.ts" or "*.{ts,tsx}"
- `max_results`: Max matching lines (default: 100)
- `literal`: Treat pattern as literal, not regex (default: false)

### Examples
Good: `grep(pattern="function handleSubmit", path="src/")`
Good: `grep(pattern="API_KEY", path=".", glob="*.{ts,tsx}")`
Good: `grep(pattern="import React", literal=true)`
Bad: `grep(pattern="x")` (too broad — will match too many lines)
