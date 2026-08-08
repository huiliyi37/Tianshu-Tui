import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRouter } from '../index.js'
import { buildSpeechRoutes, buildWhisperFetchChildEnv, type SpeechEngine } from '../speech-routes.js'

const AUTH = { authorization: 'Bearer test-token' }

function minimalWav(): Buffer {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(16000, 24)
  b.writeUInt32LE(32000, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(0, 40)
  return b
}

test('speech: engine 不可用 → 503 whisper-unavailable', async () => {
  const router = createRouter(buildSpeechRoutes(null))
  const res = await router('POST', '/speech/transcribe', { audio: 'x' }, AUTH)
  assert.equal(res.status, 503)
  assert.deepEqual(res.body, { error: 'whisper-unavailable' })
})

test('speech: 有效 wav → 200 文本回填', async () => {
  const calls: { wavPath: string; lang?: string }[] = []
  const fake: SpeechEngine = {
    transcribe: async (wavPath, opts) => {
      calls.push({ wavPath, lang: opts?.lang })
      return { text: '你好世界' }
    },
  }
  const router = createRouter(buildSpeechRoutes(fake))
  const res = await router('POST', '/speech/transcribe', { audio: minimalWav().toString('base64'), lang: 'zh' }, AUTH)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { text: '你好世界' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.lang, 'zh')
  assert.ok(calls[0]?.wavPath.endsWith('.wav'))
})

test('speech: 缺 audio 字段 → 400', async () => {
  const router = createRouter(buildSpeechRoutes({ transcribe: async () => ({ text: '' }) }))
  const res = await router('POST', '/speech/transcribe', {}, AUTH)
  assert.equal(res.status, 400)
})

test('speech: 非 wav 载荷（无 RIFF 头）→ 400 invalid-wav', async () => {
  const router = createRouter(buildSpeechRoutes({ transcribe: async () => ({ text: '' }) }))
  const res = await router('POST', '/speech/transcribe', { audio: Buffer.from('not a wav file').toString('base64') }, AUTH)
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'invalid-wav' })
})

test('speech: 引擎失败 → 500 transcribe-failed', async () => {
  const router = createRouter(buildSpeechRoutes({
    transcribe: async () => { throw new Error('spawn ENOENT') },
  }))
  const res = await router('POST', '/speech/transcribe', { audio: minimalWav().toString('base64') }, AUTH)
  assert.equal(res.status, 500)
  assert.deepEqual(res.body, { error: 'transcribe-failed' })
})

// ── GET /speech/model/status ──────────────────────────────────────

/** 临时遮蔽两个 whisper env，测试结束后恢复（node --test 同文件串行，安全）。 */
function withWhisperEnv(bin: string | undefined, model: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prevBin = process.env.RIVET_WHISPER_BIN
  const prevModel = process.env.RIVET_WHISPER_MODEL
  const prevScript = process.env.RIVET_WHISPER_FETCH_SCRIPT
  try {
    if (bin === undefined) delete process.env.RIVET_WHISPER_BIN
    else process.env.RIVET_WHISPER_BIN = bin
    if (model === undefined) delete process.env.RIVET_WHISPER_MODEL
    else process.env.RIVET_WHISPER_MODEL = model
    delete process.env.RIVET_WHISPER_FETCH_SCRIPT
    return fn()
  } finally {
    if (prevBin === undefined) delete process.env.RIVET_WHISPER_BIN
    else process.env.RIVET_WHISPER_BIN = prevBin
    if (prevModel === undefined) delete process.env.RIVET_WHISPER_MODEL
    else process.env.RIVET_WHISPER_MODEL = prevModel
    if (prevScript === undefined) delete process.env.RIVET_WHISPER_FETCH_SCRIPT
    else process.env.RIVET_WHISPER_FETCH_SCRIPT = prevScript
  }
}

test('speech: status — engine null 且 env 未配置 → 全 false', async () => {
  await withWhisperEnv(undefined, undefined, async () => {
    const router = createRouter(buildSpeechRoutes(null))
    const res = await router('GET', '/speech/model/status', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { binReady: false, modelReady: false, model: null, installing: false })
  })
})

test('speech: status — fake engine，按 env 探测文件存在性', async () => {
  const selfPath = fileURLToPath(import.meta.url) // 真实存在的文件
  await withWhisperEnv(selfPath, join(selfPath, 'no-such-model.bin'), async () => {
    const router = createRouter(buildSpeechRoutes({ transcribe: async () => ({ text: '' }) }))
    const res = await router('GET', '/speech/model/status', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, {
      binReady: true,
      modelReady: false,
      model: 'no-such-model.bin',
      installing: false,
    })
  })
})

// ── POST /speech/model/install ─────────────────────────────────────

function fakeFetchScript(body: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-speech-install-'))
  const script = join(dir, 'fake-fetch.js')
  writeFileSync(script, body)
  return { dir, script }
}

test('speech: install — fake 脚本成功 → 200 {ok:true}（fake engine）', async () => {
  const { dir, script } = fakeFetchScript('process.exit(0)\n')
  await withWhisperEnv(undefined, undefined, async () => {
    process.env.RIVET_WHISPER_FETCH_SCRIPT = script
    const router = createRouter(buildSpeechRoutes({ transcribe: async () => ({ text: '' }) }))
    const res = await router('POST', '/speech/model/install', { model: 'tiny' }, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
  })
  rmSync(dir, { recursive: true, force: true })
})

test('speech: install — 非法 model → 400 invalid-model', async () => {
  const router = createRouter(buildSpeechRoutes(null))
  const res = await router('POST', '/speech/model/install', { model: 'large' }, AUTH)
  assert.equal(res.status, 400)
  assert.deepEqual(res.body, { error: 'invalid-model' })
})

test('speech: install — 脚本失败 → 500 model-install-failed', async () => {
  const { dir, script } = fakeFetchScript('console.error("boom"); process.exit(1)\n')
  await withWhisperEnv(undefined, undefined, async () => {
    process.env.RIVET_WHISPER_FETCH_SCRIPT = script
    const router = createRouter(buildSpeechRoutes(null))
    const res = await router('POST', '/speech/model/install', { model: 'base' }, AUTH)
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'model-install-failed' })
  })
  rmSync(dir, { recursive: true, force: true })
})

test('buildWhisperFetchChildEnv: 设置代理在无 env 时代入 RIVET_WHISPER_PROXY/HTTPS_PROXY', () => {
  const env = buildWhisperFetchChildEnv(
    { PATH: '/usr/bin', HOME: '/tmp' },
    { proxy: 'http://127.0.0.1:7890', noProxy: 'localhost' },
  )
  assert.equal(env.RIVET_WHISPER_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.NO_PROXY, 'localhost')
})

test('buildWhisperFetchChildEnv: 已有 HTTPS_PROXY 时不覆盖，仅补 RIVET_WHISPER_PROXY', () => {
  const env = buildWhisperFetchChildEnv(
    { HTTPS_PROXY: 'http://shell:8080' },
    { proxy: 'http://127.0.0.1:7890' },
  )
  assert.equal(env.HTTPS_PROXY, 'http://shell:8080')
  assert.equal(env.RIVET_WHISPER_PROXY, 'http://127.0.0.1:7890')
})

test('buildWhisperFetchChildEnv: 无设置代理 → 原样透传', () => {
  const env = buildWhisperFetchChildEnv({ FOO: '1' }, { proxy: '', noProxy: '' })
  assert.equal(env.FOO, '1')
  assert.equal(env.RIVET_WHISPER_PROXY, undefined)
  assert.equal(env.HTTPS_PROXY, undefined)
})

test('speech: install — 安装进行中时 status.installing=true 且并发 install 拒绝', async () => {
  const { dir, script } = fakeFetchScript('setTimeout(() => process.exit(0), 800)\n')
  await withWhisperEnv(undefined, undefined, async () => {
    process.env.RIVET_WHISPER_FETCH_SCRIPT = script
    const router = createRouter(buildSpeechRoutes(null))
    const installP = router('POST', '/speech/model/install', { model: 'tiny' }, AUTH)
    // 模块级 installing 已置位（spawn 前同步设置），status 应能观测到。
    const statusRes = await router('GET', '/speech/model/status', {}, AUTH)
    assert.equal(statusRes.status, 200)
    assert.equal((statusRes.body as { installing: boolean }).installing, true)
    // 并发 install 直接 409。
    const concurrent = await router('POST', '/speech/model/install', { model: 'base' }, AUTH)
    assert.equal(concurrent.status, 409)
    assert.deepEqual(concurrent.body, { error: 'install-in-progress' })
    // 首个安装正常完成。
    const installRes = await installP
    assert.equal(installRes.status, 200)
    assert.deepEqual(installRes.body, { ok: true })
    // 完成后 installing 复位。
    const afterRes = await router('GET', '/speech/model/status', {}, AUTH)
    assert.equal((afterRes.body as { installing: boolean }).installing, false)
  })
  rmSync(dir, { recursive: true, force: true })
})
