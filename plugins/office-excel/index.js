/**
 * office-excel — Native .xlsx read/write via exceljs.
 *
 * Tools:
 *   xlsx_read  — Read .xlsx: list sheets, read cell data as markdown table.
 *   xlsx_write — Write a 2D array to a new .xlsx file.
 *
 * Dependencies are installed at plugin install time (npm install --ignore-scripts).
 */

import { existsSync } from 'node:fs'
import ExcelJS from 'exceljs'

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

    // Determine range
    let startRow = 1, startCol = 1
    let endRow = ws.rowCount, endCol = ws.columnCount

    if (rangeStart) {
      const cell = workbook.getWorksheet('_').getCell(rangeStart) // just to parse
      // ExcelJS cell addresses: parse manually
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
        if (val && typeof val === 'object' && 'result' in val) {
          // Formula result
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

function colToIndex(col) {
  let result = 0
  for (const ch of col.toUpperCase()) {
    result = result * 26 + (ch.charCodeAt(0) - 64)
  }
  return result
}

function padRight(str, len) {
  return str + ' '.repeat(Math.max(0, len - str.length))
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
      ws.addRow(rowData)
    }

    await workbook.xlsx.writeFile(filePath)

    return {
      content: `Written ${data.length} rows × ${data[0].length} cols to ${filePath} (sheet: "${sheetName}")`,
      rawPath: filePath,
    }
  } catch (err) {
    return { content: `Failed to write xlsx: ${err.message}`, isError: true }
  }
}

// ── Tool exports ───────────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'xlsx_read',
      description: 'Read a .xlsx file: list all sheets, or read a specific sheet as a markdown table. Supports range_start/range_end for large files.',
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
      description: 'Write a 2D array to a new .xlsx file. Row data can be strings, numbers, or booleans.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Destination .xlsx file path' },
          data: { type: 'array', items: { type: 'array' }, description: '2D array of cell values' },
          sheet_name: { type: 'string', description: 'Sheet name (default: Sheet1)' },
        },
        required: ['file_path', 'data'],
      },
    },
    execute: async (params) => xlsxWrite(params),
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
