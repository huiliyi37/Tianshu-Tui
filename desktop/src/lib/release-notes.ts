import { getVersion } from '@tauri-apps/api/app'
import { RELEASE_NOTES, type ReleaseNote } from '../generated/release-notes.ts'

const LAST_SEEN_KEY = 'tianshu.lastSeenVersion'

export { type ReleaseNote }

/** Best-effort app version. In Tauri uses the bundle version; in browser dev
 *  falls back to the latest release-note version so the release-notes flow can
 *  still be exercised without importing package.json (which trips the JS
 *  obfuscator's parser on import assertions). */
export async function getCurrentVersion(): Promise<string> {
  try {
    return await getVersion()
  } catch {
    return RELEASE_NOTES[0]?.version ?? '0.0.0'
  }
}

export function loadLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}

export function saveLastSeenVersion(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version)
  } catch {
    // ignore (e.g. private mode)
  }
}

/** Compare two simple semver strings (`major.minor.patch`). Returns positive if
 *  `a > b`, negative if `a < b`, and zero if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.isFinite(pa[i]) ? pa[i]! : 0
    const nb = Number.isFinite(pb[i]) ? pb[i]! : 0
    if (na !== nb) return na - nb
  }
  return 0
}

export function isGreaterVersion(a: string, b: string): boolean {
  return compareSemver(a, b) > 0
}

/** The release note whose version exactly matches the current app version. */
export async function getCurrentNote(): Promise<ReleaseNote | undefined> {
  const version = await getCurrentVersion()
  return RELEASE_NOTES.find((n) => n.version === version)
}

/** All release notes newer than `version`, sorted newest first. */
export function getNotesSince(version: string | null | undefined): ReleaseNote[] {
  if (!version) return [...RELEASE_NOTES]
  return RELEASE_NOTES.filter((n) => isGreaterVersion(n.version, version))
}

/** True when the current app version has a release note and the user has not
 *  yet dismissed it. */
export async function hasUnreadReleaseNotes(): Promise<boolean> {
  const current = await getCurrentVersion()
  const lastSeen = loadLastSeenVersion()
  if (lastSeen === current) return false
  const note = RELEASE_NOTES.find((n) => n.version === current)
  return note != null
}
