import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type DocumentFormat = 'txt' | 'md' | 'html' | 'doc'

export interface CreateDocumentInput {
  destination_path?: string
  title?: string
  content?: string
  format?: DocumentFormat
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inferDocumentFormat(destinationPath: string, explicit?: DocumentFormat): DocumentFormat {
  if (explicit) return explicit
  const ext = extname(destinationPath).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'md'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.doc') return 'doc'
  return 'txt'
}

function renderPlainText(title: string | undefined, content: string): string {
  return title ? `${title}\n\n${content}` : content
}

function renderMarkdown(title: string | undefined, content: string): string {
  if (!title) return content
  if (content.trimStart().startsWith('#')) return content
  return `# ${title}\n\n${content}`
}

function renderHtmlDocument(title: string | undefined, content: string): string {
  const safeTitle = escapeHtml(title ?? 'Document')
  const body = content
    .split(/\r?\n/)
    .map(line => line.trim().length === 0 ? '<p>&nbsp;</p>' : `<p>${escapeHtml(line)}</p>`)
    .join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; line-height: 1.6; margin: 40px; }
h1 { color: #0f172a; }
p { margin: 0 0 0.75em; }
</style>
</head>
<body>
${title ? `<h1>${safeTitle}</h1>\n` : ''}${body}
</body>
</html>
`
}

export function renderDocument(input: CreateDocumentInput): { content: string; format: DocumentFormat } {
  const destinationPath = input.destination_path ?? ''
  const format = inferDocumentFormat(destinationPath, input.format)
  const content = input.content ?? ''
  switch (format) {
    case 'txt': return { format, content: renderPlainText(input.title, content) }
    case 'md': return { format, content: renderMarkdown(input.title, content) }
    case 'html': return { format, content: renderHtmlDocument(input.title, content) }
    case 'doc': return { format, content: renderHtmlDocument(input.title, content) }
  }
}

export async function createDocument(input: CreateDocumentInput): Promise<{ path: string; bytes: number; format: DocumentFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  if (typeof input.content !== 'string') throw new Error('content is required')
  const rendered = renderDocument(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_DOCUMENT_TOOL: Tool = {
  definition: {
    name: 'create_document',
    description: `Create a basic user-facing document at an external or project path.

First-version scope: plain text, Markdown, HTML, and Word-openable .doc (HTML document saved with .doc extension). Use export_file/open_path for raw binary assets or opening the result.

Examples:
Good: create_document(destination_path="~/Desktop/report.doc", title="Report", content="Summary...")
Good: create_document(destination_path="H:\\zhuomian\\白嫖gpt\\notes.md", content="# Notes\\n...")`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Destination file path. May be outside the project.' },
        title: { type: 'string', description: 'Optional document title.' },
        content: { type: 'string', description: 'Document body text.' },
        format: { type: 'string', enum: ['txt', 'md', 'html', 'doc'], description: 'Optional output format. Defaults from file extension.' },
      },
      required: ['destination_path', 'content'],
    },
  },

  async execute(params) {
    try {
      const result = await createDocument(params.input as CreateDocumentInput)
      return { content: `Created ${result.format} document (${result.bytes} bytes): ${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
