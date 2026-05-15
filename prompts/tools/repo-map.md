## Repo Map Tool

Return a condensed file tree showing project structure with key entry points and test files.

### Annotations
- `[entry]` — main entry files (main.tsx, index.ts, app.tsx, server.ts, etc.)
- `[test]` — test files (*.test.ts, *.spec.ts, __tests__/)
- `[config]` — configuration (tsconfig.json, package.json, *.config.*)
- `[doc]` — documentation (*.md files)

### Instructions
- Use repo_map when first entering a project to understand its layout
- Max depth is 4 levels; max 200 files by default (adjustable via max_files)
- Excludes: node_modules, .git, dist, build, .next, coverage, __pycache__, .turbo, .cache
- Hidden files/dirs are skipped except .env.example and .gitignore

### Examples
Good: `repo_map()`
Good: `repo_map(max_files=100)` — smaller tree for large projects
