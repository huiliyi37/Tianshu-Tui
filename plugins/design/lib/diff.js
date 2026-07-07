import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

/**
 * @param {Buffer} referencePng
 * @param {Buffer} actualPng
 * @param {{ threshold?: number }} [opts]
 */
export function comparePngBuffers(referencePng, actualPng, opts = {}) {
  const a = PNG.sync.read(referencePng)
  const b = PNG.sync.read(actualPng)
  if (a.width !== b.width || a.height !== b.height) {
    return {
      ok: false,
      error: `Image size mismatch: reference ${a.width}x${a.height}, actual ${b.width}x${b.height}. Re-capture at the same viewport size.`,
    }
  }
  const diff = new PNG({ width: a.width, height: a.height })
  // includeAA stays default (false): anti-aliased edge pixels are detected
  // and excluded from the mismatch count — the report explicitly tells the
  // model AA differences are normal, so they must not inflate the score.
  const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: opts.threshold ?? 0.1,
  })
  const total = a.width * a.height
  const mismatchPercent = Math.round((mismatched / total) * 10000) / 100
  return {
    ok: true,
    mismatchPercent,
    mismatchedPixels: mismatched,
    totalPixels: total,
    width: a.width,
    height: a.height,
    diffPng: PNG.sync.write(diff),
  }
}

/** @param {string} referencePath @param {string} actualPath */
export function compareImageFiles(referencePath, actualPath) {
  return comparePngBuffers(readFileSync(referencePath), readFileSync(actualPath))
}
