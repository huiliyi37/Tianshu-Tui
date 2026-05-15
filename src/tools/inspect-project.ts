import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'

interface PackageJson {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'target', '__pycache__',
])

const FRAMEWORK_HINTS: Array<{ deps: string[]; name: string }> = [
  { deps: ['next'], name: 'Next.js' },
  { deps: ['nuxt'], name: 'Nuxt' },
  { deps: ['@nestjs/core'], name: 'NestJS' },
  { deps: ['vue'], name: 'Vue' },
  { deps: ['react'], name: 'React' },
  { deps: ['express'], name: 'Express' },
  { deps: ['fastify'], name: 'Fastify' },
  { deps: ['hono'], name: 'Hono' },
  { deps: ['svelte'], name: 'Svelte' },
]

const TEST_FRAMEWORKS: Array<{ deps: string[]; name: string }> = [
  { deps: ['vitest'], name: 'vitest' },
  { deps: ['jest'], name: 'jest' },
  { deps: ['mocha'], name: 'mocha' },
]

const LINTERS: Array<{ files: string[]; deps: string[]; name: string }> = [
  { files: ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'], deps: ['eslint'], name: 'ESLint' },
  { files: ['.prettierrc', '.prettierrc.js', '.prettierrc.json', 'prettier.config.js'], deps: ['prettier'], name: 'Prettier' },
  { files: ['biome.json'], deps: ['@biomejs/biome'], name: 'Biome' },
]

const ENTRY_FILE_NAMES = ['main', 'index', 'app', 'server', 'cli']
const ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
const ENTRY_DIRS = ['src', 'lib', 'app', 'bin', '']

const CONFIG_FILE_PATTERNS = [
  'tsconfig.json', 'tsconfig.*.json',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs',
  'postcss.config.ts', 'postcss.config.js', 'postcss.config.mjs',
  'tsup.config.ts', 'tsup.config.js',
  'webpack.config.ts', 'webpack.config.js',
  'rollup.config.ts', 'rollup.config.js',
  'esbuild.config.ts', 'esbuild.config.js',
  'jest.config.ts', 'jest.config.js',
  'vitest.config.ts', 'vitest.config.js',
]

function detectLanguage(cwd: string): string {
  return existsSync(join(cwd, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript'
}

function detectPackageManager(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm'
  return 'unknown'
}

function detectFramework(pkg: PackageJson): string | null {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const hint of FRAMEWORK_HINTS) {
    if (hint.deps.some((d) => d in allDeps)) return hint.name
  }
  return null
}

function detectTestFramework(pkg: PackageJson): string | null {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  for (const hint of TEST_FRAMEWORKS) {
    if (hint.deps.some((d) => d in allDeps)) return hint.name
  }
  // Check scripts.test for node:test usage
  if (pkg.scripts?.test?.includes('node:test') || pkg.scripts?.test?.includes('--test')) {
    return 'node:test'
  }
  return null
}

function detectLinters(cwd: string, pkg: PackageJson): string[] {
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  const found: string[] = []
  for (const linter of LINTERS) {
    if (linter.files.some((f) => existsSync(join(cwd, f))) || linter.deps.some((d) => d in allDeps)) {
      found.push(linter.name)
    }
  }
  return found
}

function findEntryFiles(cwd: string): string[] {
  const entries: string[] = []
  for (const dir of ENTRY_DIRS) {
    const base = dir ? join(cwd, dir) : cwd
    if (dir && !existsSync(base)) continue
    for (const name of ENTRY_FILE_NAMES) {
      for (const ext of ENTRY_EXTENSIONS) {
        const fullPath = join(base, name + ext)
        if (existsSync(fullPath)) {
          entries.push(relative(cwd, fullPath))
        }
      }
    }
  }
  return entries
}

function findTestFiles(cwd: string): string[] {
  const files: string[] = []

  function walk(dir: string): void {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const fullPath = join(dir, name)
      let s: ReturnType<typeof statSync>
      try {
        s = statSync(fullPath)
      } catch {
        continue
      }
      if (s.isDirectory()) {
        if (EXCLUDE_DIRS.has(name)) continue
        walk(fullPath)
      } else if (s.isFile()) {
        if (name.includes('.test.') || name.includes('.spec.') || name === '__tests__') {
          files.push(relative(cwd, fullPath))
        }
      }
    }
  }

  walk(cwd)
  return files
}

function findConfigFiles(cwd: string): string[] {
  const found: string[] = []
  for (const pattern of CONFIG_FILE_PATTERNS) {
    if (pattern.includes('*')) {
      // Handle glob-like patterns (e.g. tsconfig.*.json)
      const dir = cwd
      try {
        const names = readdirSync(dir)
        const regexStr = pattern.replace(/\*/g, '[^.]*')
        const regex = new RegExp(`^${regexStr}$`)
        for (const name of names) {
          if (regex.test(name)) {
            found.push(name)
          }
        }
      } catch {
        // skip
      }
    } else {
      if (existsSync(join(cwd, pattern))) {
        found.push(pattern)
      }
    }
  }
  return found
}

export const INSPECT_PROJECT_TOOL: Tool = {
  definition: {
    name: 'inspect_project',
    description: `Analyze the current project and return a summary: language, package manager, scripts, entry files, test structure, and framework hints.

### Usage
- Use inspect_project when first entering a project to understand its structure
- No parameters needed — operates on the current working directory
- Returns structured summary useful for planning the first edit

### Examples
Good: inspect_project() — get project overview`,
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const cwd = params.cwd

    // Read package.json
    const pkgPath = join(cwd, 'package.json')
    if (!existsSync(pkgPath)) {
      return {
        content: 'No package.json found in current directory. Not a Node.js project.',
        isError: true,
      }
    }

    let pkg: PackageJson
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PackageJson
    } catch {
      return {
        content: 'Failed to parse package.json.',
        isError: true,
      }
    }

    const language = detectLanguage(cwd)
    const packageManager = detectPackageManager(cwd)
    const framework = detectFramework(pkg)
    const testFramework = detectTestFramework(pkg)
    const linters = detectLinters(cwd, pkg)
    const entryFiles = findEntryFiles(cwd)
    const testFiles = findTestFiles(cwd)
    const configFiles = findConfigFiles(cwd)

    // Build output
    const lines: string[] = []
    lines.push('## Project Summary')
    lines.push('')
    lines.push(`Language: ${language}`)
    lines.push(`Package manager: ${packageManager}`)
    if (framework) {
      lines.push(`Framework: ${framework} (detected from dependencies)`)
    }
    if (testFramework) {
      lines.push(`Test framework: ${testFramework}`)
    }
    if (linters.length > 0) {
      lines.push(`Linters: ${linters.join(', ')}`)
    }

    // Scripts
    const keyScripts = ['build', 'test', 'lint', 'dev', 'start', 'typecheck']
    const scripts = pkg.scripts ?? {}
    const relevantScripts = keyScripts.filter((s) => s in scripts)
    if (relevantScripts.length > 0) {
      lines.push('')
      lines.push('### Scripts')
      for (const s of relevantScripts) {
        lines.push(`- ${s}: ${scripts[s]}`)
      }
    }

    // Entry files
    if (entryFiles.length > 0) {
      lines.push('')
      lines.push('### Entry Files')
      for (const f of entryFiles) {
        lines.push(`- ${f}`)
      }
    }

    // Test structure
    if (testFiles.length > 0) {
      lines.push('')
      lines.push('### Test Structure')
      for (const f of testFiles) {
        lines.push(`- ${f}`)
      }
    }

    // Config files
    if (configFiles.length > 0) {
      lines.push('')
      lines.push('### Config Files')
      for (const f of configFiles) {
        lines.push(`- ${f}`)
      }
    }

    return { content: lines.join('\n') }
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe(): boolean {
    return true
  },

  isEnabled(): boolean {
    return true
  },
}
