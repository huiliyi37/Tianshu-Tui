import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAntibodyProposal } from '../antibody.js'
import type { ClassifiedFailure } from '../../agent/failure-classifier.js'

describe('createAntibodyProposal', () => {
  it('creates failure_pattern claim from classified failure', () => {
    const failure: ClassifiedFailure = {
      class: 'type_error',
      suggestion: 'Fix type annotation or interface. Do not change business logic.',
      confidence: 0.9,
      retryable: false,
    }

    const proposal = createAntibodyProposal(failure, {
      toolName: 'bash',
      command: 'npx tsc --noEmit',
      sessionId: 'session-1',
      turn: 5,
      eventId: 'turn-5:bash:tsc',
    })

    assert.equal(proposal.kind, 'failure_pattern')
    assert.equal(proposal.scope, 'session')
    assert.ok(proposal.text.includes('type_error'))
    assert.ok(proposal.text.includes('Fix type annotation'))
    assert.equal(proposal.confidence, 0.9)
    assert.equal(proposal.evidence[0]?.kind, 'tool_result')
    assert.deepEqual(proposal.tags, ['antibody', 'type_error'])
  })

  it('retryable failures get lower fitness', () => {
    const retryable: ClassifiedFailure = {
      class: 'timeout',
      suggestion: 'Check for infinite loops.',
      confidence: 0.8,
      retryable: true,
    }

    const proposal = createAntibodyProposal(retryable, {
      toolName: 'bash',
      command: 'npm test',
      sessionId: 'session-1',
      turn: 3,
      eventId: 'turn-3:bash:test',
    })

    assert.equal(proposal.fitness, 2)
  })

  it('non-retryable failures get higher fitness', () => {
    const nonRetryable: ClassifiedFailure = {
      class: 'module_resolution',
      suggestion: 'Check import path.',
      confidence: 0.9,
      retryable: false,
    }

    const proposal = createAntibodyProposal(nonRetryable, {
      toolName: 'bash',
      command: 'npx tsc --noEmit',
      sessionId: 'session-1',
      turn: 4,
      eventId: 'turn-4:bash:tsc',
    })

    assert.equal(proposal.fitness, 5)
  })
})
