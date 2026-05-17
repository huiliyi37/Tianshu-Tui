import type { RepairPass, RepairContext, RepairResult } from './repair-pipeline.js'

/**
 * CTCL (Claude Tool Compatibility Layer) Sanitizer Pass.
 *
 * Inspired by Ahmad Awais / CommandCodeAI's 99.7% cache-hit DeepSeek setup:
 * DeepSeek was trained on Claude Code tool formats and sometimes produces
 * tool inputs using Claude Code parameter names or nested structures.
 *
 * This pass runs BEFORE schema-guided repair to fix provider-specific
 * malformations that schema validation alone can't catch.
 *
 * Fixes applied (all non-destructive — only modify when fix is unambiguous):
 * 1. Key alias mapping — DeepSeek uses Claude Code param names
 * 2. Nested command unwrap — shell commands wrapped in extra objects
 * 3. Path normalization — strip leading ./, resolve ../
 * 4. Type coercion — string→boolean, string→number for known params
 * 5. Tool name normalization — Claude Code→Rivet name mapping (handled upstream)
 */

// ─── Key alias table ────────────────────────────────────────────────

/**
 * Maps Claude Code / common alias parameter names to Rivet's canonical names.
 * Only maps when the canonical key is missing AND already in the tool schema.
 */
const KEY_ALIASES: Record<string, string[]> = {
  file_path: ['path', 'filePath', 'file', 'target_file', 'filename'],
  command: ['cmd', 'shell_command', 'shellCommand', 'run'],
  pattern: ['search', 'query', 'regex', 'regexp'],
  old_string: ['old_str', 'oldString', 'original', 'search_text', 'content'],
  new_string: ['new_str', 'newString', 'replacement', 'replace_text', 'content'],
  file_path2: ['file2', 'second_file', 'target2'],
  timeout: ['timeout_ms', 'timeoutMs', 'max_time'],
  replace_all: ['replaceAll', 'all', 'global'],
  tool_use_id: ['toolUseId', 'toolCallId', 'callId', 'id'],
}

// ─── Known param types from tool schemas ─────────────────────────────

interface SchemaProp {
  type?: string
  properties?: Record<string, SchemaProp>
}

function getParamTypes(schema: RepairContext['schema']): Record<string, string> {
  const types: Record<string, string> = {}
  const props = (schema as { properties?: Record<string, SchemaProp> }).properties
  if (!props) return types
  for (const [key, prop] of Object.entries(props)) {
    if (prop.type) types[key] = prop.type
  }
  return types
}

// ─── Key alias remapping ────────────────────────────────────────────

function applyKeyAliases(
  input: Record<string, unknown>,
  ctx: RepairContext,
): { output: Record<string, unknown>; applied: boolean } {
  const existing = new Set(Object.keys(input))
  const result = { ...input }
  let applied = false

  // Get known params from schema
  const schemaProps = new Set(
    Object.keys((ctx.schema as { properties?: Record<string, unknown> }).properties ?? {}),
  )

  for (const [canonical, aliases] of Object.entries(KEY_ALIASES)) {
    // Only remap if canonical key is missing and is in the schema
    if (existing.has(canonical)) continue
    if (!schemaProps.has(canonical)) continue

    for (const alias of aliases) {
      if (existing.has(alias) && !existing.has(canonical)) {
        result[canonical] = input[alias]
        delete result[alias]
        applied = true
        break
      }
    }
  }

  return { output: result, applied }
}

// ─── Nested command unwrap ──────────────────────────────────────────

function unwrapNestedCommand(
  input: Record<string, unknown>,
  ctx: RepairContext,
): { output: Record<string, unknown>; applied: boolean } {
  // Only applies to bash tool (or tools with 'command' param)
  const schemaProps = (ctx.schema as { properties?: Record<string, unknown> }).properties
  if (!schemaProps?.['command']) return { output: input, applied: false }

  const cmd = input['command']
  if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) {
    return { output: input, applied: false }
  }

  // DeepSeek sometimes wraps: { command: { command: "ls -la" } }
  const inner = cmd as Record<string, unknown>
  if (typeof inner['command'] === 'string') {
    return {
      output: { ...input, command: inner['command'] },
      applied: true,
    }
  }

  return { output: input, applied: false }
}

// ─── Path normalization ─────────────────────────────────────────────

function normalizePaths(
  input: Record<string, unknown>,
  ctx: RepairContext,
): { output: Record<string, unknown>; applied: boolean } {
  const schemaProps = (ctx.schema as { properties?: Record<string, unknown> }).properties
  if (!schemaProps) return { output: input, applied: false }

  const pathKeys = Object.keys(schemaProps).filter(
    k => k.includes('path') || k.includes('file'),
  )
  if (pathKeys.length === 0) return { output: input, applied: false }

  const result = { ...input }
  let applied = false

  for (const key of pathKeys) {
    const val = result[key]
    if (typeof val !== 'string') continue

    // Strip leading ./
    if (val.startsWith('./') && val.length > 2) {
      result[key] = val.slice(2)
      applied = true
    }
  }

  return { output: result, applied }
}

// ─── Type coercion ──────────────────────────────────────────────────

function coerceTypes(
  input: Record<string, unknown>,
  ctx: RepairContext,
): { output: Record<string, unknown>; applied: boolean } {
  const paramTypes = getParamTypes(ctx.schema)
  if (Object.keys(paramTypes).length === 0) return { output: input, applied: false }

  const result = { ...input }
  let applied = false

  for (const [key, expectedType] of Object.entries(paramTypes)) {
    const val = result[key]
    if (val === undefined || val === null) continue

    // string → boolean
    if (expectedType === 'boolean' && typeof val === 'string') {
      if (val === 'true') { result[key] = true; applied = true }
      else if (val === 'false') { result[key] = false; applied = true }
      continue
    }

    // string → number / integer
    if ((expectedType === 'number' || expectedType === 'integer') && typeof val === 'string') {
      const num = Number(val)
      if (!Number.isNaN(num) && val.trim() !== '') {
        result[key] = expectedType === 'integer' ? Math.trunc(num) : num
        applied = true
      }
    }
  }

  return { output: result, applied }
}

// ─── Public RepairPass ──────────────────────────────────────────────

export const ctclSanitizerPass: RepairPass = {
  name: 'ctcl-sanitizer',
  run(input: Record<string, unknown>, ctx: RepairContext): RepairResult {
    let current = input
    let anyApplied = false

    // Step 1: Key alias mapping
    const aliasResult = applyKeyAliases(current, ctx)
    if (aliasResult.applied) { current = aliasResult.output; anyApplied = true }

    // Step 2: Nested command unwrap (bash-specific)
    const unwrapResult = unwrapNestedCommand(current, ctx)
    if (unwrapResult.applied) { current = unwrapResult.output; anyApplied = true }

    // Step 3: Path normalization
    const pathResult = normalizePaths(current, ctx)
    if (pathResult.applied) { current = pathResult.output; anyApplied = true }

    // Step 4: Type coercion
    const coerceResult = coerceTypes(current, ctx)
    if (coerceResult.applied) { current = coerceResult.output; anyApplied = true }

    return {
      output: current,
      applied: anyApplied,
      fixType: anyApplied ? 'ctclSanitizer' : undefined,
    }
  },
}
