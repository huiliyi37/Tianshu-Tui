// office-ppt: Native .pptx generation via pptxgenjs
// Replaces the HTML .ppt fallback (create_presentation).

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'

// Reject oversized decks before JSZip loads the whole archive into memory.
const MAX_PPTX_SIZE = 100 * 1024 * 1024 // 100MiB

// ── Helpers ──────────────────────────────────────────────────────

function artifactHint(filePath, summary) {
  return [
    `📊 PPTX: ${summary}`,
    `   File: ${filePath}`,
    `   Use open_path to view in PowerPoint/Keynote.`,
  ].join('\n')
}

/** pptxgenjs wants bare hex (no leading '#'). */
function hex(value) {
  return String(value).replace(/^#/, '').toUpperCase()
}

// Default theme preserves the original hardcoded appearance.
const DEFAULT_THEME = {
  titleColor: '1F2937',
  textColor: '374151',
  bgColor: 'FFFFFF',
  accentColor: '6B7280',
  fontFace: undefined,
}

function resolveTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) }
  return {
    titleColor: hex(t.titleColor),
    textColor: hex(t.textColor),
    bgColor: hex(t.bgColor),
    accentColor: hex(t.accentColor),
    fontFace: t.fontFace ? String(t.fontFace) : undefined,
  }
}

// ── Text extraction helpers (pptx_read) ─────────────────────────

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

// Per-slide XML cap: regex backtracking on pathological (unclosed-tag)
// input scales ~k×n — a crafted deck could pin the event loop for minutes.
const MAX_SLIDE_XML_SIZE = 50 * 1024 * 1024 // 50MiB per slide XML

/** Join <a:t> runs within each <a:p> paragraph; drop empty paragraphs. */
function extractParagraphs(xml) {
  if (xml.length > MAX_SLIDE_XML_SIZE) {
    return ['[slide content too large to parse]']
  }
  const paragraphs = []
  const pRe = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  let m
  while ((m = pRe.exec(xml)) !== null) {
    const runs = []
    const tRe = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g
    let t
    while ((t = tRe.exec(m[1])) !== null) runs.push(unescapeXml(t[1]))
    const text = runs.join('').trim()
    if (text) paragraphs.push(text)
  }
  return paragraphs
}

function slideNumber(name) {
  return Number(name?.match(/slide(\d+)\.xml$/)?.[1] ?? NaN)
}

/** Resolve the notes part for a slide via its .rels, falling back to same-numbered notesSlide. */
async function findNotesPart(zip, num) {
  const relsFile = zip.file(`ppt/slides/_rels/slide${num}.xml.rels`)
  if (relsFile) {
    const rels = await relsFile.async('string')
    const m = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)
    if (m) return `ppt/notesSlides/${m[1]}`
  }
  const fallback = `ppt/notesSlides/notesSlide${num}.xml`
  return zip.file(fallback) ? fallback : null
}

// ── Slide builders ──────────────────────────────────────────────

/**
 * @param {import('pptxgenjs')} pptx
 * @param {object} slideDef
 * @param {ReturnType<typeof resolveTheme>} theme
 */
function addSlide(pptx, slideDef, theme) {
  const slide = pptx.addSlide()
  slide.background = { color: theme.bgColor }
  const { type, title, body, items, image, layout } = slideDef
  const font = { fontFace: theme.fontFace }

  // Speaker notes (supported on every slide type)
  if (slideDef.notes) slide.addNotes(String(slideDef.notes))

  if (type === 'title') {
    // Title slide
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 1.5, w: '90%', h: 1.5,
        fontSize: 40, bold: true, align: 'center', color: theme.titleColor, ...font,
      })
    }
    if (body) {
      slide.addText(body, {
        x: 1, y: 3.2, w: '80%', h: 1,
        fontSize: 18, align: 'center', color: theme.accentColor, ...font,
      })
    }
  } else if (type === 'section') {
    // Section divider
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 2, w: '90%', h: 1.5,
        fontSize: 36, bold: true, align: 'center', color: theme.titleColor, ...font,
      })
    }
  } else if (type === 'content' || !type) {
    // Content slide: title + bullet points
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 36, bold: true, color: theme.titleColor, ...font,
      })
    }
    if (body) {
      slide.addText(body, {
        x: 0.7, y: 1.5, w: '85%', h: 4,
        fontSize: 14, color: theme.textColor, bullet: !!items, ...font,
      })
    }
    if (Array.isArray(items) && items.length > 0) {
      const listItems = items.map(i => ({ text: String(i), options: { fontSize: 14, bullet: true, color: theme.textColor, ...font } }))
      slide.addText(listItems, {
        x: 0.7, y: 1.5, w: '85%', h: 4,
      })
    }
  } else if (type === 'two-column') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 36, bold: true, color: theme.titleColor, ...font,
      })
    }
    // Left column
    slide.addText(body || '', {
      x: 0.5, y: 1.5, w: 4.2, h: 4,
      fontSize: 12, color: theme.textColor, ...font,
    })
    // Right column
    if (items) {
      slide.addText(Array.isArray(items) ? items.map(i => ({ text: String(i), options: { fontSize: 12, bullet: true, color: theme.textColor, ...font } })) : [{ text: String(items), options: { fontSize: 12, color: theme.textColor, ...font } }], {
        x: 5.2, y: 1.5, w: 4.2, h: 4,
      })
    }
  } else if (type === 'image') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 36, bold: true, color: theme.titleColor, ...font,
      })
    }
    if (image) {
      slide.addImage({ path: image, x: 1, y: 1.5, w: 8, h: 4.5 })
    }
  } else if (type === 'table') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 36, bold: true, color: theme.titleColor, ...font,
      })
    }
    if (slideDef.headers && slideDef.rows) {
      const rows = [slideDef.headers.map(h => ({ text: String(h), options: { bold: true, fill: 'E5E7EB', color: theme.titleColor, ...font } }))]
      for (const row of slideDef.rows) {
        rows.push(row.map(cell => ({ text: String(cell ?? ''), options: { color: theme.textColor, ...font } })))
      }
      slide.addTable(rows, {
        x: 0.5, y: 1.5, w: '90%',
        border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
        colW: Array(slideDef.headers.length).fill(9 / slideDef.headers.length),
      })
    }
  } else if (type === 'chart') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 36, bold: true, color: theme.titleColor, ...font,
      })
    }
    const chartType = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, pie: pptx.ChartType.pie }[slideDef.chart] || pptx.ChartType.bar
    const data = (Array.isArray(slideDef.data) ? slideDef.data : []).map(s => ({
      name: String(s?.name ?? ''),
      labels: (Array.isArray(s?.labels) ? s.labels : []).map(String),
      values: (Array.isArray(s?.values) ? s.values : []).map(Number),
    })).filter(s => s.values.length > 0)
    if (data.length > 0) {
      slide.addChart(chartType, data, {
        x: 0.5, y: 1.5, w: 9, h: 5,
        showLegend: data.length > 1,
        chartColors: [theme.accentColor, theme.titleColor, theme.textColor],
      })
    }
  }
}

// ── Tool definitions ────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'pptx_create',
      description: 'Generate a real .pptx file from slide definitions. Slides: [{type:"title"|"section"|"content"|"two-column"|"image"|"table"|"chart", title?, body?, items?, image?, headers?, rows?, chart?, data?, notes?}]. Optional theme: {titleColor, textColor, bgColor, accentColor, fontFace}.',
      input_schema: {
        type: 'object',
        properties: {
          destination_path: { type: 'string', description: 'Output .pptx file path' },
          title: { type: 'string', description: 'Presentation title (used on first slide if no explicit title slide)' },
          theme: {
            type: 'object',
            description: 'Optional visual theme. Colors are hex with or without #. Defaults preserve the built-in look.',
            properties: {
              titleColor: { type: 'string', description: 'Title text color (default 1F2937)' },
              textColor: { type: 'string', description: 'Body text color (default 374151)' },
              bgColor: { type: 'string', description: 'Slide background color (default FFFFFF)' },
              accentColor: { type: 'string', description: 'Muted/subtitle + chart accent color (default 6B7280)' },
              fontFace: { type: 'string', description: 'Font family for all text (e.g. "Microsoft YaHei")' },
            },
          },
          slides: {
            type: 'array',
            description: 'Slide definitions array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['title', 'section', 'content', 'two-column', 'image', 'table', 'chart'] },
                title: { type: 'string' },
                body: { type: 'string' },
                items: { type: 'array', items: { type: 'string' } },
                image: { type: 'string', description: 'Path to image file' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
                notes: { type: 'string', description: 'Speaker notes for this slide' },
                chart: { type: 'string', enum: ['bar', 'line', 'pie'], description: 'Chart kind (type=chart)' },
                data: {
                  type: 'array',
                  description: 'Chart series (type=chart): [{name, labels: [...], values: [...]}]',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      labels: { type: 'array' },
                      values: { type: 'array', items: { type: 'number' } },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['destination_path', 'slides'],
      },
    },
    execute: async (params) => {
      const dest = params.destination_path
      if (!dest) return { content: 'Error: destination_path is required', isError: true }

      try {
        const PptxGenJS = (await import('pptxgenjs')).default
        const pptx = new PptxGenJS()
        const theme = resolveTheme(params.theme)

        pptx.layout = 'LAYOUT_WIDE'
        pptx.author = 'Tianshu'
        pptx.title = params.title || 'Presentation'

        const slides = params.slides || []
        for (const slideDef of slides) {
          addSlide(pptx, slideDef, theme)
        }

        await pptx.writeFile({ fileName: dest })
        const name = basename(dest)
        return {
          content: artifactHint(dest, `Generated "${name}" with ${slides.length} slide(s)`),
          rawPath: dest,
        }
      } catch (err) {
        return { content: `PPTX generation failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
  {
    definition: {
      name: 'pptx_read',
      description: 'Extract text from a .pptx file as markdown (## Slide N + paragraphs). Optionally includes speaker notes. Use it to review generated decks for completeness or leftover placeholders.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the .pptx file' },
          include_notes: { type: 'boolean', description: 'Also extract speaker notes (default false)' },
        },
        required: ['file_path'],
      },
    },
    execute: async (params) => {
      const filePath = params.file_path
      if (!filePath) return { content: 'Error: file_path is required', isError: true }
      if (!existsSync(filePath)) return { content: `Error: file not found: ${filePath}`, isError: true }

      try {
        const stat = statSync(filePath)
        if (stat.size > MAX_PPTX_SIZE) {
          return { content: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 100MB limit)`, isError: true }
        }
        const JSZip = (await import('jszip')).default
        const zip = await JSZip.loadAsync(readFileSync(filePath))

        const slideNames = Object.keys(zip.files)
          .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
          .sort((a, b) => slideNumber(a) - slideNumber(b))
        if (slideNames.length === 0) {
          return { content: `Error: no slides found in ${filePath} (not a valid .pptx?)`, isError: true }
        }

        const includeNotes = params.include_notes === true
        const out = [`# ${basename(filePath)}`, '']
        for (let i = 0; i < slideNames.length; i++) {
          const num = slideNumber(slideNames[i])
          const xml = await zip.file(slideNames[i]).async('string')
          const paragraphs = extractParagraphs(xml)
          out.push(`## Slide ${i + 1}`)
          out.push(paragraphs.length > 0 ? paragraphs.join('\n\n') : '(no text)')
          if (includeNotes) {
            const notesPart = await findNotesPart(zip, num)
            if (notesPart) {
              const notes = extractParagraphs(await zip.file(notesPart).async('string'))
              if (notes.length > 0) out.push('', '**Speaker notes:**', notes.join('\n\n'))
            }
          }
          out.push('')
        }

        return { content: out.join('\n'), rawPath: filePath }
      } catch (err) {
        return { content: `PPTX read failed: ${err.message}`, isError: true }
      }
    },
    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  },
]
