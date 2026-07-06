// office-ppt: Native .pptx generation via pptxgenjs
// Replaces the HTML .ppt fallback (create_presentation).

import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

// ── Helpers ──────────────────────────────────────────────────────

function artifactHint(filePath, summary) {
  return [
    `📊 PPTX: ${summary}`,
    `   File: ${filePath}`,
    `   Use open_path to view in PowerPoint/Keynote.`,
  ].join('\n')
}

// ── Slide builders ──────────────────────────────────────────────

/**
 * @param {import('pptxgenjs')} pptx
 * @param {object} slideDef
 */
function addSlide(pptx, slideDef) {
  const slide = pptx.addSlide()
  const { type, title, body, items, image, layout } = slideDef

  if (type === 'title') {
    // Title slide
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 1.5, w: '90%', h: 1.5,
        fontSize: 36, bold: true, align: 'center', color: '1F2937',
      })
    }
    if (body) {
      slide.addText(body, {
        x: 1, y: 3.2, w: '80%', h: 1,
        fontSize: 18, align: 'center', color: '6B7280',
      })
    }
  } else if (type === 'section') {
    // Section divider
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 2, w: '90%', h: 1.5,
        fontSize: 28, bold: true, align: 'center', color: '1F2937',
      })
    }
  } else if (type === 'content' || !type) {
    // Content slide: title + bullet points
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 24, bold: true, color: '1F2937',
      })
    }
    if (body) {
      slide.addText(body, {
        x: 0.7, y: 1.5, w: '85%', h: 4,
        fontSize: 14, color: '374151', bullet: !!items,
      })
    }
    if (Array.isArray(items) && items.length > 0) {
      const listItems = items.map(i => ({ text: String(i), options: { fontSize: 14, bullet: true, color: '374151' } }))
      slide.addText(listItems, {
        x: 0.7, y: 1.5, w: '85%', h: 4,
      })
    }
  } else if (type === 'two-column') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 24, bold: true, color: '1F2937',
      })
    }
    // Left column
    slide.addText(body || '', {
      x: 0.5, y: 1.5, w: 4.2, h: 4,
      fontSize: 12, color: '374151',
    })
    // Right column
    if (items) {
      slide.addText(Array.isArray(items) ? items.map(i => ({ text: String(i), options: { fontSize: 12, bullet: true } })) : [{ text: String(items), options: { fontSize: 12 } }], {
        x: 5.2, y: 1.5, w: 4.2, h: 4,
      })
    }
  } else if (type === 'image') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 24, bold: true, color: '1F2937',
      })
    }
    if (image) {
      slide.addImage({ path: image, x: 1, y: 1.5, w: 8, h: 4.5 })
    }
  } else if (type === 'table') {
    if (title) {
      slide.addText(title, {
        x: 0.5, y: 0.4, w: '90%', h: 0.8,
        fontSize: 24, bold: true, color: '1F2937',
      })
    }
    if (slideDef.headers && slideDef.rows) {
      const rows = [slideDef.headers.map(h => ({ text: String(h), options: { bold: true, fill: 'E5E7EB' } }))]
      for (const row of slideDef.rows) {
        rows.push(row.map(cell => ({ text: String(cell ?? '') })))
      }
      slide.addTable(rows, {
        x: 0.5, y: 1.5, w: '90%',
        border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
        colW: Array(slideDef.headers.length).fill(9 / slideDef.headers.length),
      })
    }
  }
}

// ── Tool definition ─────────────────────────────────────────────

export const tools = [
  {
    definition: {
      name: 'pptx_create',
      description: 'Generate a real .pptx file from slide definitions. Slides: [{type:"title"|"section"|"content"|"two-column"|"image"|"table", title?, body?, items?, image?, headers?, rows?}]',
      input_schema: {
        type: 'object',
        properties: {
          destination_path: { type: 'string', description: 'Output .pptx file path' },
          title: { type: 'string', description: 'Presentation title (used on first slide if no explicit title slide)' },
          slides: {
            type: 'array',
            description: 'Slide definitions array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['title', 'section', 'content', 'two-column', 'image', 'table'] },
                title: { type: 'string' },
                body: { type: 'string' },
                items: { type: 'array', items: { type: 'string' } },
                image: { type: 'string', description: 'Path to image file' },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
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

        pptx.layout = 'LAYOUT_WIDE'
        pptx.author = 'Tianshu'
        pptx.title = params.title || 'Presentation'

        const slides = params.slides || []
        for (const slideDef of slides) {
          addSlide(pptx, slideDef)
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
]
