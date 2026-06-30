import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GitignoreFilter } from '../gitignore.js'

describe('GitignoreFilter', () => {
  it('matches Windows-style relative paths against slash-based ignore patterns', () => {
    const filter = new GitignoreFilter('C:\\repo', ['dist/', 'src/generated/*.ts'])

    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\dist\\bundle.js'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\generated\\api.ts'), true)
    assert.equal(filter.isIgnored('C:\\repo', 'C:\\repo\\src\\handwritten\\api.ts'), false)
  })

  it('does NOT apply gitignore to paths outside the project tree', () => {
    // .rivet is in .gitignore, but ~/.rivet/sessions/ is outside the project
    const filter = new GitignoreFilter('/Users/me/project', ['.rivet', 'node_modules'])

    assert.equal(
      filter.isIgnored('/Users/me/project', '/Users/me/project/.rivet/knowledge/memory.jsonl'),
      true,
      'in-project .rivet paths should still be gitignored',
    )
    // Cross-platform: any absolute path whose prefix differs from cwd
    // must not be blocked, regardless of OS path conventions.
    assert.equal(
      filter.isIgnored('/Users/me/project', '/Users/me/.rivet/sessions/some-slug/session.jsonl'),
      false,
      'OUTSIDE-project paths should NOT be gitignored even if pattern matches',
    )
    assert.equal(
      filter.isIgnored('/home/me/project', '/home/me/.rivet/sessions/x.jsonl'),
      false,
      'different-home outside-project paths should NOT be blocked',
    )
  })
})
