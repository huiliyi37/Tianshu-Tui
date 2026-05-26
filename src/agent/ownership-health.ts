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
  infoLines: string[]
}

export function summarizeOwnershipHealth(input: OwnershipHealthInput): OwnershipHealthReport {
  const owned = new Set(input.ownedFiles)
  const external = new Set(input.externalFiles)
  const dirty = new Set(input.dirtyFiles)

  const untrackedDirtyOwned = input.dirtyFiles.filter(f => owned.has(f)).sort()
  const dirtyExternal = input.dirtyFiles.filter(f => external.has(f)).sort()
  const cleanOwned = input.ownedFiles.filter(f => !dirty.has(f)).sort()
  const warningLines: string[] = []
  const infoLines: string[] = []

  for (const f of input.dirtyFiles) {
    if (!owned.has(f) && !external.has(f)) {
      warningLines.push(`Dirty file has no ownership classification: ${f}`)
    }
  }
  if (untrackedDirtyOwned.length === 0 && dirtyExternal.length > 0 && warningLines.length === 0) {
    infoLines.push('No current owned dirty files. External dirty files are present and excluded from delivery scope.')
  }

  return { untrackedDirtyOwned, dirtyExternal, cleanOwned, warningLines, infoLines }
}
