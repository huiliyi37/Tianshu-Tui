/**
 * Snapshot dependency provisioner (VSW P1)
 *
 * A VSW worktree only contains tracked HEAD files — no node_modules / .venv.
 * Tests need those present. The cheapest correct provisioning is a top-level
 * symlink into the base repo's already-installed trees (seconds, zero install).
 *
 * Caveat (反证 §7): a single top-level symlink does NOT cover a pnpm/yarn
 * workspace's nested per-package node_modules. When a workspace is detected we
 * skip the symlink and recommend `pnpm install --frozen-lockfile` (shared global
 * store → near-instant), surfacing it as a degraded path rather than silently
 * linking a tree that would fail module resolution.
 *
 * This module performs the cheap symlink itself and *returns* the recommended
 * install command for the degraded path; it does not run heavyweight installs
 * (the caller decides, keeping this pure-ish and unit-testable).
 *
 * @module snapshot-deps
 */

import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

export type DepLinkStatus =
  | 'linked'            // symlink created into the base repo's tree
  | 'skipped-exists'    // target already present in the worktree
  | 'source-absent'     // base repo has nothing to link
  | 'skipped-workspace' // monorepo: single symlink is wrong → install instead
  | 'error'             // symlink attempt failed

export interface DepLinkOutcome {
  name: string
  status: DepLinkStatus
}

export interface DepsProvisionResult {
  links: DepLinkOutcome[]
  /** Recommended command to run inside the worktree when symlink can't satisfy deps. */
  installCommand?: string[]
  warnings: string[]
}

const DEFAULT_TARGETS = ['node_modules', '.venv'] as const

/** A pnpm/yarn workspace whose nested node_modules a single symlink cannot cover. */
export function isWorkspaceRepo(baseCwd: string): boolean {
  if (existsSync(join(baseCwd, 'pnpm-workspace.yaml'))) return true
  if (existsSync(join(baseCwd, 'pnpm-lock.yaml'))) return true
  if (existsSync(join(baseCwd, 'yarn.lock')) && existsSync(join(baseCwd, '.yarnrc.yml'))) return true
  return false
}

/**
 * Provision dependency trees into a snapshot worktree via symlink, with a
 * workspace-aware degraded path. Pure side effect is creating symlinks; install
 * is only recommended, never executed here.
 */
export function provisionSnapshotDeps(
  baseCwd: string,
  worktreePath: string,
  targets: readonly string[] = DEFAULT_TARGETS,
): DepsProvisionResult {
  const links: DepLinkOutcome[] = []
  const warnings: string[] = []
  let installCommand: string[] | undefined
  const workspace = isWorkspaceRepo(baseCwd)

  for (const name of targets) {
    const source = join(baseCwd, name)
    const target = join(worktreePath, name)

    if (!existsSync(source)) {
      links.push({ name, status: 'source-absent' })
      continue
    }
    if (existsSync(target)) {
      links.push({ name, status: 'skipped-exists' })
      continue
    }
    if (name === 'node_modules' && workspace) {
      links.push({ name, status: 'skipped-workspace' })
      installCommand = ['pnpm', 'install', '--frozen-lockfile']
      warnings.push(
        'Workspace detected: a single node_modules symlink cannot cover nested package trees. ' +
          'Run `pnpm install --frozen-lockfile` in the snapshot worktree before verifying.',
      )
      continue
    }

    try {
      symlinkSync(source, target, 'dir')
      links.push({ name, status: 'linked' })
    } catch (error) {
      links.push({ name, status: 'error' })
      warnings.push(`Failed to symlink ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return installCommand ? { links, installCommand, warnings } : { links, warnings }
}
