import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'
import { grantPath, type GrantMode } from './path-grants.js'

/**
 * Explicitly request access to a path OUTSIDE the workspace. Requires user
 * approval (the normal approval round-trip). On approval, a directory-subtree
 * grant is recorded so subsequent file tools AND bash commands can read/write
 * there — without dropping the whole sandbox.
 *
 * This is the uniform mechanism for bash / multi-path / proactive grants where
 * the inline pipeline gate (which only inspects single-path file tools) cannot
 * statically see the target. For ordinary single-file out-of-workspace reads or
 * writes, just calling read_file/write_file triggers the inline grant prompt.
 */
export const REQUEST_PATH_ACCESS_TOOL: Tool = {
  definition: {
    name: 'request_path_access',
    description: `Request user permission to access a path OUTSIDE the current workspace.

Use for batch/directory grants or bash-based out-of-workspace work. On approval
the directory subtree becomes readable/writable for this session (persist with
remember=true). For single out-of-workspace file reads/writes, calling
read_file/write_file directly triggers the same inline prompt.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or ~-relative path (file or directory) outside the workspace to grant access to.' },
        mode: { type: 'string', enum: ['read', 'write'], description: "Access level. 'write' implies read. Defaults to 'write'." },
        remember: { type: 'boolean', description: 'Persist the grant for THIS workspace across sessions. Defaults to false (session-only).' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const raw = params.input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: 'Error: path is required', isError: true }
    }
    const mode: GrantMode = params.input.mode === 'read' ? 'read' : 'write'
    const remember = params.input.remember === true

    const target = resolve(expandHome(raw.trim()))
    // Grant the directory subtree: the path itself if it is (or will be) a
    // directory, otherwise its parent so the file + siblings are reachable.
    let root = target
    try {
      if (!(existsSync(target) && statSync(target).isDirectory())) root = dirname(target)
    } catch {
      root = dirname(target)
    }

    const grant = grantPath(root, mode, { persist: remember, cwd: params.cwd })
    const lifetime = remember ? 'persisted for this workspace (survives restarts)' : 'this session only'
    return {
      content: `Granted ${grant.mode} access to: ${grant.root}\nScope: this directory and everything under it — ${lifetime}.\nFile tools and bash can now ${grant.mode === 'write' ? 'read and write' : 'read'} paths there.`,
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
