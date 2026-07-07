/**
 * Plugin manifest types and validation.
 *
 * Each plugin declares its metadata in its package.json under the `"tianshu"` field.
 * The shape mirrors npm package identity (name/version) plus plugin-specific fields
 * (entry point, tool declarations, permissions, minCoreVersion).
 *
 * Manifest validation uses zod for schema enforcement at plugin load time;
 * illegal manifests cause the plugin to be skipped (fail-safe, per architecture decision 6).
 */

import { z } from 'zod'

// ── Tool descriptor (market display + conflict detection) ──────────

export const toolDescriptorSchema = z.object({
  /** Tool name as it appears in the agent's tool list. Must be unique across
   *  all registered tools (builtin + MCP + other plugins). */
  name: z.string().min(1).max(64),
  /** Human-readable one-liner for market display. */
  description: z.string().min(1).max(200),
})

export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>

// ── Permissions ────────────────────────────────────────────────────

export const permissionsSchema = z.object({
  /** Read/write files on disk. */
  fs: z.boolean().optional(),
  /** Make outbound network requests. */
  net: z.boolean().optional(),
  /** Execute shell commands. */
  shell: z.boolean().optional(),
})

export type Permissions = z.infer<typeof permissionsSchema>

// ── Manifest ───────────────────────────────────────────────────────

export const pluginManifestSchema = z.object({
  /** Unique plugin id (npm package name convention). */
  name: z.string().min(1).max(128),
  /** Semver version. */
  version: z.string().min(1).max(32),
  /** Short description for market display. */
  description: z.string().min(1).max(500),
  /** Relative path from plugin root to the compiled JS entry module.
   *  PluginLoader resolves this against the plugin's installation directory. */
  entry: z.string().min(1),
  /** Tools this plugin registers. Used for market preview and conflict detection. */
  tools: z.array(toolDescriptorSchema).min(1),
  /** Declared permissions. Shown to the user at install time. */
  permissions: permissionsSchema,
  /** Optional bundled skills — relative paths to directories containing SKILL.md. */
  skills: z.array(z.string().min(1)).optional(),
  /** Minimum core version required (semver range, advisory only in v1). */
  minCoreVersion: z.string().optional(),
})

export type PluginManifest = z.infer<typeof pluginManifestSchema>

// ── On-disk wrapper (what we read from package.json) ───────────────

/** The `package.json` shape we care about — just the `tianshu` field. */
export interface PluginPackageJson {
  name?: string
  version?: string
  tianshu?: Record<string, unknown>
}

// ── Validation helpers ─────────────────────────────────────────────

export interface ManifestValidationResult {
  ok: true
  manifest: PluginManifest
}

export interface ManifestValidationError {
  ok: false
  errors: string[]
}

export type ManifestParseResult = ManifestValidationResult | ManifestValidationError

/**
 * Parse and validate a plugin manifest from a raw `tianshu` field.
 * Returns structured result — callers decide whether to skip or abort.
 */
export function parseManifest(raw: unknown): ManifestParseResult {
  const result = pluginManifestSchema.safeParse(raw)
  if (result.success) {
    return { ok: true, manifest: result.data }
  }
  return {
    ok: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  }
}
