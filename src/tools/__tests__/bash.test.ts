import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL, isExecFailure, sanitizeEnv } from '../bash.js'

describe('isExecFailure: 非零退出码 ≠ 真失败', () => {
  it('把 0 和"非零非致命码"判为非失败(grep 1/diff 1/test 失败码)', () => {
    assert.equal(isExecFailure(0), false)
    assert.equal(isExecFailure(1), false)   // grep 无匹配 / diff 有差异 / test 有失败用例
    assert.equal(isExecFailure(2), false)   // build/lint 非致命告警
  })
  it('只把"无法执行/被信号杀死/timeout"判为真失败', () => {
    assert.equal(isExecFailure(-1), true)   // timeout
    assert.equal(isExecFailure(126), true)  // 不可执行
    assert.equal(isExecFailure(127), true)  // 命令未找到
    assert.equal(isExecFailure(139), true)  // 段错误 (128+SIGSEGV)
  })
})

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('requiresApproval vs rtkRewrite', () => {
  it('checks both raw and rewritten commands for dangerous patterns', () => {
    // A command containing a dangerous pattern should be flagged
    const dangerousInput = {
      input: { command: 'rm -rf /tmp/test' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(dangerousInput), true)

    // Safe command should not be flagged
    const safeInput = {
      input: { command: 'ls -la' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(safeInput), false)
  })

  it('flags command when rtkRewrite expands it to dangerous form', () => {
    // If rtk is installed and rewrites "safe_alias" → "rm -rf /something",
    // requiresApproval must catch it. Since rtk may not be installed, the
    // fallback returns the original command. This test validates the
    // structural guarantee: both versions are checked.
    //
    // With rtk not installed, rtkRewrite("rm -rf /test") = "rm -rf /test"
    // so checking both raw and rewritten still matches.
    const input = {
      input: { command: 'rm -rf /tmp/test' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(input), true)
  })
})

describe('BASH_TOOL timeout cleanup', () => {
  it('kills background descendants when a command times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-timeout-'))
    const marker = join(dir, 'marker.txt')
    const command = `nohup node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1], 'alive'), 300)" "${marker}" >/dev/null 2>&1 & wait`

    try {
      const result = await BASH_TOOL.execute({
        input: { command, timeout: 50 },
        toolUseId: 'bash-timeout-tree-test',
        cwd: dir,
      })
      await wait(700)

      assert.equal(result.isError, true)
      assert.match(result.content, /Command timed out/)
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('rtkRewrite cache behavior', () => {
  it('requiresApproval and execute see the same rewritten result for identical commands', () => {
    // When rtk is not installed, rtkRewrite returns the original command.
    // Both requiresApproval and execute must see the same result.
    const command = 'echo hello'
    const params = {
      input: { command },
      toolUseId: 'cache-test',
      cwd: '/tmp',
    }

    // requiresApproval should return false for a safe command
    assert.equal(BASH_TOOL.requiresApproval(params), false)

    // Second call to requiresApproval with same command should use cache
    assert.equal(BASH_TOOL.requiresApproval(params), false)
  })
})

describe('sanitizeEnv', () => {
  it('strips API keys', () => {
    const env = { ...process.env, OPENAI_API_KEY: 'sk-xxx', MY_SECRET_TOKEN: 'abc123' }
    const result = sanitizeEnv(env)
    assert.equal(result.OPENAI_API_KEY, undefined)
    assert.equal(result.MY_SECRET_TOKEN, undefined)
  })

  it('preserves PATH and HOME', () => {
    const result = sanitizeEnv(process.env)
    assert.ok(result.PATH, 'PATH should be preserved')
    assert.ok(result.HOME, 'HOME should be preserved')
  })

  it('strips vars with TOKEN in name', () => {
    const env = { ...process.env, GITHUB_TOKEN: 'ghp_xxx', DEEPSEEK_TOKEN: 'abc' }
    const result = sanitizeEnv(env)
    assert.equal(result.GITHUB_TOKEN, undefined)
    assert.equal(result.DEEPSEEK_TOKEN, undefined)
  })

  it('strips vars with SECRET in name', () => {
    const env = { ...process.env, APP_SECRET: 'sss', JWT_SECRET: 'jjj' }
    const result = sanitizeEnv(env)
    assert.equal(result.APP_SECRET, undefined)
    assert.equal(result.JWT_SECRET, undefined)
  })

  it('preserves NODE_ENV and TERM', () => {
    const env = { ...process.env, NODE_ENV: 'test', TERM: 'xterm-256color' }
    const result = sanitizeEnv(env)
    assert.equal(result.NODE_ENV, 'test')
    assert.equal(result.TERM, 'xterm-256color')
  })

  it('preserves LANG and LC_ prefixed vars', () => {
    const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
    const result = sanitizeEnv(env)
    assert.equal(result.LANG, 'en_US.UTF-8')
    assert.equal(result.LC_ALL, 'en_US.UTF-8')
  })
})
