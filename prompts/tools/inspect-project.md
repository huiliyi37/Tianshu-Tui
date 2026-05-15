## Inspect Project Tool

Analyze the current project and return a summary of its structure: language, package manager, scripts, entry files, test structure, and framework hints.

### Instructions
- Use `inspect_project` when first entering a project to quickly understand its structure
- No parameters needed — operates on the current working directory
- Returns a structured summary including:
  - Language (TypeScript or JavaScript)
  - Package manager (npm, yarn, pnpm)
  - Framework detection (React, Next.js, Vue, NestJS, Express, etc.)
  - Test framework (vitest, jest, mocha, node:test)
  - Linters (ESLint, Prettier, Biome)
  - Key scripts (build, test, lint, dev, start)
  - Entry files
  - Test file locations
  - Config files
- Useful for planning the first edit or understanding unfamiliar codebases

### Examples
Good: `inspect_project()` — get project overview before making changes
Good: Use before `glob` or `read_file` to understand project layout
