// Client-side image compression — runs once before send. The single compressed
// data URL feeds three consumers: the vision model (OpenAI image_url part), the
// message-stream thumbnail, and on-disk artifact storage. Compressing here keeps
// events.jsonl small and guarantees a provider-supported output format (PNG/JPEG),
// transcoding away formats the model can't consume (e.g. BMP).

/** Provider-supported output formats (OpenAI ∩ Anthropic = png/jpeg/webp/gif). */
export const OUTPUT_PNG = 'image/png'
export const OUTPUT_JPEG = 'image/jpeg'

/** Long-edge clamp. 1568px keeps OpenAI tile cost bounded while staying legible. */
export const MAX_EDGE = 1568
/** JPEG quality for opaque sources. */
export const JPEG_QUALITY = 0.82

export interface CompressedImage {
  dataUrl: string
  mime: string
  width: number
  height: number
}

/**
 * Compute target dimensions that fit within `maxEdge` on the long side while
 * preserving aspect ratio. Never upscales. Pure — exported for unit testing.
 */
export function computeTargetDimensions(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const longEdge = Math.max(width, height)
  if (longEdge <= maxEdge) return { width, height }
  const scale = maxEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to decode image'))
    img.src = src
  })
}

/**
 * Downscale `img` to `target` using step-down halving for large reductions
 * (preserves sharpness vs a single big drawImage). Returns the final canvas.
 */
function drawDownscaled(
  img: HTMLImageElement,
  target: { width: number; height: number },
): HTMLCanvasElement {
  let curW = img.naturalWidth || img.width
  let curH = img.naturalHeight || img.height
  let canvas = document.createElement('canvas')
  canvas.width = curW
  canvas.height = curH
  let ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0)

  // Halve until within 2× of the target, then do the final exact resize.
  while (curW > target.width * 2 && curH > target.height * 2) {
    const nextW = Math.max(target.width, Math.round(curW / 2))
    const nextH = Math.max(target.height, Math.round(curH / 2))
    const next = document.createElement('canvas')
    next.width = nextW
    next.height = nextH
    const nctx = next.getContext('2d')!
    nctx.imageSmoothingEnabled = true
    nctx.imageSmoothingQuality = 'high'
    nctx.drawImage(canvas, 0, 0, nextW, nextH)
    canvas = next
    ctx = nctx
    curW = nextW
    curH = nextH
  }

  if (curW !== target.width || curH !== target.height) {
    const final = document.createElement('canvas')
    final.width = target.width
    final.height = target.height
    const fctx = final.getContext('2d')!
    fctx.imageSmoothingEnabled = true
    fctx.imageSmoothingQuality = 'high'
    fctx.drawImage(canvas, 0, 0, target.width, target.height)
    return final
  }
  return canvas
}

/**
 * Compress a file to a provider-safe data URL by rasterizing through a canvas.
 * PNG sources keep transparency (PNG output); everything else becomes JPEG.
 * Rejects if the file cannot be decoded — callers surface a retry error rather
 * than forwarding an unsupported original.
 */
export async function compressImage(
  file: File,
  maxEdge: number = MAX_EDGE,
): Promise<CompressedImage> {
  const src = await readFileAsDataURL(file)
  const img = await loadImage(src)
  const natW = img.naturalWidth || img.width
  const natH = img.naturalHeight || img.height
  if (natW <= 0 || natH <= 0) throw new Error('Image has zero dimensions')
  const target = computeTargetDimensions(natW, natH, maxEdge)
  const canvas = drawDownscaled(img, target)
  // PNG sources may carry alpha; preserve it. Otherwise JPEG for size.
  const keepPng = file.type === OUTPUT_PNG
  const mime = keepPng ? OUTPUT_PNG : OUTPUT_JPEG
  const dataUrl = keepPng
    ? canvas.toDataURL(OUTPUT_PNG)
    : canvas.toDataURL(OUTPUT_JPEG, JPEG_QUALITY)
  return { dataUrl, mime, width: canvas.width, height: canvas.height }
}
