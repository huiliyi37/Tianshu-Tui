import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bashCommandTarget, classifyBashCommandActivity, toolTargetFromInput } from '../tool-target.js'

describe('bashCommandTarget', () => {
  it('剥离 cd <path> && 样板后再截断——根因场景', () => {
    const cmd = 'cd /Users/banxia/app/deepseek-tui/opencode-tui && npx tsc --noEmit'
    assert.equal(bashCommandTarget(cmd), 'npx tsc --noEmit')
  })

  it('剥离带引号路径的 cd 样板', () => {
    assert.equal(bashCommandTarget('cd "/path with spaces/repo" && npm test'), 'npm test')
    assert.equal(bashCommandTarget("cd '/tmp/x' && ls"), 'ls')
  })

  it('连续多个 cd 段全部剥离', () => {
    assert.equal(bashCommandTarget('cd /a && cd /b && make'), 'make')
  })

  it('纯 cd 命令（无后续段）原样保留——cd 本身就是目标', () => {
    assert.equal(bashCommandTarget('cd /some/dir'), 'cd /some/dir')
  })

  it('剥离后仍超 50 字符则截断到 50', () => {
    const long = 'cd /repo && ' + 'x'.repeat(80)
    assert.equal(bashCommandTarget(long).length, 50)
    assert.equal(bashCommandTarget(long), 'x'.repeat(50))
  })

  it('无 cd 前缀的命令行为不变（纯截断）', () => {
    assert.equal(bashCommandTarget('npm run build'), 'npm run build')
    assert.equal(bashCommandTarget('y'.repeat(80)), 'y'.repeat(50))
  })
})

describe('classifyBashCommandActivity', () => {
  it('recognizes only conservative single-command read probes', () => {
    const commands = [
      "grep -n 'needle' src/a.ts",
      'rg needle src',
      "sed -n '1,20p' src/a.ts",
      'git log --oneline -6',
      'git diff package.json',
      'cd /repo && git status --short',
      'rtk grep needle src/a.ts',
      'echo $HOME',
      'sort input.txt',
    ]
    for (const command of commands) {
      assert.equal(classifyBashCommandActivity(command), 'readonly', command)
    }
  })

  it('fails closed for shell composition, redirection, and substitution', () => {
    const commands = [
      'grep foo input.txt && touch changed.txt',
      'grep foo input.txt > report.txt',
      'grep foo input.txt | tee report.txt',
      'grep "$(touch changed.txt)" input.txt',
      'sort -o report.txt input.txt',
      "sed -n '1p' -i input.txt",
      'git diff --output=report.txt',
    ]
    for (const command of commands) {
      assert.equal(classifyBashCommandActivity(command), 'productive', command)
    }
  })

  it('does not whitelist interpreters, arbitrary scripts, or mutable subcommands', () => {
    const commands = [
      'python3 -c "open(\'x\',\'w\').write(\'bad\')"',
      'node -e "require(\'fs\').writeFileSync(\'x\',\'bad\')"',
      'find . -name "*.tmp" -delete',
      'git branch -D feature',
      'git remote set-url origin https://example.invalid/repo',
      'env rm -rf build',
      'npx tsx scripts/mutate-state.ts',
    ]
    for (const command of commands) {
      assert.equal(classifyBashCommandActivity(command), 'productive', command)
    }
  })

  it('requires complete command tokens and rejects sort output variants', () => {
    const commands = [
      'grep-malicious --write',
      'git diff-malicious --write',
      'sort\t-o report.txt input.txt',
      'sort -oreport.txt input.txt',
      'sort --compress-program=touch input.txt',
      'rg --pre touch needle src',
      'git grep --open-files-in-pager=touch needle',
    ]
    for (const command of commands) {
      assert.equal(classifyBashCommandActivity(command), 'productive', command)
    }
  })

  it('sees write suffixes beyond the 50-character history target', () => {
    const command = `grep needle ${'a'.repeat(60)} && touch changed.txt`
    assert.equal(bashCommandTarget(command).includes('touch'), false)
    assert.equal(classifyBashCommandActivity(command), 'productive')
  })
})

describe('toolTargetFromInput', () => {
  it('file_path > path > command 优先级保持', () => {
    assert.equal(toolTargetFromInput('edit_file', { file_path: 'a.ts', command: 'x' }), 'a.ts')
    assert.equal(toolTargetFromInput('grep', { path: 'src/' }), 'src/')
    assert.equal(toolTargetFromInput('bash', { command: 'cd /repo && npm test' }), 'npm test')
    assert.equal(toolTargetFromInput('todo', {}), 'todo')
  })

  it('视觉工具的 action 成为语义 target（2026-07-15）', () => {
    assert.equal(toolTargetFromInput('browser_debug', { action: 'screenshot' }), 'screenshot')
    assert.equal(
      toolTargetFromInput('browser_debug', { action: 'navigate', url: 'http://localhost:3000' }),
      'navigate http://localhost:3000',
    )
    assert.equal(toolTargetFromInput('computer_use', { action: 'snapshot', app: 'Finder' }), 'snapshot Finder')
  })

  it('非视觉工具的 action 字段不改变 target（git/plan 语义不受影响）', () => {
    assert.equal(toolTargetFromInput('git', { action: 'status' }), 'git')
    assert.equal(toolTargetFromInput('plan', { action: 'submit' }), 'plan')
  })
})
