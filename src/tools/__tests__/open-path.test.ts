import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenPathCommand, buildRevealCommand, OPEN_PATH_TOOL } from '../open-path.js'

describe('open_path', () => {
  it('builds Windows opener via PowerShell Start-Process -LiteralPath (no cmd.exe metachar reinterpretation)', () => {
    const target = 'C:\\Users\\Honglin   zhang\\Desktop\\天枢-logo.svg'
    const command = buildOpenPathCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    // 路径作为单引号字面串嵌入 -LiteralPath，不再走 cmd 二次解析。
    assert.deepEqual(command.args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Start-Process -LiteralPath '${target}'`,
    ])
    // cmd.exe 不应再被使用。
    assert.notEqual(command.cmd, 'cmd.exe')
  })

  it('neutralizes cmd metacharacters and single quotes in Windows paths', () => {
    // 含 & | % ^ 的合法路径必须能开（不误杀），且元字符不被解释（不注入）。
    const target = "C:\\R&D\\report|v2\\100%^win\\o'brien.txt"
    const command = buildOpenPathCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    const literalArg = command.args[command.args.length - 1]
    // 单引号字面串：内嵌单引号被双写转义，& | % ^ 原样保留为字面量。
    assert.equal(literalArg, "Start-Process -LiteralPath 'C:\\R&D\\report|v2\\100%^win\\o''brien.txt'")
  })

  it('builds macOS opener with path as a separate argument', () => {
    const target = '/Users/banxia/Desktop/天枢 logo.svg'
    const command = buildOpenPathCommand(target, 'darwin')

    assert.equal(command.cmd, 'open')
    assert.deepEqual(command.args, [target])
  })

  it('builds Linux opener with path as a separate argument', () => {
    const target = '/home/user/桌面/天枢 logo.svg'
    const command = buildOpenPathCommand(target, 'linux')

    assert.equal(command.cmd, 'xdg-open')
    assert.deepEqual(command.args, [target])
  })

  it('builds Windows reveal command via explorer /select (PowerShell, no cmd metachar reinterpretation)', () => {
    const target = 'C:\\Users\\Honglin   zhang\\Desktop\\天枢-logo.svg'
    const command = buildRevealCommand(target, 'win32')

    assert.equal(command.cmd, 'powershell.exe')
    assert.deepEqual(command.args, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `explorer /select,'${target}'`,
    ])
  })

  it('neutralizes single quotes in Windows reveal paths', () => {
    const target = "C:\\R&D\\o'brien.txt"
    const command = buildRevealCommand(target, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, "explorer /select,'C:\\R&D\\o''brien.txt'")
  })

  it('normalizes forward slashes to backslashes in Windows reveal paths', () => {
    // 前端 toAbsolute 在 cwd 含 '/' 时会拼出 'C:/Users/.../file.ts'。
    // explorer 对正斜杠路径静默失败——必须归一为反斜杠。
    const fwdSlash = 'C:/Users/test/project/src/index.ts'
    const backslash = 'C:\\Users\\test\\project\\src\\index.ts'
    const command = buildRevealCommand(fwdSlash, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, `explorer /select,'${backslash}'`)
  })

  it('normalizes forward slashes to backslashes in Windows open paths', () => {
    const fwdSlash = 'C:/Users/test/R&D/report.md'
    const backslash = 'C:\\Users\\test\\R&D\\report.md'
    const command = buildOpenPathCommand(fwdSlash, 'win32')

    const literalArg = command.args[command.args.length - 1]
    assert.equal(literalArg, `Start-Process -LiteralPath '${backslash}'`)
  })

  it('builds macOS reveal command with open -R', () => {
    const target = '/Users/banxia/Desktop/天枢 logo.svg'
    const command = buildRevealCommand(target, 'darwin')

    assert.equal(command.cmd, 'open')
    assert.deepEqual(command.args, ['-R', target])
  })

  it('builds Linux reveal command by opening the parent directory', () => {
    const target = '/home/user/桌面/天枢 logo.svg'
    const command = buildRevealCommand(target, 'linux')

    assert.equal(command.cmd, 'xdg-open')
    assert.deepEqual(command.args, ['/home/user/桌面'])
  })

  it('returns error instead of spawning when path does not exist', async () => {
    const result = await OPEN_PATH_TOOL.execute({
      cwd: process.cwd(),
      toolUseId: 'tu-open',
      input: { path: '/definitely/not/existing/tianshu-logo.svg' },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /path does not exist/)
  })
})
