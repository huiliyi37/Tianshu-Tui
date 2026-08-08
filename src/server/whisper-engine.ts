/**
 * whisper.cpp 本地转写引擎：spawn whisper-cli 把 wav 转成文本。
 * 输出用 -otxt -nt（纯文本、无时间戳），spawn 完成后读 <wav>.txt。
 * 超时 SIGKILL 兜底（whisper 在坏模型/坏音频上可能挂起）。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { SpeechEngine } from './speech-routes.js'

export interface WhisperEngineOptions {
  /** whisper-cli 可执行文件路径。 */
  binPath: string
  /** ggml 模型文件路径（如 ggml-tiny.bin）。 */
  modelPath: string
  /** 单次转写超时（毫秒），默认 60s。 */
  timeoutMs?: number
}

export function createWhisperEngine(opts: WhisperEngineOptions): SpeechEngine {
  const timeoutMs = opts.timeoutMs ?? 60_000
  return {
    transcribe(wavPath, o) {
      return new Promise((resolve, reject) => {
        const args = ['-m', opts.modelPath, '-f', wavPath, '-otxt', '-nt']
        if (o?.lang && o.lang !== 'auto') args.push('-l', o.lang)
        const child = spawn(opts.binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let stderr = ''
        child.stderr.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`whisper-cli timeout after ${timeoutMs}ms`))
        }, timeoutMs)
        child.on('error', (err) => {
          clearTimeout(timer)
          reject(err)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          if (code !== 0) {
            reject(new Error(`whisper-cli exit ${code}: ${stderr.trim().slice(0, 200)}`))
            return
          }
          readFile(`${wavPath}.txt`, 'utf8')
            .then((t) => resolve({ text: t.trim() }))
            .catch(reject)
        })
      })
    },
  }
}
