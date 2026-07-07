import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'

/**
 * Median-cut color quantization (pure JS, no native deps).
 * @param {Buffer} pngBuffer
 * @param {number} maxColors
 */
export function extractPaletteFromPng(pngBuffer, maxColors = 8) {
  const png = PNG.sync.read(pngBuffer)
  /** @type {number[][]} */
  const pixels = []
  const step = Math.max(1, Math.floor((png.width * png.height) / 20_000))
  for (let i = 0; i < png.data.length; i += 4 * step) {
    const a = png.data[i + 3]
    if (a === undefined || a < 128) continue
    pixels.push([png.data[i], png.data[i + 1], png.data[i + 2]])
  }
  if (pixels.length === 0) {
    return { colors: [], cssVariables: '', tailwindSnippet: '' }
  }

  const buckets = [pixels]
  while (buckets.length < maxColors) {
    buckets.sort((a, b) => rangeSize(b) - rangeSize(a))
    const largest = buckets.shift()
    if (!largest || largest.length < 2) {
      if (largest) buckets.push(largest)
      break
    }
    const [left, right] = splitBucket(largest)
    buckets.push(left, right)
  }

  const total = pixels.length
  const rawColors = buckets.map(bucket => {
    const n = bucket.length
    const r = Math.round(bucket.reduce((s, p) => s + p[0], 0) / n)
    const g = Math.round(bucket.reduce((s, p) => s + p[1], 0) / n)
    const b = Math.round(bucket.reduce((s, p) => s + p[2], 0) / n)
    const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
    return { hex, r, g, b, percent: (n / total) * 100 }
  })

  // Median-cut on low-variance images produces N buckets that average to the
  // SAME color (a solid red image yields 4× #c82828 at 25% each) — merge by
  // hex so the palette reports distinct colors with combined coverage.
  const merged = new Map()
  for (const c of rawColors) {
    const prev = merged.get(c.hex)
    if (prev) prev.percent += c.percent
    else merged.set(c.hex, c)
  }
  const colors = [...merged.values()]
    .map(c => ({ ...c, percent: Math.round(c.percent * 10) / 10 }))
    .sort((a, b) => b.percent - a.percent)

  const cssVariables = colors.map((c, i) => `  --color-brand-${i + 1}: ${c.hex};`).join('\n')
  const tailwindSnippet = colors.map((c, i) => `'brand-${i + 1}': '${c.hex}',`).join('\n        ')

  return {
    colors,
    cssVariables: `:root {\n${cssVariables}\n}`,
    tailwindSnippet: `colors: {\n        ${tailwindSnippet}\n      }`,
  }
}

/** @param {string} filePath @param {number} [maxColors] */
export function extractPaletteFromFile(filePath, maxColors = 8) {
  return extractPaletteFromPng(readFileSync(filePath), maxColors)
}

/** @param {number[][]} bucket */
function rangeSize(bucket) {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
  for (const [r, g, b] of bucket) {
    if (r < minR) minR = r
    if (r > maxR) maxR = r
    if (g < minG) minG = g
    if (g > maxG) maxG = g
    if (b < minB) minB = b
    if (b > maxB) maxB = b
  }
  return Math.max(maxR - minR, maxG - minG, maxB - minB)
}

/** @param {number[][]} bucket */
function splitBucket(bucket) {
  let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
  for (const [r, g, b] of bucket) {
    if (r < minR) minR = r
    if (r > maxR) maxR = r
    if (g < minG) minG = g
    if (g > maxG) maxG = g
    if (b < minB) minB = b
    if (b > maxB) maxB = b
  }
  const spanR = maxR - minR
  const spanG = maxG - minG
  const spanB = maxB - minB
  let channel = 0
  if (spanG >= spanR && spanG >= spanB) channel = 1
  else if (spanB >= spanR && spanB >= spanG) channel = 2

  bucket.sort((a, b) => a[channel] - b[channel])
  const mid = Math.floor(bucket.length / 2)
  return [bucket.slice(0, mid), bucket.slice(mid)]
}
