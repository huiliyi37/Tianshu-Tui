## Glob Tool

Find files matching a glob pattern. Use to locate files by name or pattern before reading them.

### Pattern Syntax
- `*` matches any characters except `/`
- `?` matches a single character except `/`
- `**` matches any number of directories (recursive)
- `{a,b}` matches `a` or `b`

### Instructions
- Use specific patterns to avoid large result sets
- Results are sorted alphabetically, limited to 500
- Default search root is cwd; use `path` to narrow scope
- Excludes: node_modules, .git, dist, .next, build, target, __pycache__

### Examples
Good: `glob(pattern="src/**/*.ts")`
Good: `glob(pattern="*.test.ts", path="src/")`
Good: `glob(pattern="src/components/**/*.tsx")`
Bad: `glob(pattern="node_modules/**")` (excluded by default)
