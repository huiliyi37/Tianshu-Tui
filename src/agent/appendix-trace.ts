/**
 * Appendix render trace — the audit trail the self-description layer never had.
 *
 * The session JSONL records what the user typed. The appendix — `<progress>`,
 * `<cognitive-mirror>`, `<session-state>` and friends — is assembled per request and
 * dropped, so "what did the model actually see when it regressed the todo list" was
 * unanswerable after the fact. That is also why no channel in this layer could be
 * argued for or against with evidence: nobody could produce one real rendering.
 *
 * This sink makes the question answerable. It is the prerequisite for holdout
 * attribution, not a standalone feature.
 *
 * Off by default (`RIVET_APPENDIX_TRACE=1`): the full appendix runs to kilobytes per
 * request and most sessions never need it.
 */
import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'

export interface AppendixTraceEntry {
  event: 'appendix_render'
  t: number
  turn: number
  model?: string
  bytes: number
  /** Top-level block tags in render order — enough to spot a channel appearing or
   *  going silent without parsing the full text. */
  blocks: string[]
  content: string
}

export function appendixTraceEnabled(): boolean {
  const v = process.env.RIVET_APPENDIX_TRACE
  return v === '1' || v === 'true'
}

/** Top-level block tags in a rendered appendix, in render order. */
export function appendixBlockNames(appendix: string): string[] {
  return [...appendix.matchAll(/^<([a-z][a-z0-9-]*)[\s/>]/gm)].map(m => m[1]!)
}

export function buildAppendixTraceEntry(
  appendix: string,
  meta: { turn: number; model?: string; now?: number },
): AppendixTraceEntry {
  return {
    event: 'appendix_render',
    t: meta.now ?? Date.now(),
    turn: meta.turn,
    model: meta.model,
    bytes: Buffer.byteLength(appendix),
    blocks: appendixBlockNames(appendix),
    content: appendix,
  }
}

/**
 * Append one render to `<session dir>/<sid>/appendix-trace.jsonl`.
 * Fire-and-forget: observability must never break a turn.
 */
export function recordAppendixTrace(
  appendix: string | undefined,
  ctx: { cwd: string; sessionId?: string; turn: number; model?: string },
): void {
  if (!appendixTraceEnabled() || !appendix) return
  try {
    const line = JSON.stringify(buildAppendixTraceEntry(appendix, { turn: ctx.turn, model: ctx.model }))
    const dir = join(getSessionDir(ctx.cwd), ctx.sessionId ?? 'anon')
    void import('node:fs/promises').then(fs =>
      fs.mkdir(dir, { recursive: true })
        .then(() => fs.appendFile(join(dir, 'appendix-trace.jsonl'), line + '\n')),
    ).catch(() => {})
  } catch { /* observability is best-effort — never break the turn */ }
}
