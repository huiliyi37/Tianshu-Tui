import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type PresentationFormat = 'ppt'

export interface PresentationSlide {
  title?: string
  content?: string
}

export interface CreatePresentationInput {
  destination_path?: string
  title?: string
  slides?: PresentationSlide[]
  theme?: 'light' | 'dark'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderSlideHtml(slide: PresentationSlide, index: number, theme: 'light' | 'dark'): string {
  const bg = theme === 'dark' ? '#0f172a' : '#f8fafc'
  const fg = theme === 'dark' ? '#e2e8f0' : '#1e293b'
  const accent = theme === 'dark' ? '#38bdf8' : '#2563eb'
  const mutedFg = theme === 'dark' ? '#94a3b8' : '#64748b'

  const titleHtml = slide.title
    ? `<h1 style="font-size:2.25rem;margin:0 0 0.5em;color:${accent};font-weight:700">${escapeHtml(slide.title)}</h1>`
    : ''

  const contentHtml = slide.content
    ? `<div style="font-size:1.25rem;line-height:1.8;color:${fg}">${escapeHtml(slide.content)
        .split(/\r?\n\r?\n/)
        .map(p => p.trim().length === 0 ? '' : `<p style="margin:0 0 1em">${p.replace(/\r?\n/g, '<br>')}</p>`)
        .join('\n')}</div>`
    : ''

  const pageNum = `<div style="position:absolute;bottom:24px;right:40px;font-size:0.875rem;color:${mutedFg}">${index + 1}</div>`

  return `<section style="
  position:relative;
  width:100vw;max-width:960px;min-height:100vh;
  display:flex;flex-direction:column;justify-content:center;
  padding:60px 80px;box-sizing:border-box;
  background:${bg};color:${fg};
  page-break-after:always;
  break-after:page;
">
${titleHtml}
${contentHtml}
${pageNum}
</section>`
}

function renderPresentationHtml(input: CreatePresentationInput): string {
  const title = input.title ?? 'Presentation'
  const theme = input.theme ?? 'light'
  const slides = input.slides ?? []
  const bg = theme === 'dark' ? '#0f172a' : '#f8fafc'
  const fg = theme === 'dark' ? '#e2e8f0' : '#1e293b'

  const slidesHtml = slides.map((s, i) => renderSlideHtml(s, i, theme)).join('\n')

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  background:${bg}; color:${fg};
  display:flex; flex-direction:column; align-items:center;
}
@media print {
  body { background:white; }
  section { page-break-after:always; break-after:page; }
}
</style>
</head>
<body>
${slidesHtml}
</body>
</html>
`
}

export function renderPresentation(input: CreatePresentationInput): { content: string; format: PresentationFormat } {
  if (!Array.isArray(input.slides) || input.slides.length === 0) {
    throw new Error('slides must be a non-empty array')
  }
  return { format: 'ppt', content: renderPresentationHtml(input) }
}

export async function createPresentation(input: CreatePresentationInput): Promise<{ path: string; bytes: number; format: PresentationFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  const rendered = renderPresentation(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_PRESENTATION_TOOL: Tool = {
  definition: {
    name: 'create_presentation',
    description: `Create a presentation (slideshow) as an HTML file saved with .ppt extension. Opens in any browser.

Each slide is a full-screen section with title and content. Use for presentations, slide decks, and visual summaries.

Use open_path to open the result in the default browser.

Examples:
Good: create_presentation(destination_path="~/Desktop/deck.ppt", title="Q4 Review", slides=[{title:"Overview", content:"Key results..."}, {title:"Next Steps", content:"1. Launch\\n2. Iterate"}])
Good: create_presentation(destination_path="~/Desktop/dark-deck.ppt", title="Pitch", slides=[{title:"Problem", content:"..."}], theme="dark")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Destination file path. Should end with .ppt or .html. May be outside the project.' },
        title: { type: 'string', description: 'Optional presentation title (used in browser title bar and HTML title).' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide heading.' },
              content: { type: 'string', description: 'Slide body text. Use \\n for line breaks, double \\n\\n for paragraphs.' },
            },
          },
          description: 'Slides in order. Each slide has a title and content.',
        },
        theme: { type: 'string', enum: ['light', 'dark'], description: 'Color theme. Default: light.' },
      },
      required: ['destination_path', 'slides'],
    },
  },

  async execute(params) {
    try {
      const result = await createPresentation(params.input as CreatePresentationInput)
      return { content: `Created ${result.format} presentation with slides (${result.bytes} bytes): ${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
