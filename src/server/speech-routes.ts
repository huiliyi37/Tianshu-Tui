/**
 * POST /speech/transcribe — 语音转写（whisper.cpp 本地引擎）。
 * body: { audio: base64(wav 16k mono PCM16), lang?: string }
 * 返回: 200 { text } / 400 { error: 'invalid-audio'|'invalid-wav' }
 *       / 503 { error: 'whisper-unavailable' } / 500 { error: 'transcribe-failed' }
 * engine 为 null 时（whisper 运行时未打包/未就绪）返回 503，前端据此降级。
 *
 * GET /speech/model/status — 引擎就绪状态（设置页展示）。
 *   按 RIVET_WHISPER_BIN / RIVET_WHISPER_MODEL 环境变量探测文件存在性，
 *   探测不到 → false；model 为当前启用模型的文件名（无则 null）。
 *   返回 200 { binReady, modelReady, model, installing }。
 *
 * POST /speech/model/install — 下载 whisper 模型（设置页 tiny/base 切换）。
 * body: { model: 'tiny'|'base' }；spawn 系统 node 执行
 *   desktop/scripts/fetch-whisper-runtime.js（--model tiny|base）。
 *   安装状态存模块级变量防并发；完成返回 200 { ok }，
 *   失败 500 { error: 'model-install-failed' }，进行中 409 { error: 'install-in-progress' }。
 *   脚本路径可用 RIVET_WHISPER_FETCH_SCRIPT 覆盖（测试注入 fake 脚本）。
 *   下载走 curl，需代理时读设置 `network.proxy` 注入子进程
 *   （RIVET_WHISPER_PROXY / HTTPS_PROXY）——GUI 启动的 sidecar 往往没有 shell 代理环境。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { getNetworkConfig } from '../config/manager.js'
import type { RouteHandler } from './index.js'
import { errorContext, serverLogger } from './logger.js'

export interface SpeechEngine {
  /** 转写一个 wav 文件，返回识别文本。 */
  transcribe(wavPath: string, opts?: { lang?: string }): Promise<{ text: string }>
}

/** 模块级安装状态：任一安装进行中为 true，防止并发下载两个模型互相踩半截文件。 */
let installing = false

/**
 * 组装 whisper 模型下载子进程的 env。
 * 优先级：已有 RIVET_WHISPER_PROXY / HTTPS_PROXY 环境变量 > 设置页 network.proxy。
 * 设置代理写入 RIVET_WHISPER_PROXY（脚本优先读）并回填 HTTPS_PROXY/HTTP_PROXY，
 * 以便 curl `-x` 与其它继承代理的工具都能用上。
 */
export function buildWhisperFetchChildEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  network: { proxy?: string; noProxy?: string } = getNetworkConfig(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }
  const configured = network.proxy?.trim()
  const hasWhisperProxy = !!(env.RIVET_WHISPER_PROXY?.trim())
  const hasHttpsProxy = !!(env.HTTPS_PROXY?.trim() || env.https_proxy?.trim())
  const hasHttpProxy = !!(env.HTTP_PROXY?.trim() || env.http_proxy?.trim())
  if (configured && !hasWhisperProxy && !hasHttpsProxy && !hasHttpProxy) {
    env.RIVET_WHISPER_PROXY = configured
    env.HTTPS_PROXY = configured
    env.HTTP_PROXY = configured
  } else if (configured && !hasWhisperProxy) {
    // 仅补脚本专用键，不覆盖用户已有 HTTPS_PROXY。
    env.RIVET_WHISPER_PROXY = configured
  }
  const noProxy = network.noProxy?.trim()
  if (noProxy && !env.NO_PROXY?.trim() && !env.no_proxy?.trim()) {
    env.NO_PROXY = noProxy
  }
  return env
}

export function buildSpeechRoutes(engine: SpeechEngine | null): Record<string, RouteHandler> {
  return {
    'GET /speech/model/status': async () => {
      const bin = process.env.RIVET_WHISPER_BIN
      const model = process.env.RIVET_WHISPER_MODEL
      return {
        status: 200,
        body: {
          binReady: !!bin && existsSync(resolve(bin)),
          modelReady: !!model && existsSync(resolve(model)),
          model: model ? basename(model) : null,
          installing,
        },
      }
    },
    'POST /speech/model/install': async (body) => {
      const model = (body as { model?: unknown }).model
      if (model !== 'tiny' && model !== 'base') {
        return { status: 400, body: { error: 'invalid-model' } }
      }
      if (installing) {
        return { status: 409, body: { error: 'install-in-progress' } }
      }
      // 默认脚本相对 sidecar cwd 解析（dev 为 desktop 目录）；打包后部署侧
      // 可用 RIVET_WHISPER_FETCH_SCRIPT 指到实际位置，测试注入 fake 脚本。
      const script =
        process.env.RIVET_WHISPER_FETCH_SCRIPT ||
        join(process.cwd(), 'desktop', 'scripts', 'fetch-whisper-runtime.js')
      // tiny/base 均走 --model（fetch 脚本 --with-base 等价 --model all 会连带
      // 确保 tiny；--model base 严格只下 base，语义精确）。
      const args = ['--model', model]
      installing = true
      try {
        await new Promise<void>((resolveInstall, reject) => {
          const child = spawn('node', [script, ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: buildWhisperFetchChildEnv(),
          })
          let stderr = ''
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString()
          })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code === 0) resolveInstall()
            else reject(new Error(`fetch-whisper-runtime exit ${code}: ${stderr.trim().slice(0, 200)}`))
          })
        })
        return { status: 200, body: { ok: true } }
      } catch (err) {
        serverLogger.warn('Speech model install failed', { ...errorContext(err) })
        return { status: 500, body: { error: 'model-install-failed' } }
      } finally {
        installing = false
      }
    },
    'POST /speech/transcribe': async (body) => {
      if (!engine) {
        return { status: 503, body: { error: 'whisper-unavailable' } }
      }
      const audio = (body as { audio?: unknown }).audio
      if (typeof audio !== 'string' || audio.length === 0) {
        return { status: 400, body: { error: 'invalid-audio' } }
      }
      const lang = (body as { lang?: unknown }).lang
      if (lang !== undefined && typeof lang !== 'string') {
        return { status: 400, body: { error: 'invalid-audio' } }
      }
      const wav = Buffer.from(audio, 'base64')
      // 最小 wav 头校验：>=44 字节且 RIFF/WAVE 魔数。防垃圾载荷进 spawn。
      if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        return { status: 400, body: { error: 'invalid-wav' } }
      }
      const dir = await mkdtemp(join(tmpdir(), 'rivet-speech-'))
      const wavPath = join(dir, 'input.wav')
      try {
        await writeFile(wavPath, wav)
        const { text } = await engine.transcribe(wavPath, lang ? { lang } : undefined)
        return { status: 200, body: { text } }
      } catch (err) {
        serverLogger.warn('Speech transcribe failed', { ...errorContext(err) })
        return { status: 500, body: { error: 'transcribe-failed' } }
      } finally {
        void rm(dir, { recursive: true, force: true })
      }
    },
  }
}
