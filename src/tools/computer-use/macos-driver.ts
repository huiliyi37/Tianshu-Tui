/**
 * macOS Computer Use driver — GUI automation via osascript + screencapture.
 *
 * Zero new dependencies: the accessibility tree and input synthesis go through
 * `osascript` (JXA / System Events), and window screenshots through the bundled
 * `screencapture` binary. The driver interface is injectable so the tool's
 * security logic is unit-testable with a fake driver (mirrors browser.ts).
 *
 * Perception is dual-channel by design: the accessibility TREE (text) is the
 * model-facing channel (any model can read it; DeepSeek V4 declares no vision),
 * while the SCREENSHOT is persisted as a viewable artifact for the user to
 * watch — it is not fed back to the model.
 */

import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface AppInfo {
  name: string
  frontmost: boolean
}

/** A click target: either a snapshot element ref (preferred) or raw coords. */
export type ClickTarget =
  | { ref: number }
  | { x: number; y: number }

export interface SnapshotResult {
  /** Compact numbered accessibility tree (model-facing). */
  tree: string
  /** Window screenshot PNG (user-facing artifact); null if capture failed. */
  screenshotPng: Buffer | null
}

export interface PermissionStatus {
  /** Accessibility (System Events control) — required for click/type/key. */
  accessibility: boolean
  /** Screen Recording — required for screencapture of window content. */
  screenRecording: boolean
  /** Human-readable guidance when a permission is missing. */
  detail: string
}

export interface ComputerUseDriver {
  listApps(): Promise<AppInfo[]>
  snapshot(app: string): Promise<SnapshotResult>
  click(app: string, target: ClickTarget): Promise<void>
  type(app: string, text: string): Promise<void>
  key(app: string, combo: string): Promise<void>
  focusApp(app: string): Promise<void>
  checkPermissions(): Promise<PermissionStatus>
}

export type ComputerUseDriverFactory = () => ComputerUseDriver

const OSASCRIPT_TIMEOUT_MS = 15_000
/** Bound the accessibility walk so a deep app tree can't blow up the result. */
const MAX_TREE_NODES = 400

function runOsascript(args: string[], timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.toString().trim() || err.message))
        return
      }
      resolve(stdout.toString())
    })
  })
}

function runJxa(script: string, timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return runOsascript(['-l', 'JavaScript', '-e', script], timeoutMs)
}

/** Escape a string for safe embedding inside a single-quoted JXA string literal. */
function jxaString(value: string): string {
  // We build the script with template concatenation using JSON.stringify for the
  // payload, which produces a valid double-quoted JS string literal.
  return JSON.stringify(value)
}

async function captureWindow(app: string): Promise<Buffer | null> {
  // Get the frontmost window bounds of the target app, then screencapture that
  // rectangle. Falls back to null (tree-only) if bounds can't be resolved.
  const boundsScript = `
    const se = Application('System Events');
    const proc = se.processes.byName(${jxaString(app)});
    const win = proc.windows[0];
    const pos = win.position();
    const size = win.size();
    JSON.stringify({ x: pos[0], y: pos[1], w: size[0], h: size[1] });
  `
  let rect: { x: number; y: number; w: number; h: number }
  try {
    const out = (await runJxa(boundsScript)).trim()
    rect = JSON.parse(out)
  } catch {
    return null
  }
  if (!rect.w || !rect.h) return null

  const file = join(tmpdir(), `rivet-cu-${randomUUID()}.png`)
  const region = `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.w)},${Math.round(rect.h)}`
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('screencapture', ['-x', '-o', '-R', region, file], { timeout: OSASCRIPT_TIMEOUT_MS }, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    const buf = await readFile(file)
    return buf
  } catch {
    return null
  } finally {
    try { await unlink(file) } catch { /* best-effort temp cleanup */ }
  }
}

/** Real macOS driver. */
export function createMacosDriver(): ComputerUseDriver {
  return {
    async listApps(): Promise<AppInfo[]> {
      const script = `
        const se = Application('System Events');
        const procs = se.applicationProcesses.whose({ visible: true })();
        const out = procs.map(p => ({ name: p.name(), frontmost: p.frontmost() }));
        JSON.stringify(out);
      `
      const raw = (await runJxa(script)).trim()
      try {
        const parsed = JSON.parse(raw) as AppInfo[]
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    },

    async snapshot(app: string): Promise<SnapshotResult> {
      // Walk the accessibility tree breadth-limited, emitting a numbered ref per
      // actionable/labeled element so the model can target clicks by ref.
      const script = `
        const se = Application('System Events');
        const proc = se.processes.byName(${jxaString(app)});
        const MAX = ${MAX_TREE_NODES};
        const rows = [];
        let ref = 0;
        function visit(el, depth) {
          if (rows.length >= MAX) return;
          let role = '', title = '', value = '';
          try { role = el.role(); } catch (e) {}
          try { title = el.title() || el.description() || ''; } catch (e) {}
          try { value = String(el.value() || ''); } catch (e) {}
          if (role || title || value) {
            ref++;
            let pos = null;
            try { const p = el.position(); pos = { x: p[0], y: p[1] }; } catch (e) {}
            rows.push({ ref, depth, role, title, value, pos });
          }
          let kids = [];
          try { kids = el.uiElements(); } catch (e) {}
          for (let i = 0; i < kids.length; i++) {
            if (rows.length >= MAX) break;
            visit(kids[i], depth + 1);
          }
        }
        let windows = [];
        try { windows = proc.windows(); } catch (e) {}
        for (let i = 0; i < windows.length; i++) visit(windows[i], 0);
        JSON.stringify(rows);
      `
      const raw = (await runJxa(script)).trim()
      let rows: Array<{ ref: number; depth: number; role: string; title: string; value: string; pos: { x: number; y: number } | null }> = []
      try {
        rows = JSON.parse(raw)
      } catch {
        rows = []
      }
      const tree = rows
        .map((r) => {
          const indent = '  '.repeat(Math.min(r.depth, 8))
          const label = r.title ? ` "${r.title}"` : ''
          const val = r.value ? ` = ${r.value}` : ''
          const at = r.pos ? ` @(${Math.round(r.pos.x)},${Math.round(r.pos.y)})` : ''
          return `${indent}[${r.ref}] ${r.role || 'element'}${label}${val}${at}`
        })
        .join('\n')
      const screenshotPng = await captureWindow(app)
      return { tree: tree || '(no accessible elements found)', screenshotPng }
    },

    async click(app: string, target: ClickTarget): Promise<void> {
      if ('ref' in target) {
        // Re-walk to the nth labeled element and click it via AXPress.
        const script = `
          const se = Application('System Events');
          const proc = se.processes.byName(${jxaString(app)});
          const TARGET = ${target.ref};
          let ref = 0; let found = null;
          function visit(el) {
            if (found) return;
            let role = '', title = '', value = '';
            try { role = el.role(); } catch (e) {}
            try { title = el.title() || el.description() || ''; } catch (e) {}
            try { value = String(el.value() || ''); } catch (e) {}
            if (role || title || value) { ref++; if (ref === TARGET) { found = el; return; } }
            let kids = [];
            try { kids = el.uiElements(); } catch (e) {}
            for (let i = 0; i < kids.length && !found; i++) visit(kids[i]);
          }
          let windows = [];
          try { windows = proc.windows(); } catch (e) {}
          for (let i = 0; i < windows.length && !found; i++) visit(windows[i]);
          if (!found) throw new Error('ref ${target.ref} not found in snapshot');
          found.click();
          'ok';
        `
        await runJxa(script)
        return
      }
      // Coordinate click via cliclick-free System Events: use AXPress is not
      // available for raw coords, so synthesize a click through JXA's
      // "click at" on the process. System Events supports `click at {x, y}`.
      const script = `
        const se = Application('System Events');
        se.click({ at: [${Math.round(target.x)}, ${Math.round(target.y)}] });
        'ok';
      `
      await runJxa(script)
    },

    async type(app: string, text: string): Promise<void> {
      const script = `
        const se = Application('System Events');
        se.processes.byName(${jxaString(app)}).frontmost = true;
        se.keystroke(${jxaString(text)});
        'ok';
      `
      await runJxa(script)
    },

    async key(app: string, combo: string): Promise<void> {
      // combo like "cmd+s", "shift+cmd+4", "return". Map modifiers to System
      // Events "using" and the final token to a keystroke or key code.
      const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
      const key = parts.pop() ?? ''
      const modMap: Record<string, string> = {
        cmd: 'command down', command: 'command down',
        opt: 'option down', option: 'option down', alt: 'option down',
        ctrl: 'control down', control: 'control down',
        shift: 'shift down',
      }
      const usingList = parts.map((m) => modMap[m]).filter(Boolean)
      const using = usingList.length > 0 ? `, { using: [${usingList.map((u) => `'${u}'`).join(', ')}] }` : ''
      // Named keys go through key code; single chars go through keystroke.
      const namedKeyCodes: Record<string, number> = {
        return: 36, enter: 76, tab: 48, space: 49, delete: 51, escape: 53, esc: 53,
        left: 123, right: 124, down: 125, up: 126,
      }
      const focus = `se.processes.byName(${jxaString(app)}).frontmost = true;`
      let action: string
      if (key in namedKeyCodes) {
        action = `se.keyCode(${namedKeyCodes[key]}${using});`
      } else {
        action = `se.keystroke(${jxaString(key)}${using});`
      }
      await runJxa(`const se = Application('System Events'); ${focus} ${action} 'ok';`)
    },

    async focusApp(app: string): Promise<void> {
      const script = `
        const app = Application(${jxaString(app)});
        app.activate();
        'ok';
      `
      await runJxa(script)
    },

    async checkPermissions(): Promise<PermissionStatus> {
      // Accessibility: try a benign System Events read. If it throws with a
      // permission error (-1719 / not allowed), accessibility is off.
      let accessibility = false
      try {
        await runJxa(`const se = Application('System Events'); se.processes.length; 'ok';`, 5_000)
        accessibility = true
      } catch {
        accessibility = false
      }
      // Screen Recording can't be probed without side effects reliably; infer
      // from a tiny screencapture to a temp file (fails/blank when denied).
      let screenRecording = false
      const probe = join(tmpdir(), `rivet-cu-probe-${randomUUID()}.png`)
      try {
        await new Promise<void>((resolve, reject) => {
          execFile('screencapture', ['-x', '-R', '0,0,1,1', probe], { timeout: 5_000 }, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        const buf = await readFile(probe)
        screenRecording = buf.length > 0
      } catch {
        screenRecording = false
      } finally {
        try { await unlink(probe) } catch { /* best-effort */ }
      }
      const missing: string[] = []
      if (!accessibility) missing.push('Accessibility (System Settings → Privacy & Security → Accessibility)')
      if (!screenRecording) missing.push('Screen Recording (System Settings → Privacy & Security → Screen Recording)')
      const detail = missing.length === 0
        ? 'All required permissions granted.'
        : `Grant these permissions to Rivet/Tianshu, then retry: ${missing.join('; ')}.`
      return { accessibility, screenRecording, detail }
    },
  }
}
