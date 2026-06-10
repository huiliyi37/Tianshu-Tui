import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type PdfFormat = 'html'

export type PageSize = 'A4' | 'Letter'

export interface CreatePdfInput {
  destination_path?: string
  content?: string
  title?: string
  orientation?: 'portrait' | 'landscape'
  pageSize?: PageSize
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const PAGE_SIZE_CSS: Record<PageSize, string> = {
  A4: '210mm 297mm',
  Letter: '8.5in 11in',
}

function renderPdfHtml(input: CreatePdfInput): string {
  const title = input.title ?? 'Document'
  const content = input.content ?? ''
  const orientation = input.orientation ?? 'portrait'
  const pageSize = input.pageSize ?? 'A4'
  const pageSizeValue = PAGE_SIZE_CSS[pageSize]

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }

@page {
  size: ${pageSizeValue} ${orientation};
  margin: 20mm 18mm;
}

body {
  font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  font-size: 12pt;
  line-height: 1.7;
  color: #1e293b;
  max-width: ${orientation === 'landscape' ? '240mm' : '170mm'};
  margin: 0 auto;
  padding: 20mm 0;
}

h1 { font-size: 1.75rem; margin: 0 0 0.5em; color: #0f172a; page-break-after: avoid; }
h2 { font-size: 1.35rem; margin: 1.2em 0 0.4em; color: #334155; page-break-after: avoid; }
h3 { font-size: 1.15rem; margin: 1em 0 0.3em; color: #475569; page-break-after: avoid; }
p { margin: 0 0 0.75em; orphans:3; widows:3; }
ul, ol { margin: 0 0 0.75em; padding-left: 1.5em; }
li { margin-bottom: 0.25em; }
pre {
  background: #f1f5f9; border:1px solid #e2e8f0; border-radius:6px;
  padding:12px 16px; font-size:0.85rem; overflow-x:auto;
  page-break-inside:avoid;
}
code { font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace; font-size:0.9em; }
table { border-collapse:collapse; width:100%; margin:0.75em 0; }
th, td { border:1px solid #cbd5e1; padding:6px 10px; text-align:left; }
th { background:#f8fafc; font-weight:600; }
.page-break { page-break-after:always; break-after:page; }

@media print {
  body { padding:0; margin:0; }
}
</style>
</head>
<body>
${content}
</body>
</html>
`
}

export function renderPdf(input: CreatePdfInput): { content: string; format: PdfFormat } {
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new Error('content is required')
  }
  return { format: 'html', content: renderPdfHtml(input) }
}

export async function createPdf(input: CreatePdfInput): Promise<{ path: string; bytes: number; format: PdfFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    throw new Error('content is required')
  }
  const rendered = renderPdf(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_PDF_TOOL: Tool = {
  definition: {
    name: 'create_pdf',
    description: `Create a print-ready HTML document with professional typography and @page rules. Open in any browser and print to PDF (Ctrl+P / Cmd+P → Save as PDF).

Supports A4 and Letter page sizes, portrait and landscape orientation. Content is raw HTML — use standard HTML tags for structure.

Use open_path to open the result in the default browser, then print to PDF.

Examples:
Good: create_pdf(destination_path="~/Desktop/report.html", title="Q4 Report", content="<h1>Q4 Report</h1><p>Revenue grew 15%...</p>")
Good: create_pdf(destination_path="~/Desktop/invoice.html", title="Invoice #42", content="<table>...</table>", pageSize="Letter")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Destination file path. Should end with .html. May be outside the project. Open in browser and print to PDF.' },
        title: { type: 'string', description: 'Document title (used in browser title bar).' },
        content: { type: 'string', description: 'HTML body content. Use standard HTML tags (h1-h3, p, ul, ol, table, pre, code, div.page-break).' },
        orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Page orientation. Default: portrait.' },
        pageSize: { type: 'string', enum: ['A4', 'Letter'], description: 'Page size for @page CSS. Default: A4.' },
      },
      required: ['destination_path', 'content'],
    },
  },

  async execute(params) {
    try {
      const result = await createPdf(params.input as CreatePdfInput)
      return { content: `Created print-ready ${result.format} document (${result.bytes} bytes): ${result.path}\n\nOpen in browser and print to PDF (Cmd+P → Save as PDF).` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
