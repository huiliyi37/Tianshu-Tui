/**
 * computer_use — macOS GUI automation tool (Codex Computer Use parity).
 *
 * Lets the agent see and operate graphical apps when CLI / structured
 * integrations aren't enough: inspect a desktop app's accessibility tree,
 * click elements, type, send key combos, focus apps.
 *
 * Security model (mirrors the browser tool's fail-closed posture):
 *  - Per-app approval: any action targeting an app WITHOUT an "always allow"
 *    grant requires explicit human approval (requiresApproval → true).
 *  - Dual-channel perception: the accessibility TREE is returned to the model
 *    (text); the SCREENSHOT is persisted as a viewable artifact for the user
 *    and never fed back to the model.
 *  - Secret hygiene: secure text fields and secret-looking values are masked
 *    in the model-facing tree.
 *  - macOS only (darwin gated); disabled elsewhere.
 */

import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import {
  createMacosDriver,
  type ComputerUseDriver,
  type ComputerUseDriverFactory,
  type ClickTarget,
} from './macos-driver.js'
import { isAppGranted } from './app-grants.js'

export type ComputerUseAction =
  | 'list_apps'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'key'
  | 'focus_app'
  | 'check_permissions'

export interface ComputerUseToolOptions {
  /** Builds the platform driver. Defaults to the macOS osascript driver. */
  driverFactory?: ComputerUseDriverFactory
  /** Whether the tool is registered/visible. Defaults to darwin only. */
  enabled?: boolean
  /** App grant lookup (injectable for tests). Defaults to persisted grants. */
  isAppGranted?: (app: string) => boolean
  /** Platform override (tests). Defaults to process.platform. */
  platform?: NodeJS.Platform
}

/** Mask secret-looking values in accessibility text (tokens/keys/passwords). */
const SECRET_RE = /\b([A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9]+|ghp_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)\b/g

function redactTree(tree: string): string {
  return tree
    // Secure text fields expose masked bullets already, but AXValue can leak —
    // blank any value attached to a secure field role.
    .replace(/(AXSecureTextField[^\n]*=)\s*\S.*/g, '$1 ***')
    .replace(SECRET_RE, '***')
}

function actionRequiresApproval(action: ComputerUseAction): boolean {
  // check_permissions is a pure local capability probe (no app interaction).
  return action !== 'check_permissions'
}

export function createComputerUseTool(options: ComputerUseToolOptions = {}): Tool {
  const platform = options.platform ?? process.platform
  const isDarwin = platform === 'darwin'
  const enabled = options.enabled ?? isDarwin
  const driverFactory = options.driverFactory ?? createMacosDriver
  const grantLookup = options.isAppGranted ?? ((app: string) => isAppGranted(app))

  function targetApp(input: Record<string, unknown>): string {
    const app = input.app
    return typeof app === 'string' ? app.trim() : ''
  }

  return {
    definition: {
      name: 'computer_use',
      description: `Operate macOS graphical apps: inspect an app's accessibility tree, click elements, type text, send key combos, focus apps. Use ONLY when CLI tools, MCP servers, or structured integrations can't do the job (e.g. a native app with no API, a GUI-only setting, or reproducing a UI-only bug) — prefer structured tools whenever available.

Every action on an app requires human approval unless that app is already granted "always allow". Screenshots are saved as viewable artifacts; the accessibility tree (text) is what you reason over.

Actions:
- check_permissions: report Accessibility / Screen Recording status (no approval).
- list_apps: list visible apps.
- snapshot(app): return the app's numbered accessibility tree + save a screenshot artifact.
- click(app, ref|x,y): click a snapshot element ref (preferred) or coordinates.
- type(app, text): type text into the focused field.
- key(app, combo): send a key combo like "cmd+s" or "return".
- focus_app(app): bring an app to the foreground.`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['check_permissions', 'list_apps', 'snapshot', 'click', 'type', 'key', 'focus_app'],
            description: 'What to do.',
          },
          app: { type: 'string', description: 'Target app name (required for all actions except list_apps/check_permissions).' },
          ref: { type: 'number', description: 'Snapshot element ref to click (from a prior snapshot).' },
          x: { type: 'number', description: 'Click X coordinate (screen pixels) when no ref is given.' },
          y: { type: 'number', description: 'Click Y coordinate (screen pixels) when no ref is given.' },
          text: { type: 'string', description: 'Text to type (type action).' },
          combo: { type: 'string', description: 'Key combo like "cmd+s", "shift+cmd+4", "return" (key action).' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      if (platform !== 'darwin') {
        return {
          content: 'computer_use is only available on macOS. This host is not darwin.',
          isError: true,
        }
      }
      const action = params.input.action as ComputerUseAction
      const app = targetApp(params.input)

      let driver: ComputerUseDriver
      try {
        driver = driverFactory()
      } catch (err) {
        return { content: `computer_use driver init failed: ${(err as Error).message}`, isError: true }
      }

      try {
        switch (action) {
          case 'check_permissions': {
            const perm = await driver.checkPermissions()
            return {
              content:
                `Accessibility: ${perm.accessibility ? 'granted' : 'MISSING'}\n` +
                `Screen Recording: ${perm.screenRecording ? 'granted' : 'MISSING'}\n${perm.detail}`,
            }
          }
          case 'list_apps': {
            const apps = await driver.listApps()
            if (apps.length === 0) return { content: 'No visible apps found.' }
            const lines = apps.map((a) => `- ${a.name}${a.frontmost ? ' (frontmost)' : ''}`)
            return { content: `Visible apps:\n${lines.join('\n')}` }
          }
          case 'snapshot': {
            if (!app) return { content: 'snapshot requires "app".', isError: true }
            const snap = await driver.snapshot(app)
            let artifactId: string | undefined
            if (snap.screenshotPng && params.artifactStore) {
              artifactId = await params.artifactStore.save({
                tool: 'computer_use_screenshot',
                target: `${app}-screenshot.png`,
                rawContent: snap.screenshotPng.toString('base64'),
                summary: `Screenshot of ${app}`,
                sections: [],
              })
            }
            const tree = redactTree(snap.tree)
            return {
              content:
                `Accessibility tree for ${app}` +
                (artifactId ? ` (screenshot → artifact ${artifactId})` : ' (screenshot unavailable)') +
                `:\n\n${tree}`,
            }
          }
          case 'click': {
            if (!app) return { content: 'click requires "app".', isError: true }
            const ref = params.input.ref
            const x = params.input.x
            const y = params.input.y
            let target: ClickTarget
            if (typeof ref === 'number') {
              target = { ref }
            } else if (typeof x === 'number' && typeof y === 'number') {
              target = { x, y }
            } else {
              return { content: 'click requires "ref" (from a snapshot) or both "x" and "y".', isError: true }
            }
            await driver.click(app, target)
            const where = 'ref' in target ? `ref ${target.ref}` : `(${target.x}, ${target.y})`
            return { content: `Clicked ${where} in ${app}.` }
          }
          case 'type': {
            if (!app) return { content: 'type requires "app".', isError: true }
            const text = params.input.text
            if (typeof text !== 'string' || text.length === 0) {
              return { content: 'type requires non-empty "text".', isError: true }
            }
            await driver.type(app, text)
            return { content: `Typed ${text.length} character(s) into ${app}.` }
          }
          case 'key': {
            if (!app) return { content: 'key requires "app".', isError: true }
            const combo = params.input.combo
            if (typeof combo !== 'string' || !combo.trim()) {
              return { content: 'key requires a "combo" like "cmd+s".', isError: true }
            }
            await driver.key(app, combo.trim())
            return { content: `Sent ${combo} to ${app}.` }
          }
          case 'focus_app': {
            if (!app) return { content: 'focus_app requires "app".', isError: true }
            await driver.focusApp(app)
            return { content: `Focused ${app}.` }
          }
          default:
            return { content: `Unknown computer_use action: ${action}`, isError: true }
        }
      } catch (err) {
        return { content: `computer_use failed: ${(err as Error).message}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as ComputerUseAction
      if (!actionRequiresApproval(action)) return false
      // list_apps has no single app target — always gate (reveals running apps).
      const app = targetApp(params.input)
      if (!app) return true
      // Per-app "always allow" grant skips the prompt (fail-closed default).
      return !grantLookup(app)
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: () => 30_000,
  }
}

export const COMPUTER_USE_TOOL: Tool = createComputerUseTool()
