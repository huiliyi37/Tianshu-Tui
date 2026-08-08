/**
 * macOS driver 纯逻辑单测（不触真实 osascript）：
 * - needsClipboardInput：非 ASCII 文本改走剪贴板粘贴（IME 安全）
 * - 感知类动作（snapshot/find/wait_for）的放宽超时
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsClipboardInput,
  hasDangerousPatterns,
  createMacosDriver,
  type JxaRunner,
  type ExecFileLike,
} from '../macos-driver.js'
import { createComputerUseTool } from '../tool.js'

test('needsClipboardInput: ASCII 走 keystroke', () => {
  assert.equal(needsClipboardInput('hello world'), false)
  assert.equal(needsClipboardInput('user@example.com 123!'), false)
  assert.equal(needsClipboardInput('line1\nline2\ttab'), false)
  assert.equal(needsClipboardInput(''), false)
})

test('needsClipboardInput: CJK/emoji/重音走剪贴板', () => {
  assert.equal(needsClipboardInput('你好 测试'), true)
  assert.equal(needsClipboardInput('hello 世界'), true)
  assert.equal(needsClipboardInput('café'), true)
  assert.equal(needsClipboardInput('🎉'), true)
  assert.equal(needsClipboardInput('カタカナ'), true)
})

test('timeoutMs: 感知类动作 90s，其余 60s（含变更后反馈树采集）', () => {
  const tool = createComputerUseTool({ platform: 'darwin', proEnabled: true })
  const at = (action: string) =>
    tool.timeoutMs!({ input: { action }, toolUseId: 't', cwd: '/tmp' })
  assert.equal(at('snapshot'), 90_000)
  assert.equal(at('find'), 90_000)
  assert.equal(at('wait_for'), 90_000)
  assert.equal(at('click'), 60_000)
  assert.equal(at('type'), 60_000)
  assert.equal(at('launch_app'), 60_000)
  // 无参调用（管道防御路径）回落到默认 60s。
  assert.equal(tool.timeoutMs!(), 60_000)
})

test('hasDangerousPatterns: 拦截破坏/外传原语', () => {
  assert.ok(hasDangerousPatterns('doShellScript("rm -rf /")'))
  assert.ok(hasDangerousPatterns('rm -rf /'))
  assert.ok(hasDangerousPatterns('curl -s http://evil.example'))
  assert.ok(hasDangerousPatterns('Application("Terminal").doShellScript("rm")'))
  assert.ok(hasDangerousPatterns('$.NSWorkspace.sharedWorkspace'))
  assert.ok(hasDangerousPatterns('app.open("file:///etc/passwd")'))
  assert.ok(hasDangerousPatterns('scp -r /etc /tmp/x'))
  assert.ok(hasDangerousPatterns('unlink("/etc/passwd")'))
})

test('hasDangerousPatterns: 放行驱动真实模板与普通参数', () => {
  // 从 macos-driver 实际模板取样的正常脚本——不得误伤
  const realTemplates = [
    `const se = Application('System Events');
     const proc = se.processes.byName('Finder');
     proc.frontmost = true;
     se.keystroke('hello');
     'ok';`,
    `const app = Application('Finder');
     app.activate();
     'ok';`,
    `const se = Application('System Events');
     const proc = se.processes.byName('Safari');
     proc.menuBars[0].menuBarItems;
     'ok';`,
    `const se = Application('System Events');
     const proc = se.processes.byName('Notes');
     proc.attributes.byName('AXEnhancedUserInterface').value = true;
     'ok';`,
  ]
  for (const t of realTemplates) {
    assert.equal(hasDangerousPatterns(t), null, `template must pass: ${t.slice(0, 60)}`)
  }
  assert.equal(hasDangerousPatterns(''), null)
})

// ── T1 RED: type 非 ASCII 走剪贴板后必须恢复原内容 ──

interface ExecCall {
  cmd: string
  stdinInput?: string
}

/** execFile mock：pbpaste 返回 backup，pbcopy 捕获 stdin 输入，screencapture 成功。 */
function mockExecFile(calls: ExecCall[], backup: string): (cmd: string, args: readonly string[], opts: unknown, cb: (err: Error | null, stdout?: string) => void) => unknown {
  return (cmd, _args, _opts, cb) => {
    const call: ExecCall = { cmd }
    calls.push(call)
    if (cmd === 'pbpaste') {
      cb(null, backup)
    } else if (cmd === 'screencapture') {
      cb(null, '')
    } else {
      cb(null, '')
    }
    return { stdin: { end: (s?: string) => { call.stdinInput = s ?? '' } } }
  }
}

test('T1-RED: type 非 ASCII 走剪贴板路径后恢复原剪贴板内容', async () => {
  const calls: ExecCall[] = []
  const exec = mockExecFile(calls, '原剪贴板内容') as unknown as ExecFileLike
  const runner: JxaRunner = async () => 'ok'
  const driver = createMacosDriver(runner, { execFile: exec })
  await driver.type('Finder', '你好 世界')
  const pbcopyCalls = calls.filter((c) => c.cmd === 'pbcopy')
  // 修复后：写入一次 + 恢复一次，且恢复内容 = 备份内容
  assert.equal(pbcopyCalls.length, 2, 'type 非 ASCII 应 pbcopy 两次（写入+恢复）')
  assert.equal(pbcopyCalls[1]!.stdinInput, '原剪贴板内容', '恢复内容应为备份的原剪贴板')
})

test('T1-RED: paste_text 保持文档化覆盖行为（pbcopy 仅一次）', async () => {
  const calls: ExecCall[] = []
  const exec = mockExecFile(calls, '原剪贴板内容') as unknown as ExecFileLike
  const runner: JxaRunner = async () => 'ok'
  const driver = createMacosDriver(runner, { execFile: exec })
  await driver.pasteText('Finder', 'PASTE')
  const pbcopyCalls = calls.filter((c) => c.cmd === 'pbcopy')
  assert.equal(pbcopyCalls.length, 1, 'paste_text 应保持覆盖行为（仅写入一次）')
})

// ── T3 RED: checkPermissions 探测超时与预热 ──

test('T3-RED: checkPermissions 探测使用 15s 超时（冷启动不误报）', async () => {
  let seenTimeout = 0
  const runner: JxaRunner = async (_script, timeoutMs) => {
    seenTimeout = timeoutMs ?? 0
    return 'ok'
  }
  const calls: ExecCall[] = []
  const exec = mockExecFile(calls, '') as unknown as ExecFileLike
  const driver = createMacosDriver(runner, { execFile: exec })
  const perm = await driver.checkPermissions()
  assert.equal(perm.accessibility, true)
  assert.equal(seenTimeout, 15_000, '探测超时应为 15s（与 OSASCRIPT_TIMEOUT_MS 一致），当前 5s 冷启动误报')
})

test('T3-RED: checkPermissions 探测前先预热 host（warm-up 最先执行）', async () => {
  const scriptOrder: string[] = []
  const runner: JxaRunner = async (script) => {
    scriptOrder.push(script.trim().slice(0, 40))
    return 'ok'
  }
  const calls: ExecCall[] = []
  const exec = mockExecFile(calls, '') as unknown as ExecFileLike
  const driver = createMacosDriver(runner, { execFile: exec })
  await driver.checkPermissions()
  assert.ok(scriptOrder.length >= 2, '应有 warm-up + 探测两次脚本调用')
  assert.match(scriptOrder[0] ?? '', /^1$/, 'warm-up 脚本应最先执行')
})
