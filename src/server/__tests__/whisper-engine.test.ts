import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWhisperEngine } from '../whisper-engine.js'

/**
 * 造一个 fake whisper-cli：node 脚本，解析 -f 后的路径写 <path>.txt。
 * 成功（默认）/ 失败（argv 含 --fail）/ 挂起（argv 含 --hang）。
 */
async function makeFakeBin(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-test-'))
  const script = join(dir, 'fake-whisper.mjs')
  const src = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
if (process.env.WHISPER_FAKE_FAIL) { process.exit(1) }
if (process.env.WHISPER_FAKE_HANG) { await new Promise(() => {}); }
const argv = process.argv.slice(2)
const i = argv.indexOf('-f')
if (i >= 0 && argv[i + 1]) writeFileSync(argv[i + 1] + '.txt', 'hello world', 'utf8')
`
  await writeFile(script, src)
  await chmod(script, 0o755)
  return script
}

test('whisper-engine: 成功转写 → 读取 <wav>.txt 文本', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    const { text } = await engine.transcribe(wav)
    assert.equal(text, 'hello world')
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

test('whisper-engine: exit 非 0 → reject 带 stderr 摘要', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin' })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    process.env.WHISPER_FAKE_FAIL = '1'
    try {
      await assert.rejects(() => engine.transcribe(wav, { lang: 'zh' }), /exit 1/)
    } finally {
      delete process.env.WHISPER_FAKE_FAIL
    }
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})

test('whisper-engine: 挂起 → 超时 SIGKILL reject', async () => {
  const bin = await makeFakeBin()
  try {
    const engine = createWhisperEngine({ binPath: bin, modelPath: '/tmp/model.bin', timeoutMs: 300 })
    const dir = await mkdtemp(join(tmpdir(), 'rivet-whisper-wav-'))
    const wav = join(dir, 'in.wav')
    await writeFile(wav, Buffer.alloc(44))
    process.env.WHISPER_FAKE_HANG = '1'
    try {
      await assert.rejects(() => engine.transcribe(wav), /timeout/)
    } finally {
      delete process.env.WHISPER_FAKE_HANG
    }
    await rm(dir, { recursive: true, force: true })
  } finally {
    await rm(join(bin, '..'), { recursive: true, force: true })
  }
})
