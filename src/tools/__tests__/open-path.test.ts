import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildOpenPathCommand, OPEN_PATH_TOOL } from '../open-path.js'

describe('open_path', () => {
  it('builds Windows opener without shell-quoting the path argument', () => {
    const target = 'C:\\Users\\Honglin   zhang\\Desktop\\天枢-logo.svg'
    const command = buildOpenPathCommand(target, 'win32')

    assert.equal(command.cmd, 'cmd.exe')
    assert.deepEqual(command.args, ['/c', 'start', '""', target])
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
