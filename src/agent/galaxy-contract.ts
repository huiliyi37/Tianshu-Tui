/**
 * Shared Galaxy input contract.
 *
 * Codex treats child-spawn arguments as a protocol: ambiguous inputs are
 * rejected before a child is created, rather than being silently normalized
 * by the scheduler. Galaxy keeps the same boundary for EP/DP plans so an
 * invalid plan cannot partially reserve workers or create obligations.
 */

export interface GalaxyDimensionContract {
  name: string
  authority?: string
  authorities?: readonly string[]
  parallelism?: 'expert' | 'data'
  replicas?: number
}

export interface GalaxyContractIssue {
  dimensionIndex: number
  code:
    | 'duplicate-dimension'
    | 'ambiguous-authority'
    | 'missing-authority'
    | 'duplicate-authority'
    | 'data-authority-list'
    | 'data-replicas'
    | 'expert-replicas'
  message: string
}

/** Stable comparison key for user-facing dimension and authority labels. */
export function normalizeGalaxyLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s_-]+/g, '-')
}

/**
 * Validate all cross-field invariants that a Zod object cannot express with
 * a simple min check. Every issue is returned so callers can show one
 * complete correction instead of making the model retry one field at a time.
 */
export function validateGalaxyDimensionContract(
  dimensions: readonly GalaxyDimensionContract[],
): GalaxyContractIssue[] {
  const issues: GalaxyContractIssue[] = []
  const dimensionNames = new Map<string, number>()

  for (let index = 0; index < dimensions.length; index++) {
    const dimension = dimensions[index]!
    const name = normalizeGalaxyLabel(dimension.name)
    const previous = dimensionNames.get(name)
    if (previous !== undefined) {
      issues.push({
        dimensionIndex: index,
        code: 'duplicate-dimension',
        message: `dimension "${dimension.name}" duplicates dimension #${previous + 1}; use unique names so task identity remains stable`,
      })
    } else {
      dimensionNames.set(name, index)
    }

    const hasAuthorityField = dimension.authority !== undefined
    const hasAuthoritiesField = dimension.authorities !== undefined
    if (hasAuthorityField && hasAuthoritiesField) {
      issues.push({
        dimensionIndex: index,
        code: 'ambiguous-authority',
        message: `dimension "${dimension.name}" must set either authority or authorities, not both`,
      })
    }

    const authority = dimension.authority?.trim() ?? ''
    const authorities = (dimension.authorities ?? []).map(value => value.trim())
    if (!authority && authorities.length === 0) {
      issues.push({
        dimensionIndex: index,
        code: 'missing-authority',
        message: `dimension "${dimension.name}" must select at least one star-domain authority`,
      })
    }

    const seenAuthorities = new Set<string>()
    for (const candidate of authorities) {
      const key = normalizeGalaxyLabel(candidate)
      if (seenAuthorities.has(key)) {
        issues.push({
          dimensionIndex: index,
          code: 'duplicate-authority',
          message: `dimension "${dimension.name}" repeats authority "${candidate}"; each EP perspective must be unique`,
        })
        break
      }
      seenAuthorities.add(key)
    }

    if (dimension.parallelism === 'data') {
      if (hasAuthoritiesField || authorities.length > 0) {
        issues.push({
          dimensionIndex: index,
          code: 'data-authority-list',
          message: `data-parallel dimension "${dimension.name}" accepts one authority; use expert mode for multiple perspectives`,
        })
      }
      if (dimension.replicas === undefined || dimension.replicas < 2) {
        issues.push({
          dimensionIndex: index,
          code: 'data-replicas',
          message: `data-parallel dimension "${dimension.name}" requires replicas >= 2`,
        })
      }
    } else if (dimension.replicas !== undefined) {
      issues.push({
        dimensionIndex: index,
        code: 'expert-replicas',
        message: `expert dimension "${dimension.name}" cannot set replicas; use parallelism: data for independent copies`,
      })
    }
  }

  return issues
}
