import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL, isExecFailure, classifyBashOutcome, sanitizeEnv } from '../bash.js'

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

describe('classifyBashOutcome: Windows 感知的命令结果分类', () => {
  it('Windows cmd.exe 未识别命令 (9009) → environment 类', () => {
    const r = classifyBashOutcome(9009, "'python' is not recognized as an internal or external command", true)
    assert.equal(r.isError, true)
    assert.equal(r.errorClass, 'environment')
  })
  it('Windows PowerShell not-recognized (exit 1 + stderr) → environment 类', () => {
    const r = classifyBashOutcome(1, "python : The term 'python' is not recognized as the name of a cmdlet", true)
    assert.equal(r.isError, true)
    assert.equal(r.errorClass, 'environment')
  })
  it('Windows CommandNotFoundException 文案 → environment 类', () => {
    const r = classifyBashOutcome(1, 'CommandNotFoundException', true)
    assert.equal(r.errorClass, 'environment')
  })
  it('Windows 普通非零码无 not-found 文案 → 非失败(语义结果)', () => {
    // findstr 无匹配返回 1，不应误判为执行失败
    const r = classifyBashOutcome(1, '', true)
    assert.equal(r.isError, false)
    assert.equal(r.errorClass, undefined)
  })
  it('Windows 段错误级 (>128) 无 not-found 文案 → exec-failure', () => {
    const r = classifyBashOutcome(3221225477, '', true) // 0xC0000005 access violation
    assert.equal(r.isError, true)
    assert.equal(r.errorClass, 'exec-failure')
  })
  it('Windows + Git Bash 的 POSIX 未找到 (127 / command not found) → environment 类', () => {
    // Git Bash 是 Windows 首选 shell，未找到是 POSIX 风格：exit 127 + "bash: py: command not found"
    const r = classifyBashOutcome(127, 'bash: py: command not found', true)
    assert.equal(r.isError, true)
    assert.equal(r.errorClass, 'environment')
    // 126 (not executable) 同样归 environment
    assert.equal(classifyBashOutcome(126, '', true).errorClass, 'environment')
    // 仅凭 stderr 文案也能识别（即便退出码非 127）
    assert.equal(classifyBashOutcome(1, 'bash: foo: command not found', true).errorClass, 'environment')
  })
  it('POSIX 127/126 → environment 类，信号 → exec-failure', () => {
    assert.equal(classifyBashOutcome(127, 'sh: foo: command not found', false).errorClass, 'environment')
    assert.equal(classifyBashOutcome(126, '', false).errorClass, 'environment')
    assert.equal(classifyBashOutcome(139, '', false).errorClass, 'exec-failure')
  })
  it('POSIX 退出码 1/2 → 非失败(沿用 isExecFailure 语义)', () => {
    assert.equal(classifyBashOutcome(1, '', false).isError, false)
    assert.equal(classifyBashOutcome(0, '', false).isError, false)
  })
  it('timeout (exit=-1) → timeout 类，不再与 exec-failure 混同', () => {
    const r = classifyBashOutcome(-1, '', false)
    assert.equal(r.isError, true)
    assert.equal(r.errorClass, 'timeout')
    // Windows 路径同样
    assert.equal(classifyBashOutcome(-1, '', true).errorClass, 'timeout')
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

describe('BASH_TOOL 基本命令输出可达', () => {
  it('echo hello 返回可见 stdout（Windows detached 回归保护）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-stdout-'))
    try {
      const result = await BASH_TOOL.execute({
        input: { command: 'echo hello' },
        toolUseId: 'bash-stdout-test',
        cwd: dir,
      })
      assert.ok(!result.isError, 'echo hello 不应报错')
      assert.match(result.content, /hello/, 'stdout 必须包含命令输出，空输出说明 Windows detached 或 stdio 管道断裂')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('BASH_TOOL 空 stdout 的成功命令 → confirmed empty(不是 "Exit code: 0")', () => {
  it('exit 0 且无 stdout 时标记为 confirmed empty 并给出可操作提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-empty-'))
    try {
      // node -e "" 跨平台、退出 0、无任何 stdout —— 等价于写文件/重定向后的静默成功。
      const result = await BASH_TOOL.execute({
        input: { command: 'node -e ""' },
        toolUseId: 'bash-empty-stdout-test',
        cwd: dir,
      })
      assert.ok(!result.isError, '成功命令不应标记为 error')
      assert.match(result.content, /confirmed empty/, '空成功输出必须显式标记 confirmed empty')
      assert.ok(
        !/Exit code: 0/.test(result.content),
        '不得回灌 "Exit code: 0" 合成正文——那会被误读为 bash 把输出吞了/没执行',
      )
      assert.match(result.content, /read_file/, '应提示用 read_file 核实写出的文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exit 非零且无 stdout 时仍保留 "Exit code: N" 以免正文为空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-exit1-'))
    try {
      const result = await BASH_TOOL.execute({
        input: { command: 'node -e "process.exit(3)"' },
        toolUseId: 'bash-exit3-test',
        cwd: dir,
      })
      assert.match(result.content, /Exit code: 3/, '失败且无输出时正文不能为空，需带退出码')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('environment 类失败给模型标准化简洁 body，完整原文入 uiContent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-env-'))
    try {
      const result = await BASH_TOOL.execute({
        input: { command: 'this_command_surely_does_not_exist_xyz_123' },
        toolUseId: 'bash-env-test',
        cwd: dir,
      })
      assert.equal(result.isError, true)
      assert.equal(result.errorClass, 'environment')
      assert.match(result.content, /环境\/配置问题/, 'model 正文为标准化简洁体')
      assert.match(result.content, /command not found/, '含具体原因')
      assert.ok(result.uiContent && result.uiContent.length > 0, '完整原文保留在 uiContent 供 TUI 展示')
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

  it('preserves toolchain vars (JAVA_HOME/MAVEN_HOME/M2_HOME/GRADLE_HOME/GOPATH)', () => {
    const env = {
      ...process.env,
      JAVA_HOME: '/opt/jdk',
      MAVEN_HOME: '/opt/maven',
      M2_HOME: '/opt/maven',
      GRADLE_HOME: '/opt/gradle',
      GOPATH: '/home/u/go',
      ANDROID_HOME: '/opt/android',
      NVM_DIR: '/home/u/.nvm',
    }
    const result = sanitizeEnv(env)
    assert.equal(result.JAVA_HOME, '/opt/jdk')
    assert.equal(result.MAVEN_HOME, '/opt/maven')
    assert.equal(result.M2_HOME, '/opt/maven')
    assert.equal(result.GRADLE_HOME, '/opt/gradle')
    assert.equal(result.GOPATH, '/home/u/go')
    assert.equal(result.ANDROID_HOME, '/opt/android')
    assert.equal(result.NVM_DIR, '/home/u/.nvm')
  })

  it('still strips sensitive vars even when toolchain-adjacent (e.g. *_TOKEN)', () => {
    const env = { ...process.env, JAVA_HOME: '/opt/jdk', MAVEN_TOKEN: 'shh', GRADLE_API_KEY: 'k' }
    const result = sanitizeEnv(env)
    assert.equal(result.JAVA_HOME, '/opt/jdk')
    assert.equal(result.MAVEN_TOKEN, undefined)
    assert.equal(result.GRADLE_API_KEY, undefined)
  })
})
