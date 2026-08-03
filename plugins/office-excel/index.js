/**
 * office-excel — Native .xlsx read/write/edit via exceljs.
 *
 * Tools:
 *   xlsx_read  — Read .xlsx: list sheets, read cell data as markdown table.
 *   xlsx_write — Write a 2D array to a new .xlsx file (formulas + basic styles).
 *   xlsx_edit  — Edit an existing .xlsx: add sheets, update cells, append rows.
 *
 * Dependencies are installed at plugin install time (npm install --ignore-scripts).
 */

import { existsSync } from 'node:fs'
import ExcelJS from 'exceljs'

// ── shared helpers ─────────────────────────────────────────────────

function colToIndex(col) {
  if (typeof col !== 'string' || col.length === 0) return -1
  let result = 0
  for (const ch of col.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64)
  }
  return result
}

function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length))
}

// Cell values may be plain scalars or { formula: 'SUM(A1:A9)' } objects.
function applyCellValue(cell, val) {
  if (val && typeof val === 'object' && 'formula' in val) {
    const formula = String(val.formula).replace(/^=/, '')
    cell.value = val.result !== undefined
      ? { formula, result: val.result }
      : { formula }
  } else {
    cell.value = val ?? null
  }
}

function addRowValues(ws, rowData) {
  const row = ws.addRow([])
  rowData.forEach((val, i) => applyCellValue(row.getCell(i + 1), val))
}

// Basic styling: header_bold, column_widths, number_formats ({ B: '#,##0.00' }).
function applyStyles(ws, params) {
  if (params?.header_bold && ws.rowCount >= 1) {
    ws.getRow(1).font = { bold: true }
  }
  const widths = params?.column_widths
  if (Array.isArray(widths)) {
    widths.forEach((w, i) => {
      if (typeof w === 'number' && w > 0) ws.getColumn(i + 1).width = w
    })
  }
  const formats = params?.number_formats
  if (formats && typeof formats === 'object') {
    for (const [col, fmt] of Object.entries(formats)) {
      ws.getColumn(colToIndex(col)).numFmt = String(fmt)
    }
  }
}

const styleSchema = {
  header_bold: { type: 'boolean', description: 'Bold the first row' },
  column_widths: { type: 'array', items: { type: 'number' }, description: 'Column widths by position, e.g. [12, 20, 20]' },
  number_formats: { type: 'object', description: 'numFmt per column letter, e.g. { "B": "#,##0.00" }' },
}

// ── xlsx_read ──────────────────────────────────────────────────────

async function xlsxRead(params) {
  const filePath = params?.file_path
  if (!filePath || !existsSync(filePath)) {
    return { content: `File not found: ${filePath}`, isError: true }
  }

  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const sheetName = params?.sheet
    const rangeStart = params?.range_start // e.g. "A1"
    const rangeEnd = params?.range_end     // e.g. "D20"

    // List sheets mode
    if (!sheetName) {
      const sheets = workbook.worksheets.map(ws => ({
        name: ws.name,
        rows: ws.rowCount,
        cols: ws.columnCount,
      }))
      const lines = [
        `Workbook: ${filePath}`,
        `Sheets: ${sheets.length}`,
        '',
        ...sheets.map(s => `  ${s.name} — ${s.rows} rows × ${s.cols} cols`),
        '',
        'Use sheet parameter to read a specific sheet. Add range_start/range_end for partial read.',
      ]
      return { content: lines.join('\n'), rawPath: filePath }
    }

    // Read sheet mode
    const ws = workbook.getWorksheet(sheetName)
    if (!ws) {
      const available = workbook.worksheets.map(w => w.name).join(', ')
      return { content: `Sheet "${sheetName}" not found. Available: ${available}`, isError: true }
    }

    // Determine range — ExcelJS cell addresses: parse manually
    let startRow = 1, startCol = 1
    let endRow = ws.rowCount, endCol = ws.columnCount

    if (rangeStart) {
      const match = rangeStart.match(/^([A-Z]+)(\d+)$/i)
      if (match) {
        startCol = colToIndex(match[1])
        startRow = parseInt(match[2], 10)
      }
    }
    if (rangeEnd) {
      const match = rangeEnd.match(/^([A-Z]+)(\d+)$/i)
      if (match) {
        endCol = colToIndex(match[1])
        endRow = parseInt(match[2], 10)
      }
    }

    // Clamp
    endRow = Math.min(endRow, ws.rowCount)
    endCol = Math.min(endCol, ws.columnCount || 26)

    // Read cells into markdown table
    const rows = []
    for (let r = startRow; r <= endRow; r++) {
      const row = ws.getRow(r)
      const cells = []
      for (let c = startCol; c <= endCol; c++) {
        const cell = row.getCell(c)
        const val = cell.value
        if (val && typeof val === 'object' && 'formula' in val) {
          // Formula cell: show cached result when present, always keep formula text
          const text = `=${val.formula}`
          cells.push(val.result !== undefined && val.result !== null ? `${val.result} (${text})` : text)
        } else if (val && typeof val === 'object' && 'result' in val) {
          cells.push(String(val.result ?? ''))
        } else if (val !== null && val !== undefined) {
          cells.push(String(val))
        } else {
          cells.push('')
        }
      }
      rows.push(cells)
    }

    if (rows.length === 0) {
      return { content: `Sheet "${sheetName}" is empty.`, rawPath: filePath }
    }

    // Render markdown table (truncate at 200 rows for context safety)
    const maxRows = Math.min(rows.length, 200)
    const displayRows = rows.slice(0, maxRows)
    const colWidths = []
    for (let c = 0; c < (displayRows[0]?.length || 0); c++) {
      let max = 3
      for (const row of displayRows) {
        max = Math.max(max, (row[c] || '').length)
      }
      colWidths.push(Math.min(max, 40))
    }

    const mdRows = displayRows.map((row, i) => {
      const cells = row.map((cell, ci) => padRight(String(cell).slice(0, 40), colWidths[ci] || 3))
      return '| ' + cells.join(' | ') + ' |'
    })

    // Header separator
    if (mdRows.length > 0) {
      const sep = '|' + colWidths.map(w => '-'.repeat(w + 2)).join('|') + '|'
      mdRows.splice(1, 0, sep)
    }

    const suffix = rows.length > maxRows
      ? `\n\n(Showing ${maxRows} of ${rows.length} rows. Use range_start/range_end for pagination.)`
      : ''

    return {
      content: `Sheet "${sheetName}" (${rows.length} rows × ${endCol - startCol + 1} cols):\n\n${mdRows.join('\n')}${suffix}`,
      rawPath: filePath,
    }
  } catch (err) {
    return { content: `Failed to read xlsx: ${err.message}`, isError: true }
  }
}

// ── xlsx_write ─────────────────────────────────────────────────────

async function xlsxWrite(params) {
  const filePath = params?.file_path || params?.destination_path
  if (!filePath) {
    return { content: 'Missing file_path parameter', isError: true }
  }

  const data = params?.data
  if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[0])) {
    return { content: 'Missing or invalid data: expected 2D array', isError: true }
  }

  try {
    const workbook = new ExcelJS.Workbook()
    const sheetName = params?.sheet_name || 'Sheet1'
    const ws = workbook.addWorksheet(sheetName)

    for (const rowData of data) {
      addRowValues(ws, rowData)
    }

    applyStyles(ws, params)

    await workbook.xlsx.writeFile(filePath)

    return {
      content: `Written ${data.length} rows × ${data[0].length} cols to ${filePath} (sheet: "${sheetName}")`,
      rawPath: filePath,
    }
  } catch (err) {
    return { content: `Failed to write xlsx: ${err.message}`, isError: true }
  }
}

// ── xlsx_edit ──────────────────────────────────────────────────────

async function xlsxEdit(params) {
  const filePath = params?.file_path
  if (!filePath || !existsSync(filePath)) {
    return { content: `File not found: ${filePath}`, isError: true }
  }

  const operations = params?.operations
  if (!Array.isArray(operations) || operations.length === 0) {
    return { content: 'Missing or invalid operations: expected non-empty array', isError: true }
  }

  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const applied = []
    for (const op of operations) {
      switch (op?.action) {
        case 'add_sheet': {
          const name = op.name
          if (!name || typeof name !== 'string') {
            return { content: 'add_sheet requires a name string', isError: true }
          }
          if (workbook.getWorksheet(name)) {
            applied.push(`sheet "${name}" already exists — skipped`)
          } else {
            workbook.addWorksheet(name)
            applied.push(`added sheet "${name}"`)
          }
          break
        }
        case 'update_cells': {
          const ws = workbook.getWorksheet(op.sheet)
          if (!ws) {
            const available = workbook.worksheets.map(w => w.name).join(', ')
            return { content: `Sheet "${op.sheet}" not found. Available: ${available}`, isError: true }
          }
          if (!Array.isArray(op.cells) || op.cells.length === 0) {
            return { content: 'update_cells requires a non-empty cells array', isError: true }
          }
          for (const c of op.cells) {
            if (!c?.cell) {
              return { content: 'update_cells: each entry needs a cell address (e.g. "B2")', isError: true }
            }
            applyCellValue(ws.getCell(c.cell), 'formula' in c ? { formula: c.formula } : c.value)
          }
          applied.push(`updated ${op.cells.length} cell(s) in "${op.sheet}"`)
          break
        }
        case 'append_rows': {
          const ws = workbook.getWorksheet(op.sheet)
          if (!ws) {
            const available = workbook.worksheets.map(w => w.name).join(', ')
            return { content: `Sheet "${op.sheet}" not found. Available: ${available}`, isError: true }
          }
          if (!Array.isArray(op.rows) || op.rows.length === 0 || !Array.isArray(op.rows[0])) {
            return { content: 'append_rows requires a non-empty 2D rows array', isError: true }
          }
          for (const rowData of op.rows) {
            addRowValues(ws, rowData)
          }
          applied.push(`appended ${op.rows.length} row(s) to "${op.sheet}"`)
          break
        }
        default:
          return { content: `Unknown action: ${op?.action}. Supported: add_sheet, update_cells, append_rows`, isError: true }
      }
    }

    // Optional styles apply to style_sheet (default: first worksheet)
    if (params?.header_bold || params?.column_widths || params?.number_formats) {
      const styleWs = params?.style_sheet
        ? workbook.getWorksheet(params.style_sheet)
        : workbook.worksheets[0]
      if (!styleWs) {
        return { content: `Sheet "${params.style_sheet}" not found for styling`, isError: true }
      }
      applyStyles(styleWs, params)
      applied.push(`applied styles to "${styleWs.name}"`)
    }

    const outPath = params?.output_path || filePath
    await workbook.xlsx.writeFile(outPath)

    return {
      content: `Edited ${filePath}${outPath !== filePath ? ` → ${outPath}` : ''}\n${applied.map(a => `  - ${a}`).join('\n')}`,
      rawPath: outPath,
    }
  } catch (err) {
    return { content: `Failed to edit xlsx: ${err.message}`, isError: true }
  }
}

// ── Tool exports ───────────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'xlsx_read',
      description: 'Read a .xlsx file: list all sheets, or read a specific sheet as a markdown table. Supports range_start/range_end for large files. Formula cells show the formula text.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .xlsx file' },
          sheet: { type: 'string', description: 'Sheet name to read (omit to list sheets)' },
          range_start: { type: 'string', description: 'Start cell e.g. "A1"' },
          range_end: { type: 'string', description: 'End cell e.g. "D20"' },
        },
        required: ['file_path'],
      },
    },
    execute: async (params) => xlsxRead(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'xlsx_write',
      description: 'Write a 2D array to a new .xlsx file. Cell values can be strings, numbers, booleans, or { formula: "SUM(A1:A9)" } objects. Supports header_bold / column_widths / number_formats.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Destination .xlsx file path' },
          data: { type: 'array', items: { type: 'array' }, description: '2D array of cell values; use { formula: "..." } for formula cells' },
          sheet_name: { type: 'string', description: 'Sheet name (default: Sheet1)' },
          ...styleSchema,
        },
        required: ['file_path', 'data'],
      },
    },
    execute: async (params) => xlsxWrite(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'xlsx_edit',
      description: 'Edit an existing .xlsx file: add sheets, update individual cells (value or formula), append rows. Saves back to file_path unless output_path is given.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the existing .xlsx file' },
          output_path: { type: 'string', description: 'Save to a different path instead of overwriting' },
          operations: {
            type: 'array',
            description: 'Ordered edit operations',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', enum: ['add_sheet', 'update_cells', 'append_rows'] },
                name: { type: 'string', description: 'add_sheet: new sheet name' },
                sheet: { type: 'string', description: 'update_cells/append_rows: target sheet name' },
                cells: { type: 'array', description: 'update_cells: [{ cell: "B2", value: 42 } or { cell: "B3", formula: "SUM(B1:B2)" }]' },
                rows: { type: 'array', items: { type: 'array' }, description: 'append_rows: 2D array of cell values' },
              },
              required: ['action'],
            },
          },
          style_sheet: { type: 'string', description: 'Sheet the style options apply to (default: first sheet)' },
          ...styleSchema,
        },
        required: ['file_path', 'operations'],
      },
    },
    execute: async (params) => xlsxEdit(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
  },
]
