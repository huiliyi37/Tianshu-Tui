import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type SpreadsheetFormat = 'csv' | 'tsv' | 'html' | 'xls'
export type SpreadsheetCell = string | number | boolean | null

export interface CreateSpreadsheetInput {
  destination_path?: string
  title?: string
  headers?: SpreadsheetCell[]
  rows?: SpreadsheetCell[][]
  format?: SpreadsheetFormat
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeCell(value: SpreadsheetCell): string {
  if (value === null) return ''
  return String(value)
}

function inferSpreadsheetFormat(destinationPath: string, explicit?: SpreadsheetFormat): SpreadsheetFormat {
  if (explicit) return explicit
  const ext = extname(destinationPath).toLowerCase()
  if (ext === '.tsv') return 'tsv'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.xls') return 'xls'
  return 'csv'
}

function escapeDelimitedCell(value: SpreadsheetCell, delimiter: ',' | '\t'): string {
  const text = normalizeCell(value)
  const mustQuote = delimiter === ','
    ? /[",\r\n]/.test(text)
    : /[\t\r\n]/.test(text)
  if (!mustQuote) return text
  return `"${text.replace(/"/g, '""')}"`
}

function renderDelimited(headers: SpreadsheetCell[] | undefined, rows: SpreadsheetCell[][], delimiter: ',' | '\t'): string {
  const lines: string[] = []
  if (headers && headers.length > 0) lines.push(headers.map(cell => escapeDelimitedCell(cell, delimiter)).join(delimiter))
  for (const row of rows) lines.push(row.map(cell => escapeDelimitedCell(cell, delimiter)).join(delimiter))
  return lines.join('\n') + '\n'
}

function renderHtmlSpreadsheet(title: string | undefined, headers: SpreadsheetCell[] | undefined, rows: SpreadsheetCell[][]): string {
  const safeTitle = escapeHtml(title ?? 'Spreadsheet')
  const thead = headers && headers.length > 0
    ? `<thead><tr>${headers.map(cell => `<th>${escapeHtml(normalizeCell(cell))}</th>`).join('')}</tr></thead>`
    : ''
  const tbody = `<tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(normalizeCell(cell))}</td>`).join('')}</tr>`).join('\n')}</tbody>`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${safeTitle}</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 32px; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #cbd5e1; padding: 6px 8px; text-align: left; }
th { background: #f1f5f9; }
caption { text-align: left; font-size: 1.25rem; font-weight: 700; margin-bottom: 12px; }
</style>
</head>
<body>
<table>
${title ? `<caption>${safeTitle}</caption>\n` : ''}${thead}
${tbody}
</table>
</body>
</html>
`
}

export function renderSpreadsheet(input: CreateSpreadsheetInput): { content: string; format: SpreadsheetFormat } {
  const destinationPath = input.destination_path ?? ''
  const format = inferSpreadsheetFormat(destinationPath, input.format)
  const headers = input.headers
  const rows = input.rows ?? []
  switch (format) {
    case 'csv': return { format, content: renderDelimited(headers, rows, ',') }
    case 'tsv': return { format, content: renderDelimited(headers, rows, '\t') }
    case 'html': return { format, content: renderHtmlSpreadsheet(input.title, headers, rows) }
    case 'xls': return { format, content: renderHtmlSpreadsheet(input.title, headers, rows) }
  }
}

export async function createSpreadsheet(input: CreateSpreadsheetInput): Promise<{ path: string; bytes: number; format: SpreadsheetFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  if (!Array.isArray(input.rows)) throw new Error('rows is required')
  if (input.headers !== undefined && !Array.isArray(input.headers)) throw new Error('headers must be an array')
  const rendered = renderSpreadsheet(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_SPREADSHEET_TOOL: Tool = {
  definition: {
    name: 'create_spreadsheet',
    description: `Create a basic spreadsheet/table at an external or project path.

First-version scope: CSV, TSV, HTML, and Excel-openable .xls (HTML table saved with .xls extension). Use open_path to open the result in the OS default app.

Examples:
Good: create_spreadsheet(destination_path="~/Desktop/report.csv", headers=["Name","Score"], rows=[["A", 10]])
Good: create_spreadsheet(destination_path="H:\\zhuomian\\白嫖gpt\\report.xls", title="Report", headers=["Name"], rows=[["天枢"]])`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Destination file path. May be outside the project.' },
        title: { type: 'string', description: 'Optional spreadsheet/table title.' },
        headers: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: 'Optional header row.' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } },
          description: 'Spreadsheet rows. Each row is an array of cells.',
        },
        format: { type: 'string', enum: ['csv', 'tsv', 'html', 'xls'], description: 'Optional output format. Defaults from file extension.' },
      },
      required: ['destination_path', 'rows'],
    },
  },

  async execute(params) {
    try {
      const result = await createSpreadsheet(params.input as CreateSpreadsheetInput)
      return { content: `Created ${result.format} spreadsheet (${result.bytes} bytes): ${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
