import { extname } from 'path'
import type { Tool } from './types.js'
import { exportFile } from './export-file.js'

export type ImageFormat = 'svg'

export interface CreateImageInput {
  destination_path?: string
  svg?: string
  width?: number
  height?: number
}

function inferImageFormat(destinationPath: string): ImageFormat {
  const ext = extname(destinationPath).toLowerCase()
  if (ext === '.svg') return 'svg'
  return 'svg'
}

function extractSvgInner(raw: string): string {
  const stripped = raw.trim()
  // If already a full <svg>...</svg> document, return as-is
  if (/^<svg\b/i.test(stripped)) return stripped
  // If wrapped in markdown code fence, strip it
  const fenceMatch = stripped.match(/```(?:svg)?\r?\n([\s\S]*?)\r?\n```/)
  if (fenceMatch?.[1]) return fenceMatch[1].trim()
  return stripped
}

function wrapSvg(inner: string, width?: number, height?: number): string {
  let attrs = 'xmlns="http://www.w3.org/2000/svg"'
  if (width !== undefined) attrs += ` width="${width}"`
  if (height !== undefined) attrs += ` height="${height}"`
  if (width !== undefined && height !== undefined) {
    attrs += ` viewBox="0 0 ${width} ${height}"`
  }
  return `<svg ${attrs}>\n${inner}\n</svg>\n`
}

export function renderImage(input: CreateImageInput): { content: string; format: ImageFormat } {
  const raw = input.svg ?? ''
  if (raw.trim().length === 0) throw new Error('svg content is required')
  const inner = extractSvgInner(raw)
  const svg = /^<svg\b/i.test(inner) ? inner + '\n' : wrapSvg(inner, input.width, input.height)
  return { format: 'svg', content: svg }
}

export async function createImage(input: CreateImageInput): Promise<{ path: string; bytes: number; format: ImageFormat }> {
  if (typeof input.destination_path !== 'string' || input.destination_path.trim().length === 0) {
    throw new Error('destination_path is required')
  }
  if (typeof input.svg !== 'string' || input.svg.trim().length === 0) {
    throw new Error('svg is required')
  }
  const rendered = renderImage(input)
  const exported = await exportFile({ destination_path: input.destination_path, content: rendered.content })
  return { path: exported.path, bytes: exported.bytes, format: rendered.format }
}

export const CREATE_IMAGE_TOOL: Tool = {
  definition: {
    name: 'create_image',
    description: `Create an SVG image file from SVG markup.

The SVG content can be a full <svg>...</svg> document, raw SVG inner elements, or a markdown code fence. Use this for logos, diagrams, charts, illustrations, and any vector graphics.

Use open_path to open the generated image in the OS default viewer.

Examples:
Good: create_image(destination_path="~/Desktop/logo.svg", svg="<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 100 100\\"><circle cx=\\"50\\" cy=\\"50\\" r=\\"40\\" fill=\\"#38bdf8\\"/></svg>")
Good: create_image(destination_path="~/Desktop/chart.svg", svg="<rect x=\\"10\\" y=\\"20\\" width=\\"30\\" height=\\"40\\" fill=\\"#818cf8\\"/>", width=200, height=120)`,
    input_schema: {
      type: 'object',
      properties: {
        destination_path: { type: 'string', description: 'Destination file path. Should end with .svg. May be outside the project.' },
        svg: { type: 'string', description: 'SVG markup — either a full <svg> document, inner SVG elements, or a markdown code fence.' },
        width: { type: 'number', description: 'Optional width attribute for the SVG element.' },
        height: { type: 'number', description: 'Optional height attribute for the SVG element.' },
      },
      required: ['destination_path', 'svg'],
    },
  },

  async execute(params) {
    try {
      const result = await createImage(params.input as CreateImageInput)
      return { content: `Created ${result.format} image (${result.bytes} bytes): ${result.path}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${msg}`, isError: true }
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
