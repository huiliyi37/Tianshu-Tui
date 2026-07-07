import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StatusLineRunner, type StatusLinePayload } from '../statusline.js'

const payload: StatusLinePayload = {
  session_id: 'test-session',
  model: { display_name: 'deepseek-v4' },
  workspace: { current_dir: '/tmp/proj' },
  git: { branch: 'main' },
  context: { ratio: 0.42, estimated_tokens: 54_000, max_tokens: 128_000 },
  cost: { total_yuan: 0.12 },
}

function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (check()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('StatusLineRunner', () => {
  it('把 payload JSON 写入 stdin，取 stdout 首行作为 statusline', async () => {
    let latest: string | null = null
    // 脚本从 stdin 读 JSON，输出 model 名 + 分支
    const cmd = `node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const p=JSON.parse(s);console.log(p.model.display_name+' @ '+p.git.branch);console.log('second line ignored')})"`
    const runner = new StatusLineRunner({ command: cmd, intervalMs: 0, timeoutMs: 8000 }, t => { latest = t })
    runner.refresh(payload)
    await waitFor(() => latest !== null)
    assert.equal(latest, 'deepseek-v4 @ main')
    assert.equal(runner.current, 'deepseek-v4 @ main')
  })

  it('脚本失败时静默保留上一次输出（不闪断）', async () => {
    let latest: string | null = null
    let updates = 0
    const okCmd = `node -e "console.log('ok')"`
    const runner = new StatusLineRunner({ command: okCmd, intervalMs: 0, timeoutMs: 8000 }, t => { latest = t; updates++ })
    runner.refresh(payload)
    await waitFor(() => latest !== null)
    assert.equal(latest, 'ok')

    // 第二次换成失败命令：exit 1 且无输出 → 不触发 onUpdate，current 保留
    const failRunner = runner as unknown as { command: string }
    failRunner.command = `node -e "process.exit(1)"`
    runner.refresh(payload)
    await new Promise(r => setTimeout(r, 500))
    assert.equal(runner.current, 'ok', '失败后保留上一次输出')
    assert.equal(updates, 1, '失败不触发 onUpdate')
  })

  it('节流：intervalMs 内的第二次 refresh 被跳过', async () => {
    let updates = 0
    const cmd = `node -e "console.log(Date.now())"`
    const runner = new StatusLineRunner({ command: cmd, intervalMs: 60_000, timeoutMs: 8000 }, () => { updates++ })
    runner.refresh(payload)
    await waitFor(() => updates === 1)
    runner.refresh(payload) // 60s 窗口内 → 跳过
    await new Promise(r => setTimeout(r, 300))
    assert.equal(updates, 1)
  })

  it('超长输出截断到 300 字符', async () => {
    let latest: string | null = null
    const cmd = `node -e "console.log('x'.repeat(1000))"`
    const runner = new StatusLineRunner({ command: cmd, intervalMs: 0, timeoutMs: 8000 }, t => { latest = t })
    runner.refresh(payload)
    await waitFor(() => latest !== null)
    assert.equal(latest!.length, 300)
  })
})
