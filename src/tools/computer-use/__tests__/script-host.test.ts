import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createScriptHost, HostUnavailableError, SENTINEL, hostEnabled, type ScriptHost } from '../script-host.js'

// A fake REPL in Node: reads {id, b64} lines, evals the decoded code, replies
// with the sentinel protocol. Mirrors what the JXA/PS bootstraps do so the
// framing logic is tested without osascript/powershell.
const FAKE_REPL = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  const code = Buffer.from(req.b64, 'base64').toString('utf8')
  let reply
  try {
    const out = String(eval(code))
    reply = { id: req.id, ok: true, out }
  } catch (err) {
    reply = { id: req.id, ok: false, err: String(err && err.message || err) }
  }
  process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(reply) + '\\n')
})
`

function fakeHost(extra?: Partial<Parameters<typeof createScriptHost>[0]>): ScriptHost {
  return createScriptHost({ command: process.execPath, args: ['-e', FAKE_REPL], ...extra })
}

const hosts: ScriptHost[] = []
function track(host: ScriptHost): ScriptHost {
  hosts.push(host)
  return host
}

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose()
})

test('run round-trips code through the resident child', async () => {
  const host = track(fakeHost())
  assert.equal(await host.run('1 + 1', 5_000), '2')
  assert.equal(await host.run('"multi\\nline " + "input"', 5_000), 'multi\nline input')
})

test('child-side errors reject with the reported message', async () => {
  const host = track(fakeHost())
  await assert.rejects(() => host.run('throw new Error("boom from repl")', 5_000), /boom from repl/)
  // Host stays usable after a script error.
  assert.equal(await host.run('40 + 2', 5_000), '42')
})

test('sequential requests share one child; stray output lines are ignored', async () => {
  const host = track(fakeHost())
  const first = await host.run('process.stdout.write("noise without sentinel\\n"), process.pid', 5_000)
  const second = await host.run('process.pid', 5_000)
  assert.equal(first, second, 'same resident pid across calls')
})

test('concurrent requests are serialized, all resolve', async () => {
  const host = track(fakeHost())
  const results = await Promise.all([host.run('"a"', 5_000), host.run('"b"', 5_000), host.run('"c"', 5_000)])
  assert.deepEqual(results, ['a', 'b', 'c'])
})

test('timeout kills the child and the next run respawns', async () => {
  const host = track(fakeHost())
  const pidBefore = await host.run('process.pid', 5_000)
  await assert.rejects(
    () => host.run('const t = Date.now(); while (Date.now() - t < 10_000) {} 1', 300),
    /timed out after 300ms/,
  )
  const pidAfter = await host.run('process.pid', 5_000)
  assert.notEqual(pidBefore, pidAfter, 'fresh child after the wedged one was killed')
})

test('child crash rejects the in-flight request and self-heals', async () => {
  const host = track(fakeHost())
  await assert.rejects(() => host.run('process.exit(1)', 5_000), /exited unexpectedly/)
  assert.equal(await host.run('"alive"', 5_000), 'alive')
})

test('unspawnable command rejects with HostUnavailableError and disables after repeated failures', async () => {
  const host = track(createScriptHost({ command: '/nonexistent/definitely-not-a-binary', args: [], maxSpawnFailures: 2 }))
  await assert.rejects(() => host.run('1', 5_000), HostUnavailableError)
  await assert.rejects(() => host.run('1', 5_000), HostUnavailableError)
  assert.equal(host.available(), false, 'disabled after consecutive spawn failures')
  await assert.rejects(() => host.run('1', 5_000), HostUnavailableError)
})

test('idle TTL reaps the child; next run lazily respawns', async () => {
  const host = track(fakeHost({ idleTtlMs: 150 }))
  const pidBefore = await host.run('process.pid', 5_000)
  await new Promise((r) => setTimeout(r, 400))
  const pidAfter = await host.run('process.pid', 5_000)
  assert.notEqual(pidBefore, pidAfter, 'child was reaped while idle and respawned')
})

test('dispose rejects nothing pending quietly and is idempotent', async () => {
  const host = track(fakeHost())
  assert.equal(await host.run('"x"', 5_000), 'x')
  host.dispose()
  host.dispose()
  // A disposed host is NOT disabled — next run lazily respawns.
  assert.equal(await host.run('"y"', 5_000), 'y')
})

test('hostEnabled reads RIVET_CU_HOST', () => {
  assert.equal(hostEnabled({}), true)
  assert.equal(hostEnabled({ RIVET_CU_HOST: '0' }), false)
  assert.equal(hostEnabled({ RIVET_CU_HOST: '1' }), true)
})
