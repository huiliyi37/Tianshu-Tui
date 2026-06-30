import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const SRC_ROOT = new URL('../src/', import.meta.url)

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js']

function resolveAlias(specifier) {
  if (!specifier.startsWith('@/')) return null
  const relativePath = specifier.slice(2)
  const base = new URL(relativePath, SRC_ROOT)
  const basePath = base.pathname

  // If the specifier already has an extension, use it directly.
  if (extname(basePath)) {
    return existsSync(basePath) ? base.href : null
  }

  // Try common extensions.
  for (const ext of EXTENSIONS) {
    const candidate = basePath + ext
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href
    }
  }

  return null
}

/** ESM resolve hook for desktop tests: map @/ to desktop/src/ so tsx can run
 *  component tests that import UI components via the Vite alias. */
export async function resolve(specifier, context, nextResolve) {
  const resolved = resolveAlias(specifier)
  if (resolved) {
    return { format: 'module', shortCircuit: true, url: resolved }
  }
  return nextResolve(specifier, context)
}
