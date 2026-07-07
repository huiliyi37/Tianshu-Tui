import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  classifyChange,
  createGitDiffProvider,
  type DiffProvider,
  type ChangeClass,
} from '../change-classification.js'

// ── Helpers: create fake diff providers from fixed text ───────────

function makeDiff(nameStatus: string, patches: Record<string, string> = {}): DiffProvider {
  return {
    nameStatus: () => nameStatus,
    filePatch: (file: string) => patches[file] ?? '',
  }
}

const patchLine = (s: string) => s

// ── Tests ─────────────────────────────────────────────────────────

describe('change-classification', () => {

  // ── docs-only ──
  test('docs-only: all .md files → docs-only, skipReview + skipVerification', () => {
    const result = classifyChange(['README.md', 'docs/guide.md'], makeDiff(''))
    assert.equal(result.class, 'docs-only')
    assert.equal(result.skipReview, true)
    assert.equal(result.skipVerification, true)
  })

  test('docs-only: .rst and docs/ directory files', () => {
    const result = classifyChange(['docs/manual.rst', 'docs/config.adoc'], makeDiff(''))
    assert.equal(result.class, 'docs-only')
  })

  test('docs-only: test files', () => {
    const result = classifyChange(['src/agent/__tests__/foo.test.ts'], makeDiff(''))
    assert.equal(result.class, 'docs-only')
    assert.equal(result.skipReview, true)
  })

  test('docs-only: JSON config files', () => {
    const result = classifyChange(['package.json', 'tsconfig.json'], makeDiff(''))
    assert.equal(result.class, 'docs-only')
  })

  test('mixed docs + code → NOT docs-only', () => {
    const result = classifyChange(['README.md', 'src/main.ts'], makeDiff(
      'M\tsrc/main.ts',
      { 'src/main.ts': '+console.log("hello")\n' },
    ))
    assert.notEqual(result.class, 'docs-only')
  })

  // ── rename-mechanical (R100) ──
  test('rename-mechanical: git R100 rename, zero content change', () => {
    const result = classifyChange(['src/old.ts', 'src/new.ts'], makeDiff('R100\tsrc/old.ts\tsrc/new.ts'))
    assert.equal(result.class, 'rename-mechanical')
    assert.equal(result.skipReview, true)
    assert.equal(result.skipVerification, true)
  })

  test('rename-mechanical: multiple R100 renames', () => {
    const result = classifyChange(['a/old1.ts', 'a/new1.ts', 'b/old2.ts', 'b/new2.ts'], makeDiff(
      'R100\ta/old1.ts\ta/new1.ts\nR100\tb/old2.ts\tb/new2.ts',
    ))
    assert.equal(result.class, 'rename-mechanical')
  })

  test('rename-mechanical: pre-existing file rename — only the new path is owned', () => {
    // The old path is pre-existing (external) and absent from owned files, but the
    // dirty-scoped name-status still pairs the rename. The new path being the R100
    // target is enough to classify as a pure rename.
    const result = classifyChange(['src/new.ts'], makeDiff('R100\tsrc/old.ts\tsrc/new.ts'))
    assert.equal(result.class, 'rename-mechanical')
    assert.equal(result.skipVerification, true)
  })

  test('not rename-mechanical: owned file has a real change alongside a rename', () => {
    // src/changed.ts is modified (not an R100 endpoint) → must not be treated as
    // a pure rename even though another file is a clean R100 rename.
    const result = classifyChange(['src/new.ts', 'src/changed.ts'], makeDiff(
      'R100\tsrc/old.ts\tsrc/new.ts\nM\tsrc/changed.ts',
      { 'src/changed.ts': patchLine('+const real = compute()\n-const real = 1\n') },
    ))
    assert.notEqual(result.class, 'rename-mechanical')
  })

  // ── rename-mechanical (whitespace/comment only) ──
  test('rename-mechanical: comment-only changes', () => {
    const patch = patchLine('+// updated comment\n-// old comment\n')
    const result = classifyChange(['src/foo.ts'], makeDiff('M\tsrc/foo.ts', { 'src/foo.ts': patch }))
    assert.equal(result.class, 'rename-mechanical')
    assert.equal(result.skipVerification, true)
  })

  test('rename-mechanical: whitespace-only changes', () => {
    const patch = '+  \n-\t\n'
    const result = classifyChange(['src/foo.ts'], makeDiff('M\tsrc/foo.ts', { 'src/foo.ts': patch }))
    assert.equal(result.class, 'rename-mechanical')
  })

  // ── heuristic-rename ──
  test('heuristic-rename: single identifier replacement oldVar → newVar', () => {
    const patch = [
      '+const newVar = 42',
      '-const oldVar = 42',
      '+console.log(newVar)',
      '-console.log(oldVar)',
    ].join('\n')
    const result = classifyChange(['src/foo.ts'], makeDiff('M\tsrc/foo.ts', { 'src/foo.ts': patch }))
    assert.equal(result.class, 'heuristic-rename')
    assert.equal(result.skipReview, true)
    assert.equal(result.skipVerification, false) // still needs verification!
  })

  test('heuristic-rename: consistent across multiple files', () => {
    const patchA = '+newName()\n-oldName()\n'
    const patchB = '+const x = newName\n-const x = oldName\n'
    const result = classifyChange(['src/a.ts', 'src/b.ts'], makeDiff(
      'M\tsrc/a.ts\nM\tsrc/b.ts',
      { 'src/a.ts': patchA, 'src/b.ts': patchB },
    ))
    assert.equal(result.class, 'heuristic-rename')
  })

  // ── ADVERSARIAL SAMPLES (must NOT be classified as safe) ──

  test('ADVERSARIAL: === changed to !== → normal (not heuristic-rename)', () => {
    // === → !== is a logic inversion, not an identifier rename
    const patch = "+if (x !== y)\n-if (x === y)\n"
    const result = classifyChange(['src/logic.ts'], makeDiff('M\tsrc/logic.ts', { 'src/logic.ts': patch }))
    assert.equal(result.class, 'normal')
    assert.equal(result.skipReview, false)
  })

  test('ADVERSARIAL: true → false → normal', () => {
    const patch = '+return false\n-return true\n'
    const result = classifyChange(['src/logic.ts'], makeDiff('M\tsrc/logic.ts', { 'src/logic.ts': patch }))
    assert.equal(result.class, 'normal')
  })

  test('ADVERSARIAL: logic change disguised near a rename', () => {
    // Renames oldVar → newVar but ALSO changes a return value
    const patch = [
      '+const newVar = 99',   // value changed too!
      '-const oldVar = 42',
      '+console.log(newVar)',
      '-console.log(oldVar)',
    ].join('\n')
    const result = classifyChange(['src/foo.ts'], makeDiff('M\tsrc/foo.ts', { 'src/foo.ts': patch }))
    // Should NOT be heuristic-rename because the replacement isn't consistent
    // (oldVar=42 → newVar=99 changes the value, not just the name)
    assert.notEqual(result.class, 'heuristic-rename')
    assert.notEqual(result.class, 'rename-mechanical')
  })

  test('ADVERSARIAL: two different identifier replacements → normal', () => {
    const patch = '+foo()\n-bar()\n+baz()\n-qux()\n'
    const result = classifyChange(['src/logic.ts'], makeDiff('M\tsrc/logic.ts', { 'src/logic.ts': patch }))
    assert.notEqual(result.class, 'heuristic-rename')
  })

  test('ADVERSARIAL: single-char identifier replacement → normal (too short)', () => {
    const patch = '+b + c\n-a + c\n'
    const result = classifyChange(['src/logic.ts'], makeDiff('M\tsrc/logic.ts', { 'src/logic.ts': patch }))
    // a → b is a valid identifier replacement but length < 2, rejected
    assert.notEqual(result.class, 'heuristic-rename')
  })

  // ── normal ──
  test('normal: actual code logic change', () => {
    const patch = '+if (x > 10) {\n-if (x > 5) {\n+  doSomething()\n-  doOther()\n+}\n-}\n'
    const result = classifyChange(['src/logic.ts'], makeDiff('M\tsrc/logic.ts', { 'src/logic.ts': patch }))
    assert.equal(result.class, 'normal')
    assert.equal(result.skipReview, false)
    assert.equal(result.skipVerification, false)
  })

  test('normal: empty files list', () => {
    const result = classifyChange([], makeDiff(''))
    assert.equal(result.class, 'normal')
  })

  // ── mixed docs + rename ──
  test('mixed: docs file + R100 rename → rename-mechanical (both safe)', () => {
    const result = classifyChange(['docs/guide.md', 'src/old.ts', 'src/new.ts'], makeDiff(
      'R100\tsrc/old.ts\tsrc/new.ts',
    ))
    assert.equal(result.class, 'rename-mechanical')
    assert.equal(result.skipVerification, true)
  })

  test('mixed: docs file + actual code change → normal', () => {
    const patch = '+console.log("changed")\n-old code\n'
    const result = classifyChange(['docs/guide.md', 'src/main.ts'], makeDiff(
      'M\tsrc/main.ts',
      { 'src/main.ts': patch },
    ))
    assert.equal(result.class, 'normal')
  })
})

describe('createGitDiffProvider — lazy git partition', () => {
  function tmpRepo(setup: (dir: string, run: (args: string[]) => void) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'gdp-'))
    const run = (args: string[]) => { spawnSync('git', args, { cwd: dir }) }
    run(['init', '-q'])
    run(['config', 'user.email', 't@t']); run(['config', 'user.name', 't'])
    setup(dir, run)
    return dir
  }

  test('no git subprocess runs when neither nameStatus nor filePatch is called (docs-only path)', () => {
    // Point at a non-existent dir: if the provider eagerly shelled out to git
    // there, the constructor would still spawn. We assert laziness by never
    // touching the diff methods and confirming construction is side-effect free.
    let provider: DiffProvider | undefined
    assert.doesNotThrow(() => {
      provider = createGitDiffProvider('/nonexistent-dir-xyz', ['README.md', 'src/a.ts'])
    })
    assert.ok(provider)
    // classifyChange on docs-only never calls into the provider:
    const result = classifyChange(['README.md'], provider!)
    assert.equal(result.class, 'docs-only')
  })

  test('partitions tracked vs untracked via a single ls-files; untracked filePatch is empty', () => {
    const dir = tmpRepo((d, run) => {
      mkdirSync(join(d, 'src'), { recursive: true })
      writeFileSync(join(d, 'src/a.ts'), 'const x = 1\n')
      run(['add', '.']); run(['commit', '-qm', 'base'])
      writeFileSync(join(d, 'src/a.ts'), 'const x = 2\n')   // tracked, modified
      writeFileSync(join(d, 'src/new.ts'), 'const y = 1\n') // untracked
    })
    try {
      const provider = createGitDiffProvider(dir, ['src/a.ts', 'src/new.ts'])
      assert.equal(provider.filePatch('src/new.ts'), '', 'untracked file has no diff')
      assert.match(provider.filePatch('src/a.ts'), /const x = 2/, 'tracked file diff returned')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('detects a real R100 rename via the dirty-set scope (old path not owned)', () => {
    const dir = tmpRepo((d, run) => {
      mkdirSync(join(d, 'src'), { recursive: true })
      writeFileSync(join(d, 'src/old.ts'), 'export const x = 1\n')
      run(['add', '.']); run(['commit', '-qm', 'base'])
      run(['mv', 'src/old.ts', 'src/new.ts']) // staged rename, byte-identical
    })
    try {
      // Owned files contain only the new path; the dirty set carries both endpoints
      // so `git -M` can pair them into an R100 rename.
      const provider = createGitDiffProvider(dir, ['src/new.ts'], ['src/old.ts', 'src/new.ts'])
      const result = classifyChange(['src/new.ts'], provider)
      assert.equal(result.class, 'rename-mechanical', 'pure file rename detected end-to-end')
      assert.equal(result.skipVerification, true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('nameStatus is memoized — repeated calls return the same result', () => {
    const dir = tmpRepo((d, run) => {
      mkdirSync(join(d, 'src'), { recursive: true })
      writeFileSync(join(d, 'src/a.ts'), 'const x = 1\n')
      run(['add', '.']); run(['commit', '-qm', 'base'])
      writeFileSync(join(d, 'src/a.ts'), 'const x = 2\n')
    })
    try {
      const provider = createGitDiffProvider(dir, ['src/a.ts'])
      const first = provider.nameStatus()
      assert.match(first, /M\tsrc\/a\.ts/)
      assert.equal(provider.nameStatus(), first, 'second call returns cached value')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
