// office-pdf: Native PDF generation (pdfkit) + text extraction (pdf-parse)
// Replaces the browser-print HTML fallback (create_pdf).

import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

// ── Helpers ──────────────────────────────────────────────────────

function artifactHint(filePath, summary) {
  return [
    `📄 PDF: ${summary}`,
    `   File: ${filePath}`,
    `   Use read_file to inspect, or open_path to view.`,
  ].join('\n')
}

function toCellText(val) {
  if (val === null || val === undefined) return ''
  return String(val)
}

// ── pdf_create ──────────────────────────────────────────────────

/** @param {import('pdfkit')} PDFDocument */
async function generatePdf(filePath, input) {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ size: 'A4', margin: 50 })
  const buffers = []

  return new Promise((resolve, reject) => {
    doc.on('data', chunk => buffers.push(chunk))
    doc.on('end', () => {
      writeFileSync(filePath, Buffer.concat(buffers))
      resolve()
    })
    doc.on('error', reject)

    const { title, content } = input

    // Title
    if (title) {
      doc.fontSize(20).text(title, { align: 'center' })
      doc.moveDown(1.5)
    }

    // Content blocks
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue

        if (block.type === 'heading' || block.type === 'h1') {
          doc.moveDown(0.5)
          doc.fontSize(16).text(block.text || '', { continued: false })
          doc.moveDown(0.5)
        } else if (block.type === 'h2') {
          doc.moveDown(0.3)
          doc.fontSize(14).text(block.text || '', { continued: false })
          doc.moveDown(0.3)
        } else if (block.type === 'h3') {
          doc.fontSize(12).text(block.text || '', { continued: false })
          doc.moveDown(0.2)
        } else if (block.type === 'paragraph' || block.type === 'text') {
          doc.fontSize(10).text(block.text || '', { align: 'justify' })
          doc.moveDown(0.5)
        } else if (block.type === 'table') {
          drawTable(doc, block)
          doc.moveDown(0.5)
        } else if (block.type === 'code') {
          doc.font('Courier').fontSize(8).text(block.text || '')
          doc.font('Helvetica')
          doc.moveDown(0.3)
        } else {
          // fallback: plain text
          doc.fontSize(10).text(block.text || String(block))
          doc.moveDown(0.3)
        }
      }
    } else if (typeof content === 'string') {
      doc.fontSize(10).text(content, { align: 'justify' })
    }

    doc.end()
  })
}

function drawTable(doc, block) {
  const rows = block.rows || []
  const headers = block.headers || []
  if (rows.length === 0 && headers.length === 0) return

  const allRows = headers.length > 0 ? [headers, ...rows] : rows
  const colCount = Math.max(...allRows.map(r => Array.isArray(r) ? r.length : 0), 1)
  const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / colCount
  const rowHeight = 18
  const fontSize = 9

  for (let ri = 0; ri < allRows.length; ri++) {
    const row = allRows[ri]
    const y = doc.y
    let maxH = rowHeight

    for (let ci = 0; ci < colCount; ci++) {
      const x = doc.page.margins.left + ci * colWidth
      const text = toCellText(Array.isArray(row) ? row[ci] : '')
      doc.fontSize(fontSize).text(text, x + 2, y + 2, {
        width: colWidth - 4,
        height: rowHeight - 4,
        ellipsis: true,
      })
    }

    // Draw cell borders
    doc.lineWidth(0.5)
    for (let ci = 0; ci <= colCount; ci++) {
      doc.moveTo(doc.page.margins.left + ci * colWidth, y)
        .lineTo(doc.page.margins.left + ci * colWidth, y + rowHeight)
        .stroke()
    }
    doc.moveTo(doc.page.margins.left, y + rowHeight)
      .lineTo(doc.page.margins.left + colCount * colWidth, y + rowHeight)
      .stroke()
    if (ri === 0) {
      doc.moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.margins.left + colCount * colWidth, y)
        .stroke()
    }

    doc.y = y + rowHeight
    if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
      doc.addPage()
    }
  }
}

// ── pdf_read ────────────────────────────────────────────────────

async function extractPdfText(filePath) {
  const pdfParse = (await import('pdf-parse')).default
  const buffer = readFileSync(filePath)
  const data = await pdfParse(buffer)
  return data.text
}

// ── Tool definitions ────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'pdf_create',
      description: 'Generate a real PDF with text, headings, and tables. Content is an array of blocks: {type:"heading"|"paragraph"|"table"|"code", text?, headers?, rows?}',
      input_schema: {
        type: 'object',
        properties: {
          destination_path: { type: 'string', description: 'Output .pdf file path' },
          title: { type: 'string', description: 'Document title' },
          content: {
            description: 'Content blocks array: [{type, text?, headers?, rows?}]',
          },
        },
        required: ['destination_path', 'content'],
      },
    },
    execute: async (params) => {
      const dest = params.destination_path
      if (!dest) return { content: 'Error: destination_path is required', isError: true }

      try {
        await generatePdf(dest, { title: params.title, content: params.content })
        const name = basename(dest)
        return {
          content: artifactHint(dest, `Generated "${name}"`),
          rawPath: dest,
        }
      } catch (err) {
        return { content: `PDF generation failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'pdf_read',
      description: 'Extract text content from a PDF file for reading into context.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .pdf file to read' },
        },
        required: ['file_path'],
      },
    },
    execute: async (params) => {
      const fp = params.file_path
      if (!fp) return { content: 'Error: file_path is required', isError: true }
      if (!existsSync(fp)) return { content: `Error: file not found: ${fp}`, isError: true }

      try {
        const text = await extractPdfText(fp)
        if (!text || text.trim().length === 0) {
          return { content: 'PDF appears to contain no extractable text (scanned image?).' }
        }
        const truncated = text.length > 8000
          ? text.slice(0, 8000) + `\n\n... (truncated, ${text.length - 8000} more chars. Use read_file to inspect the full text.)`
          : text
        return { content: truncated }
      } catch (err) {
        return { content: `PDF read failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
