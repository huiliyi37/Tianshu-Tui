// tianshu-design — frontend design plugin (Codex Product Design parity)
// Multi-viewport preview, visual diff, palette extraction, responsive audit.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findChromeBinary, chromeNotFoundMessage } from './lib/chrome.js'

function toDataUrl(pngPath) {
  return `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`
}

function chromeGuard() {
  if (!findChromeBinary()) {
    return { content: chromeNotFoundMessage(), isError: true }
  }
  return null
}

/** Lazy-import a lib module so the plugin registers (and each tool reports an
 *  actionable error) even when node_modules is missing or install failed —
 *  a top-level import chain would make the whole plugin silently skip. */
async function importLib(relPath) {
  try {
    return await import(relPath)
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'Plugin dependencies missing. Run "npm install --ignore-scripts --omit=dev" in the tianshu-design plugin directory, then retry.',
      )
    }
    throw err
  }
}

/** Output dir default: next to the HTML prototype, or .rivet/design under
 *  cwd for URL targets. (dirname(resolve('.')) was the PARENT of cwd —
 *  screenshots landed outside the workspace.) */
function resolveOutputDir(outputPath, filePath) {
  if (outputPath) {
    return outputPath.endsWith('.png') ? dirname(resolve(outputPath)) : resolve(outputPath)
  }
  if (filePath) return dirname(resolve(filePath))
  return join(process.cwd(), '.rivet', 'design')
}

async function uiPreview(params) {
  const filePath = params?.file_path
  const url = params?.url
  if (!filePath && !url) {
    return { content: 'Error: provide file_path (local HTML) or url', isError: true }
  }
  if (filePath && !existsSync(filePath)) {
    return { content: `Error: file not found: ${filePath}`, isError: true }
  }
  const guard = chromeGuard()
  if (guard) return guard

  const outputDir = resolveOutputDir(params?.output_path, filePath)

  try {
    const { capturePreviews } = await importLib('./lib/preview.js')
    const shots = await capturePreviews({
      filePath,
      url,
      viewports: Array.isArray(params?.viewports) ? params.viewports : undefined,
      fullPage: params?.full_page === true,
      outputDir,
    })
    const lines = shots.map(s => `- ${s.viewport} (${s.width}x${s.height}): ${s.path}`)
    const images = shots.map(s => toDataUrl(s.path))
    return {
      content: [
        `Captured ${shots.length} viewport screenshot(s):`,
        ...lines,
        '',
        'Use ui_diff against a reference mockup, or ui_responsive_audit for layout issues.',
      ].join('\n'),
      rawPath: shots[0]?.path,
      images,
    }
  } catch (err) {
    return { content: `ui_preview failed: ${err.message}`, isError: true }
  }
}

async function uiDiff(params) {
  const reference = params?.reference_path || params?.file_path
  const actual = params?.actual_path
  const outputPath = params?.output_path
  if (!reference || !actual) {
    return { content: 'Error: reference_path and actual_path are required', isError: true }
  }
  if (!existsSync(reference)) return { content: `Error: reference not found: ${reference}`, isError: true }
  if (!existsSync(actual)) return { content: `Error: actual not found: ${actual}`, isError: true }

  try {
    const { compareImageFiles } = await importLib('./lib/diff.js')
    const result = compareImageFiles(reference, actual)
    if (!result.ok) {
      return { content: result.error, isError: true }
    }
    const diffOut = outputPath || actual.replace(/\.png$/i, '') + '.diff.png'
    writeFileSync(diffOut, result.diffPng)
    const matchPercent = Math.round((100 - result.mismatchPercent) * 100) / 100
    return {
      content: [
        `Visual diff (${result.width}x${result.height}):`,
        `- Mismatch: ${result.mismatchPercent}% (${result.mismatchedPixels}/${result.totalPixels} pixels)`,
        `- Match: ${matchPercent}%`,
        `- Diff image: ${diffOut}`,
        result.mismatchPercent > 5
          ? 'Significant visual drift — iterate layout/spacing/colors before delivery.'
          : 'Within tolerance — minor anti-aliasing differences are excluded from the score.',
      ].join('\n'),
      rawPath: diffOut,
      images: [toDataUrl(diffOut)],
    }
  } catch (err) {
    return { content: `ui_diff failed: ${err.message}`, isError: true }
  }
}

async function uiPalette(params) {
  const filePath = params?.file_path
  if (!filePath) return { content: 'Error: file_path is required', isError: true }
  if (!existsSync(filePath)) return { content: `Error: file not found: ${filePath}`, isError: true }

  const maxColors = typeof params?.max_colors === 'number' ? Math.min(16, Math.max(2, params.max_colors)) : 8
  try {
    const { extractPaletteFromFile } = await importLib('./lib/palette.js')
    const { colors, cssVariables, tailwindSnippet } = extractPaletteFromFile(filePath, maxColors)
    const swatches = colors.map(c => `- ${c.hex} (${c.percent}% of sampled pixels)`).join('\n')
    return {
      content: [
        `Extracted ${colors.length} dominant colors from ${filePath}:`,
        swatches,
        '',
        'CSS variables:',
        cssVariables,
        '',
        'Tailwind extend snippet:',
        tailwindSnippet,
      ].join('\n'),
    }
  } catch (err) {
    const hint = /invalid|signature|unrecognised|unexpected/i.test(err.message)
      ? ' (only PNG input is supported — convert JPEG/WebP to PNG first, e.g. via ui_preview screenshot)'
      : ''
    return { content: `ui_palette failed: ${err.message}${hint}`, isError: true }
  }
}

async function uiResponsiveAudit(params) {
  const filePath = params?.file_path
  const url = params?.url
  if (!filePath && !url) {
    return { content: 'Error: provide file_path or url', isError: true }
  }
  if (filePath && !existsSync(filePath)) {
    return { content: `Error: file not found: ${filePath}`, isError: true }
  }
  const guard = chromeGuard()
  if (guard) return guard

  const outputDir = resolveOutputDir(params?.output_path, filePath)

  try {
    const { runResponsiveAudit } = await importLib('./lib/responsive.js')
    const { reports, totalIssues } = await runResponsiveAudit({ filePath, url, outputDir })
    const lines = []
    /** @type {string[]} */
    const images = []
    for (const r of reports) {
      lines.push(`## ${r.viewport}`)
      if (r.issues.length === 0) {
        lines.push('- No issues detected')
      } else {
        for (const issue of r.issues) {
          lines.push(`- [${issue.severity}] ${issue.type}: ${issue.count} finding(s)`)
          if (issue.samples?.length) {
            lines.push(`  sample: ${JSON.stringify(issue.samples[0])}`)
          }
        }
      }
      lines.push(`  screenshot: ${r.screenshot}`)
      images.push(toDataUrl(r.screenshot))
    }
    return {
      content: [
        `Responsive audit complete — ${totalIssues} issue group(s) across ${reports.length} viewports.`,
        '',
        ...lines,
      ].join('\n'),
      rawPath: reports[0]?.screenshot,
      images,
    }
  } catch (err) {
    return { content: `ui_responsive_audit failed: ${err.message}`, isError: true }
  }
}

export const tools = [
  {
    definition: {
      name: 'ui_preview',
      description: 'Render local HTML or a URL to PNG screenshots at mobile/tablet/desktop viewports. Returns image previews for visual verification.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to a local .html file' },
          url: { type: 'string', description: 'URL to load (requires net permission)' },
          viewports: {
            type: 'array',
            items: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] },
            description: 'Viewports to capture (default: all three)',
          },
          full_page: { type: 'boolean', description: 'Capture full scrollable page (default: viewport only)' },
          output_path: { type: 'string', description: 'Directory for PNG output (default: same dir as HTML, or .rivet/design for URLs)' },
        },
      },
    },
    execute: uiPreview,
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'ui_diff',
      description: 'Pixel-level visual diff between a reference mockup and an implementation screenshot (PNG). Outputs mismatch percentage and a diff highlight image.',
      input_schema: {
        type: 'object',
        properties: {
          reference_path: { type: 'string', description: 'Reference/mockup PNG path' },
          actual_path: { type: 'string', description: 'Implementation screenshot PNG path' },
          output_path: { type: 'string', description: 'Where to write the diff PNG (default: actual.diff.png)' },
        },
        required: ['reference_path', 'actual_path'],
      },
    },
    execute: uiDiff,
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'ui_palette',
      description: 'Extract dominant colors from a PNG reference image or screenshot. Returns hex swatches plus CSS variables and Tailwind theme snippets.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'PNG image to analyze (convert JPEG to PNG first)' },
          max_colors: { type: 'number', description: 'Max palette size (2-16, default 8)' },
        },
        required: ['file_path'],
      },
    },
    execute: uiPalette,
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'ui_responsive_audit',
      description: 'Run a responsive layout audit at mobile/tablet/desktop: horizontal overflow, small touch targets, small fonts. Returns issue list + per-viewport screenshots.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to local HTML prototype' },
          url: { type: 'string', description: 'URL to audit' },
          output_path: { type: 'string', description: 'Directory for audit screenshots' },
        },
      },
    },
    execute: uiResponsiveAudit,
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
]
