import test from 'node:test'
import assert from 'node:assert/strict'
import {
  claimProposalFromAnchor,
  createClaimFromProposal,
  isPromptEligibleClaim,
  renderActiveClaimsBlock,
  type ContextClaim,
} from '../claims.js'
import type { ContextAnchor } from '../types.js'

test('converts a user constraint anchor into a session claim proposal with evidence', () => {
  const anchor: ContextAnchor = {
    kind: 'user_constraint',
    text: 'CRITICAL: do not call tools for this answer',
    sourceRoundIndex: 4,
    salience: 6,
  }

  const proposal = claimProposalFromAnchor(anchor, {
    actor: 'user',
    sessionId: 'session-123',
    turn: 4,
    eventId: 'turn-4:user-input',
    createdAt: 1_700_000_000_000,
  })

  assert.equal(proposal.kind, 'user_constraint')
  assert.equal(proposal.scope, 'session')
  assert.equal(proposal.text, 'CRITICAL: do not call tools for this answer')
  assert.equal(proposal.confidence, 0.9)
  assert.equal(proposal.fitness, 6)
  assert.deepEqual(proposal.tags, ['anchor', 'user_constraint'])
  assert.equal(proposal.evidence[0]?.kind, 'user_message')
  assert.equal(proposal.evidence[0]?.summary, 'CRITICAL: do not call tools for this answer')
})

test('creates deterministic claim ids from proposal content and source', () => {
  const anchor: ContextAnchor = {
    kind: 'decision',
    text: 'Use JSONL before SQLite',
    sourceRoundIndex: 2,
    salience: 4,
  }
  const proposal = claimProposalFromAnchor(anchor, {
    actor: 'assistant',
    sessionId: 'session-123',
    turn: 2,
    eventId: 'decision-2',
    createdAt: 1_700_000_000_000,
  })

  const a = createClaimFromProposal(proposal)
  const b = createClaimFromProposal(proposal)

  assert.equal(a.id, b.id)
  assert.equal(a.status, 'active')
  assert.equal(a.lastUsedAt, 1_700_000_000_000)
})


test('claim ids are semantic within a session and ignore event-specific evidence', () => {
  const anchor: ContextAnchor = {
    kind: 'user_constraint',
    text: 'Always run tests before done',
    sourceRoundIndex: 1,
    salience: 5,
  }

  const first = createClaimFromProposal(claimProposalFromAnchor(anchor, {
    actor: 'user',
    sessionId: 'session-123',
    turn: 1,
    eventId: 'turn-1:user-input',
    createdAt: 1,
  }))
  const repeated = createClaimFromProposal(claimProposalFromAnchor({ ...anchor, text: '  always   run tests BEFORE done  ' }, {
    actor: 'user',
    sessionId: 'session-123',
    turn: 2,
    eventId: 'turn-2:user-input',
    createdAt: 2,
  }))
  const otherSession = createClaimFromProposal(claimProposalFromAnchor(anchor, {
    actor: 'user',
    sessionId: 'session-456',
    turn: 1,
    eventId: 'turn-1:user-input',
    createdAt: 1,
  }))

  assert.equal(first.id, repeated.id)
  assert.notEqual(first.id, otherSession.id)
})

test('only active durable candidate and durable claims are prompt eligible', () => {
  const base: ContextClaim = {
    id: 'c_active',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Keep claim projection small',
    confidence: 0.9,
    fitness: 6,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Keep claim projection small', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
  }

  assert.equal(isPromptEligibleClaim(base), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_candidate', status: 'durable_candidate' }), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_durable', status: 'durable' }), true)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_stale', status: 'stale' }), false)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_conflicted', status: 'conflicted' }), false)
  assert.equal(isPromptEligibleClaim({ ...base, id: 'c_quarantined', status: 'quarantined' }), false)
})


test('expired claims are not prompt eligible', () => {
  const claim: ContextClaim = {
    id: 'c_expired',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Temporary constraint',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Temporary constraint', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    expiresAt: 10,
    tags: ['anchor'],
  }

  assert.equal(isPromptEligibleClaim(claim, 9), true)
  assert.equal(isPromptEligibleClaim(claim, 10), false)
})

test('renders only prompt eligible claims and escapes XML-sensitive text', () => {
  const claim: ContextClaim = {
    id: 'c_xml',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Use <claims> & never trust "raw" XML',
    confidence: 0.92,
    fitness: 7,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Use <claims>', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
  }

  const stale: ContextClaim = { ...claim, id: 'c_stale', status: 'stale', text: 'stale text' }
  const block = renderActiveClaimsBlock([stale, claim])

  assert.match(block, /<active-claims count="1">/)
  assert.match(block, /<claim id="c_xml" kind="user_constraint" scope="session" confidence="0.92" evidence="e1">/)
  assert.match(block, /Use &lt;claims&gt; &amp; never trust &quot;raw&quot; XML/)
  assert.doesNotMatch(block, /stale text/)
})

test('renderActiveClaimsBlock caps at MAX_PROMPT_CLAIMS and sorts by fitness', () => {
  const claims: ContextClaim[] = Array.from({ length: 30 }, (_, i) => ({
    id: `c_${i}`,
    kind: 'file_observation' as const,
    scope: 'session' as const,
    status: 'active' as const,
    text: `Claim ${i}`,
    confidence: 0.7,
    fitness: i,
    source: { actor: 'tool' as const, sessionId: 's', turn: 1, eventId: `e${i}` },
    evidence: [{ id: `ev${i}`, kind: 'tool_result' as const, summary: `Claim ${i}`, createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
  }))

  const block = renderActiveClaimsBlock(claims)
  const claimCount = (block.match(/<claim /g) ?? []).length
  assert.ok(claimCount <= 20, `expected at most 20 claims, got ${claimCount}`)
  // Highest fitness claims should be included
  assert.ok(block.includes('Claim 29'))
  assert.ok(!block.includes('Claim 0'))
})
