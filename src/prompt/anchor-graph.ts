import { createHash } from 'node:crypto'

/**
 * HEARTH — 永明灯系统 · Anchor Graph
 *
 * 5 个不动锚位组成的关系拓扑。每个锚位是"关系上的角色"，不是"具体内容"。
 * 内容可演化（载体有限），关系不变（身份无限）。
 * 这是独立的观测层，不参与 prefix cache fingerprint。
 */

export type AnchorNodeId =
  | 'pole_structure'
  | 'pole_void'
  | 'cycle_close'
  | 'cycle_open'
  | 'center_belief'

export interface AnchorNode {
  /** 锚位 ID — 在关系图中的角色 */
  id: AnchorNodeId
  /** SHA-256 hex digest of the node's source content */
  hash: string
  /** Human-readable role description (diagnostics only, not in fingerprint) */
  role: string
}

export interface AnchorGraph {
  /** 5 个锚位节点，按 canonical order 排列 */
  nodes: AnchorNode[]
  /** SHA-256 of all node hashes concatenated in canonical order, ':'-separated */
  graphHash: string
}

export interface AnchorGraphInput {
  /** SHA-256 of project hard constraints (.rivet.md + tools definitions) */
  structureHash: string
  /** SHA-256 of the void shape — should be XOR-complement of structureHash */
  voidShape: string
  /** SHA-256 of previous session's cycle_close */
  prevCycleClose: string
  /** SHA-256 of current session's cycle_open (must differ each session) */
  currentCycleOpen: string
  /** SHA-256 of founding belief (CLAUDE.md / AGENTS.md star covenant section) */
  centerBeliefHash: string
}

// ─── Canonical order — MUST be stable for deterministic graphHash ───

const CANONICAL_ORDER: readonly AnchorNodeId[] = [
  'pole_structure',
  'pole_void',
  'cycle_close',
  'cycle_open',
  'center_belief',
] as const

// ─── Internal helpers ───

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

// ─── Public API ───

/**
 * Create a HEARTH anchor graph from 5 input hashes.
 *
 * The graph is a purely functional data structure — no side effects,
 * no mutable state. graphHash is deterministic for the same input.
 */
export function createAnchorGraph(input: AnchorGraphInput): AnchorGraph {
  const nodes: AnchorNode[] = [
    { id: 'pole_structure', hash: input.structureHash, role: 'project hard constraints' },
    { id: 'pole_void', hash: input.voidShape, role: 'explicit void for emergence' },
    { id: 'cycle_close', hash: input.prevCycleClose, role: 'previous cycle witnessed close' },
    { id: 'cycle_open', hash: input.currentCycleOpen, role: 'current cycle perturbation seed' },
    { id: 'center_belief', hash: input.centerBeliefHash, role: 'founding belief anchor' },
  ]

  const concatenated = CANONICAL_ORDER.map(id => nodes.find(n => n.id === id)!.hash).join(':')
  const graphHash = sha256(concatenated)

  return { nodes, graphHash }
}
