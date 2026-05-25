export interface OwnershipHealthInput {
  ownedFiles: string[]
  externalFiles: string[]
  dirtyFiles: string[]
}

export interface OwnershipHealthReport {
  untrackedDirtyOwned: string[]
  dirtyExternal: string[]
  cleanOwned: string[]
  warningLines: string[]
}

export function summarizeOwnershipHealth(input: OwnershipHealthInput): OwnershipHealthReport {
  const owned = new Set(input.ownedFiles)
  const external = new Set(input.externalFiles)
  const dirty = new Set(input.dirtyFiles)

  const untrackedDirtyOwned = input.dirtyFiles.filter(f => owned.has(f)).sort()
  const dirtyExternal = input.dirtyFiles.filter(f => external.has(f)).sort()
  const cleanOwned = input.ownedFiles.filter(f => !dirty.has(f)).sort()
  const warningLines: string[] = []

  for (const f of input.dirtyFiles) {
    if (!owned.has(f) && !external.has(f)) {
      warningLines.push(`Dirty file has no ownership classification: ${f}`)
    }
  }
  if (input.ownedFiles.length === 0 && input.dirtyFiles.length > 0) {
    warningLines.push('No owned files registered, but dirty files exist. Check task-ledger write events.')
  }

  return { untrackedDirtyOwned, dirtyExternal, cleanOwned, warningLines }
}
