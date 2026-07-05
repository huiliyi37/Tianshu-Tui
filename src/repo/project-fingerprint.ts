/**
 * Project fingerprint — unified multi-language project detection (A0).
 *
 * Single source of truth for language/build-system/test-runner detection.
 * All existing probe sites (run-tests.ts detectTestCommand, env-check.ts
 * isPythonProject/recommendUvSetup, project-templates onboarding) consume
 * this one module instead of each implementing incomplete detection.
 *
 * Naming: not to be confused with src/prompt/fingerprint.ts (prefix-cache
 * content fingerprinting) — this is structural project detection.
 *
 * @module project-fingerprint
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ProjectFingerprint {
  /** Detected primary language. */
  language: 'typescript' | 'rust' | 'go' | 'python' | 'java' | 'unknown'
  /** Recommended test command (e.g. "npm test", "cargo test", "pytest"). */
  testCommand?: string
  /** Recommended build command (e.g. "npm run build", "cargo build"). */
  buildCommand?: string
  /** Recommended typecheck command (e.g. "tsc --noEmit", "cargo check"). */
  typecheckCommand?: string
  /** Recommended lint command (e.g. "eslint", "clippy", "ruff check"). */
  lintCommand?: string
  /** Whether the project appears to have test infrastructure. */
  hasTestInfra: boolean
}

/** Markers that a directory contains a Go module. */
const GO_MARKERS = ['go.mod']
/** Markers that a directory contains a Rust project. */
const RUST_MARKERS = ['Cargo.toml']
/** Markers that a directory contains a Python project. */
const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile']
/** Markers that a directory contains a Java/Gradle project. */
const JAVA_MARKERS = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'mvnw']
/** Markers for TypeScript/JavaScript (Node.js) projects. */
const NODE_MARKERS = ['package.json']

function hasAny(cwd: string, markers: readonly string[]): boolean {
  return markers.some(m => existsSync(join(cwd, m)))
}

function tryReadJson(cwd: string, file: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(cwd, file), 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── Per-language detection ──────────────────────────────────

function detectNode(cwd: string): ProjectFingerprint | null {
  const pkg = tryReadJson(cwd, 'package.json')
  if (!pkg) return null

  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {}
  const deps = { ...(pkg.devDependencies as Record<string, string> ?? {}), ...(pkg.dependencies as Record<string, string> ?? {}) }
  const testScript = scripts.test ?? ''

  let testCommand = 'npm test'
  let hasTestInfra = !!testScript
  if (testScript.includes('vitest')) {
    testCommand = 'npx vitest run'
    hasTestInfra = true
  } else if (testScript.includes('jest')) {
    testCommand = 'npx jest'
    hasTestInfra = true
  } else if (testScript.includes('tsx --test') || testScript.includes('node:test') || testScript.includes('run-node-tests')) {
    testCommand = testScript
    hasTestInfra = true
  }

  const buildCommand = scripts.build ? 'npm run build' : undefined
  const typecheckCommand = 'tsc --noEmit'
  const lintCommand = deps.eslint ? 'npx eslint .' : undefined

  return { language: 'typescript', testCommand, buildCommand, typecheckCommand, lintCommand, hasTestInfra }
}

function detectRust(cwd: string): ProjectFingerprint | null {
  if (!hasAny(cwd, RUST_MARKERS)) return null
  return {
    language: 'rust',
    testCommand: 'cargo test',
    buildCommand: 'cargo build',
    typecheckCommand: 'cargo check',
    lintCommand: 'cargo clippy',
    hasTestInfra: true, // cargo test always works
  }
}

function detectGo(cwd: string): ProjectFingerprint | null {
  if (!hasAny(cwd, GO_MARKERS)) return null
  return {
    language: 'go',
    testCommand: 'go test ./...',
    buildCommand: 'go build ./...',
    typecheckCommand: 'go vet ./...',
    lintCommand: undefined, // golangci-lint may or may not be installed
    hasTestInfra: true, // go test always works
  }
}

function detectPython(cwd: string): ProjectFingerprint | null {
  if (!hasAny(cwd, PYTHON_MARKERS)) return null
  const hasPyproject = existsSync(join(cwd, 'pyproject.toml'))
  return {
    language: 'python',
    testCommand: 'pytest',
    buildCommand: hasPyproject ? 'uv sync' : undefined,
    typecheckCommand: 'mypy .',
    lintCommand: 'ruff check .',
    hasTestInfra: existsSync(join(cwd, 'tests')) || existsSync(join(cwd, 'test')),
  }
}

function detectJava(cwd: string): ProjectFingerprint | null {
  if (!hasAny(cwd, JAVA_MARKERS)) return null
  const hasGradle = existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))
  const hasMaven = existsSync(join(cwd, 'pom.xml'))
  return {
    language: 'java',
    testCommand: hasGradle ? './gradlew test' : hasMaven ? 'mvn test' : undefined,
    buildCommand: hasGradle ? './gradlew build' : hasMaven ? 'mvn compile' : undefined,
    typecheckCommand: undefined, // javac is build-time; no separate typecheck
    lintCommand: hasGradle ? './gradlew check' : undefined,
    hasTestInfra: existsSync(join(cwd, 'src', 'test')),
  }
}

// ── Unified entry ──────────────────────────────────────────

/**
 * Detect the project fingerprint for the given directory.
 * Language detectors are tried in priority order: Node → Rust → Go → Python → Java.
 * Returns a minimal fingerprint with language='unknown' when nothing matches.
 */
export function detectProjectFingerprint(cwd: string): ProjectFingerprint {
  const detectors = [detectNode, detectRust, detectGo, detectPython, detectJava]
  for (const detect of detectors) {
    const fp = detect(cwd)
    if (fp) return fp
  }
  return { language: 'unknown', hasTestInfra: false }
}

/**
 * True when the project has no detectable language markers at all.
 */
export function isUnknownProject(cwd: string): boolean {
  return detectProjectFingerprint(cwd).language === 'unknown'
}

/**
 * Convenience: recommended verify config block for .rivet-config.json.
 */
export function fingerprintToVerifyConfig(fp: ProjectFingerprint): Record<string, string> {
  const cfg: Record<string, string> = {}
  if (fp.testCommand) cfg.test = fp.testCommand
  if (fp.buildCommand) cfg.build = fp.buildCommand
  if (fp.typecheckCommand) cfg.typecheck = fp.typecheckCommand
  if (fp.lintCommand) cfg.lint = fp.lintCommand
  return cfg
}
