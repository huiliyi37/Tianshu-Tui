import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { denoiseWindowsError } from '../powershell-filter.js'

describe('denoiseWindowsError: PowerShell/cmd 错误降噪', () => {
  it('成功输出 (exit 0) 原样返回，不改一字', () => {
    const out = 'line1\nline2\n+ noise-looking but exit 0'
    assert.equal(denoiseWindowsError(out, { exitCode: 0, command: 'echo hi' }), out)
  })

  it('剥离 CategoryInfo / FullyQualifiedErrorId / At line / 脱字符行', () => {
    const raw = [
      "python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'At line:1 char:1',
      '+ python --version',
      '+ ~~~~~~',
      '    + CategoryInfo          : ObjectNotFound: (python:String) [], CommandNotFoundException',
      '    + FullyQualifiedErrorId : CommandNotFoundException',
    ].join('\n')
    const out = denoiseWindowsError(raw, { exitCode: 1, errorClass: 'environment', command: 'python --version' })
    assert.ok(!out.includes('CategoryInfo'), '应剥离 CategoryInfo')
    assert.ok(!out.includes('FullyQualifiedErrorId'), '应剥离 FullyQualifiedErrorId')
    assert.ok(!out.includes('At line:1 char:1'), '应剥离位置标记')
    assert.ok(!out.includes('~~~~~~'), '应剥离脱字符行')
    assert.ok(out.includes('is not recognized'), '保留核心消息')
  })

  it('environment 类前置恢复提示，python → 指向 py', () => {
    const raw = "python : The term 'python' is not recognized as the name of a cmdlet"
    const out = denoiseWindowsError(raw, { exitCode: 1, errorClass: 'environment', command: 'python --version' })
    assert.ok(out.startsWith('命令未找到'), '应前置恢复提示')
    assert.ok(out.includes('py'), '应指向 py launcher')
    assert.ok(out.includes('不要重试'), '应劝阻盲目重试')
  })

  it('cmd.exe 风格 not-recognized 也能提取命令名给提示', () => {
    const raw = "'foobar' is not recognized as an internal or external command,\noperable program or batch file."
    const out = denoiseWindowsError(raw, { exitCode: 9009, errorClass: 'environment', command: 'foobar' })
    assert.ok(out.includes('foobar'), '从错误文本提取缺失命令名')
  })

  it('剥离 ANSI 颜色序列', () => {
    const raw = '\x1b[31mreal error message\x1b[0m'
    const out = denoiseWindowsError(raw, { exitCode: 1, command: 'foo' })
    assert.ok(!out.includes('\x1b['), '应剥离 ANSI')
    assert.ok(out.includes('real error message'))
  })

  it('非 environment 且无噪声的普通错误，仅做无害 ANSI 处理', () => {
    const raw = 'TypeError: cannot read property x of undefined'
    const out = denoiseWindowsError(raw, { exitCode: 1, errorClass: 'exec-failure', command: 'node app.js' })
    assert.ok(out.includes('TypeError'), '普通错误消息保留')
    assert.ok(!out.startsWith('命令未找到'), '非 environment 不加恢复提示')
  })
})
