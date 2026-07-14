import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeAnswers,
  draftToAnswer,
  type AskAnswerDraft,
  type AskUserQuestionItem,
} from '../ask-user-question.js'

const empty = (): AskAnswerDraft => ({
  selected: [],
  otherSelected: false,
  otherText: '',
  skipped: false,
})

describe('composeAnswers (desktop QuestionCard parity)', () => {
  it('single question returns bare answer text', () => {
    const questions: AskUserQuestionItem[] = [{
      id: 'q1', prompt: 'Which approach?', options: ['A', 'B'], allowMultiple: false,
    }]
    const drafts: AskAnswerDraft[] = [{ ...empty(), selected: [1] }]
    assert.equal(composeAnswers(questions, drafts), 'B')
  })

  it('multi-question joins as prompt → answer lines', () => {
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', prompt: 'Fork?', options: ['Yes', 'No'], allowMultiple: false },
      { id: 'q2', prompt: 'Goal?', options: ['Replace', 'Side-by-side'], allowMultiple: false },
    ]
    const drafts: AskAnswerDraft[] = [
      { ...empty(), selected: [0] },
      { ...empty(), selected: [1] },
    ]
    assert.equal(
      composeAnswers(questions, drafts),
      'Fork? → Yes\nGoal? → Side-by-side',
    )
  })

  it('multi-select joins options with Chinese semicolon', () => {
    const draft: AskAnswerDraft = { ...empty(), selected: [0, 2] }
    assert.equal(draftToAnswer(draft, ['Alpha', 'Beta', 'Gamma']), 'Alpha；Gamma')
  })

  it('other text appends when otherSelected', () => {
    const draft: AskAnswerDraft = {
      ...empty(), selected: [0], otherSelected: true, otherText: 'custom path',
    }
    assert.equal(draftToAnswer(draft, ['Opt1']), 'Opt1；custom path')
  })

  it('all skipped returns the skipped-all label', () => {
    const questions: AskUserQuestionItem[] = [
      { id: 'q1', prompt: 'A?', options: ['1'], allowMultiple: false },
      { id: 'q2', prompt: 'B?', options: ['2'], allowMultiple: false },
    ]
    const drafts: AskAnswerDraft[] = [
      { ...empty(), skipped: true },
      { ...empty(), skipped: true },
    ]
    assert.equal(composeAnswers(questions, drafts), '(skipped all questions)')
    assert.equal(composeAnswers(questions, drafts, '已全部跳过'), '已全部跳过')
  })
})
