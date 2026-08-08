/**
 * scan-excludes.ts — the directory names no filesystem-walking tool should
 * descend into.
 *
 * Pruning has to happen at the directory level. Filtering per file (a gitignore
 * check on each hit) still pays `readdir` + `lstat` for every entry underneath,
 * and that is where the cost actually lives: this repo's
 * `desktop/src-tauri/target/debug/deps` alone holds ~19k files / 4.2GB, with the
 * desktop app's own data directory nested inside it.
 *
 * This is the shared baseline, not the whole story — callers union their own
 * extras onto it (`repo_map` also skips `.cache`, ast tools also skip `.rivet`,
 * and so on). Keeping the baseline identical everywhere is the point: it used to
 * be copy-pasted into seven files that had each drifted, and the two that had
 * lost `target` were the ones walking into a 4.2GB build tree.
 *
 * Deliberately absent: `.rivet`. Plans, skills and project knowledge live there
 * and are legitimate search targets — `read_file` exempts it for the same
 * reason. Tools that want it skipped add it themselves.
 *
 * `TianshuData` is here because it is the opposite case: the desktop app's
 * portable-mode data directory (sessions, caches, logs — 2402 files) which
 * happens to nest its own `.rivet` inside. Naming it directly means the runtime
 * data is skipped wherever it is installed, rather than only when it lands
 * under `target/` as it does today.
 */
export const SCAN_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'target', '__pycache__',
  'TianshuData',
])

/** Whether a directory entry name is in the shared prune baseline. */
export function isScanExcludedDir(name: string): boolean {
  return SCAN_EXCLUDE_DIRS.has(name)
}
